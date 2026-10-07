#!/usr/bin/env python3
"""One monitor for one Slurm training run: state transitions, progress, eval trend, jank.

Read-only and stdlib-only. It submits nothing and evaluates nothing: the train job owns its own
held-out eval, this just reports what the job already published. A snapshot of the previous tick
lets it report PENDING -> RUNNING -> COMPLETED/FAILED as transitions instead of restating the
obvious, and it does the numeric work (percent complete, ETA, loss trend, throughput regression)
that an agent skimming a log does inconsistently.

Everything it reads is already in nanoGPT's stdout and the run dir:
  iter 3500: loss 3.4012, time 98.71ms, mfu 41.20%     <- progress, throughput
  step 3000: train loss 3.39, val loss 3.28            <- the job's own held-out eval
  Overriding: max_iters = 10000                        <- percent complete and ETA
  Initializing a new model from scratch / Resuming…    <- start / restart
"""

import argparse
import json
import math
import re
import statistics as stats
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

LAYOUT_HELP = """\
Expected layout under --train-root, which is the nanoGPT + Slurm convention the
parsers assume:

  <train-root>/<jobid>-<run-name>/            run dir, holding ckpt_<iter>.pt
  <train-root>/<run-name>/                    also accepted, but pass --job-id
  <train-root>/slurm-<run-name>-<jobid>.out   the log that gets parsed

The Slurm job id is read from the leading digits of the run dir name. If your
directories are named some other way, pass --job-id explicitly and the name is
never parsed.

Log lines that are parsed, all of them nanoGPT stdout (or the slurm harness):

  iter 3500: loss 3.4012, time 98.71ms, mfu 41.20%   progress and throughput
  step 3000: train loss 3.39, val loss 3.28          the job's own held-out eval
  Overriding: max_iters = 10000                      percent complete and ETA
  Initializing a new model from scratch              start (nanoGPT)
  Resuming training from ...                         start (nanoGPT resume)
  starting with init_from=...                        start (slurm test harness)

Anything else in the log reaches the report only through the raw tail.
"""

LIVE = {"PENDING", "RUNNING", "COMPLETING", "CONFIGURING", "REQUEUED", "RESIZING", "SUSPENDED"}
# Matches only what float() accepts, including the nan/inf nanoGPT prints once training
# has diverged, so every captured token can go straight through float().
_NUM = r"(nan|-?inf|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)"
ITER_RE = re.compile(rf"iter (\d+): loss {_NUM}, time {_NUM}ms, mfu {_NUM}%")
EVAL_RE = re.compile(rf"step (\d+): train loss {_NUM}, val loss {_NUM}")
MAXIT_RE = re.compile(r"max_iters = (\d+)")
SRUN_NODE_RE = re.compile(r"srun: error: ([^:]+): task")
ERROR_PATS = (
    "CUDA out of memory",
    "torch.OutOfMemoryError",
    "Traceback (most recent call last)",
    "NCCL error",
    "NCCL WARN",
    "caught collective operation timeout",
    "uncorrectable ECC error",
    "Xid",
    "Segmentation fault",
    "slurmstepd: error",
    "oom_kill event",
    "srun: error",
    "srun: Job step aborted",
    "DUE TO TIME LIMIT",
    "DUE TO NODE FAILURE",
    "DUE TO PREEMPTION",
)
BAD_NODE_STATES = ("down", "drain", "drng", "fail", "maint", "unk", "err")


@dataclass(frozen=True)
class Config:
    """Everything the watcher needs to find and judge one run."""

    run: str
    train_root: Path
    watch_dir: Path
    job_id: Optional[str]
    ckpt_interval: int
    target_val: float
    max_iters: Optional[int]
    log_tail_lines: int
    log_scan_lines: int

    def snapshot_path(self, job_id: Optional[str] = None) -> Path:
        """Key the previous-tick file on run + job so a relaunch is a fresh series.

        `--job-id` on the config is only the CLI override; callers pass the
        inferred id after `train_job_id`. A same-name job with a new Slurm id
        must not inherit the old iter/start counts.
        """
        ident = job_id if job_id is not None else self.job_id
        name = f"{self.run}_{ident}_monitor.json" if ident else f"{self.run}_monitor.json"
        return self.watch_dir / name

    @property
    def snapshot(self) -> Path:
        return self.snapshot_path()


class _Formatter(argparse.ArgumentDefaultsHelpFormatter, argparse.RawDescriptionHelpFormatter):
    """Shows every default in --help without reflowing the layout notes."""


def parse_args(argv: Optional[List[str]] = None) -> Config:
    parser = argparse.ArgumentParser(
        description="Report one Slurm training run: state, progress, eval trend, and jank.",
        epilog=LAYOUT_HELP,
        formatter_class=_Formatter,
    )
    parser.add_argument("--run-name", default="nanogpt_owt_124m_r1", help="run being watched")
    parser.add_argument(
        "--train-root",
        type=Path,
        default=Path.home() / "train_logs",
        help="holds run dirs and logs",
    )
    parser.add_argument(
        "--watch-dir",
        type=Path,
        default=Path.home() / "nanogpt_watch",
        help="where the previous tick's snapshot is kept",
    )
    parser.add_argument(
        "--job-id", default=None, help="Slurm job id; inferred from the run dir name when omitted"
    )
    parser.add_argument(
        "--ckpt-interval",
        type=int,
        default=1000,
        help="iters between checkpoints, for the stale check",
    )
    parser.add_argument("--target-val", type=float, default=3.00, help="val loss we are aiming at")
    parser.add_argument(
        "--max-iters",
        type=int,
        default=None,
        help="total iters; a 'max_iters = N' line in the log wins over this",
    )
    parser.add_argument("--log-tail-lines", type=int, default=100, help="raw tail size, 0 to omit")
    parser.add_argument(
        "--log-scan-lines", type=int, default=5000, help="how far back to scan for error patterns"
    )
    args = parser.parse_args(argv)
    return Config(
        run=args.run_name,
        train_root=args.train_root,
        watch_dir=args.watch_dir,
        job_id=args.job_id,
        ckpt_interval=args.ckpt_interval,
        target_val=args.target_val,
        max_iters=args.max_iters,
        log_tail_lines=args.log_tail_lines,
        log_scan_lines=args.log_scan_lines,
    )


def _sh(cmd: List[str]) -> Optional[str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return None  # no Slurm on this box
    return r.stdout.strip() if r.returncode == 0 else None


def fmt_dur(seconds: float) -> str:
    s = max(int(seconds), 0)
    h, m = s // 3600, (s % 3600) // 60
    if h >= 24:
        return f"{h // 24}d {h % 24}h"
    return f"{h}h {m:02d}m" if h else f"{m}m"


def job_info(job_id: str) -> dict:
    """squeue for live jobs, sacct once they leave the queue. state None means 'cannot tell'."""
    live = _sh(["squeue", "-h", "-j", job_id, "-o", "%T|%M|%R|%N"])
    if live:
        state, elapsed, reason, nodes = (live.splitlines()[0].split("|") + ["", "", ""])[:4]
        state, reason, nodes = state.strip(), reason.strip(), nodes.strip()
        return {
            "state": state,
            "elapsed": elapsed.strip(),
            # %R is the pending reason while queued but the node list once running, so it is only
            # worth reporting when it says something the node list does not.
            "reason": "" if reason == nodes else reason,
            "nodes": nodes,
        }
    # sacct's Reason field is about why a job was blocked from starting, not why it died, so the
    # useful failure fields are the exit codes plus FailedNode. FailedNode is not a valid field
    # before Slurm 23.02, and one bad field makes sacct exit non-zero and report nothing at all,
    # so fall back to the portable subset rather than lose the terminal state entirely.
    base = "State,ExitCode,DerivedExitCode,Elapsed,NodeList"
    past = _sh(["sacct", "-n", "-X", "-P", "-j", job_id, "-o", base + ",FailedNode"])
    if past is None:
        past = _sh(["sacct", "-n", "-X", "-P", "-j", job_id, "-o", base])
    if past:
        cols = (past.splitlines()[0].split("|") + [""] * 6)[:6]
        state, exit_code, derived, elapsed, nodes, failed_node = cols
        return {
            "state": state.split()[0],  # strips the "CANCELLED by <uid>" tail
            "exit_code": exit_code,
            "derived_exit_code": derived,
            "elapsed": elapsed,
            "nodes": nodes.strip(),
            "failed_node": failed_node.strip(),
        }
    return {"state": None}


def node_issues(nodes: str) -> List[str]:
    """Ask Slurm whether the nodes this job is on are healthy. Catches the sick-node case where
    training limps or hangs but the job itself is still RUNNING."""
    if not nodes or nodes in {"None assigned", "(null)", "n/a"}:
        return []
    rows = _sh(["sinfo", "-h", "-N", "-n", nodes, "-o", "%n|%t|%E"])
    out = []
    for line in (rows or "").splitlines():
        name, state, reason = (line.split("|") + ["", ""])[:3]
        if state.strip().lower().rstrip("*~$").startswith(BAD_NODE_STATES):
            why = f" ({reason.strip()})" if reason.strip() else ""
            out.append(f"infra: node {name.strip()} is {state.strip()}{why}")
    return out


def run_dir(cfg: Config, job_id: Optional[str] = None) -> Optional[Path]:
    ident = job_id if job_id is not None else cfg.job_id
    if ident:
        named = cfg.train_root / f"{ident}-{cfg.run}"
        if named.is_dir():
            return named
        # Help still documents <train-root>/<run-name>/ when --job-id is passed.
        direct = cfg.train_root / cfg.run
        return direct if direct.is_dir() else None
    direct = cfg.train_root / cfg.run
    if direct.is_dir():
        return direct
    suffix = f"-{cfg.run}"
    hits = [path for path in cfg.train_root.glob(f"*-{cfg.run}") if path.name.endswith(suffix)]

    def prefix_id(path: Path) -> int:
        prefix = path.name[: -len(suffix)]
        return int(prefix) if prefix.isdigit() else -1

    hits.sort(key=prefix_id)
    return hits[-1] if hits else None


def train_job_id(cfg: Config, d: Optional[Path]) -> Optional[str]:
    """--job-id wins; otherwise read the leading digits off the <jobid>-<run> dir name."""
    if cfg.job_id:
        return cfg.job_id
    m = re.match(r"(\d+)-", d.name) if d else None
    return m.group(1) if m else None


def ckpts(d: Optional[Path]) -> List[int]:
    if not d:
        return []
    return sorted(
        int(p.stem.rsplit("_", 1)[-1])
        for p in d.glob("ckpt_*.pt")
        if p.stem.rsplit("_", 1)[-1].isdigit()
    )


def find_log(cfg: Config, job_id: Optional[str]) -> Optional[Path]:
    # With a job id, never fall through to slurm-{run}-*.out: that glob
    # matches an older run of the same name while this job is still queued.
    pats = [f"slurm-{cfg.run}-{job_id}.out"] if job_id else [f"slurm-{cfg.run}-*.out"]
    for pat in pats:
        hits = sorted(cfg.train_root.glob(pat), key=lambda p: p.stat().st_mtime)
        if hits:
            return hits[-1]
    return None


# nanoGPT prints the first two; the slurm test harness prints the third.
_START_MARKERS = (
    "Initializing a new model from scratch",
    "Resuming training from",
    "starting with init_from=",
)


def _count_starts(text: str) -> int:
    """One launch can print a harness line and a nanoGPT line. Count events, not formats."""
    nanogpt = text.count(_START_MARKERS[0]) + text.count(_START_MARKERS[1])
    harness = text.count(_START_MARKERS[2])
    return nanogpt or harness


def _scan_starts_and_max_iters(path: Path) -> tuple[int, Optional[int]]:
    """Count start markers and the last max_iters over the whole log.

    The 4MB tail used for iters/evals drops early-run lines. Restart detection
    and percent-complete both need those markers even after they scroll off.
    """
    text = path.read_bytes().decode("utf-8", "replace")
    found = MAXIT_RE.findall(text)
    return _count_starts(text), int(found[-1]) if found else None


def parse_log(cfg: Config, path: Optional[Path], tail: int = 4_000_000) -> dict:
    out: dict = {
        "iters": [],
        "evals": [],
        "starts": 0,
        "tail": [],
        "errors": [],
        "max_iters": cfg.max_iters,
    }
    if not path or not path.is_file():
        return out
    out["starts"], file_max = _scan_starts_and_max_iters(path)
    if file_max is not None:
        out["max_iters"] = file_max
    with path.open("rb") as fh:
        fh.seek(max(0, path.stat().st_size - tail))
        text = fh.read().decode("utf-8", "replace")
    out["iters"] = [
        (int(m[1]), float(m[2]), float(m[3]), float(m[4])) for m in ITER_RE.finditer(text)
    ]
    out["evals"] = [(int(m[1]), float(m[2]), float(m[3])) for m in EVAL_RE.finditer(text)]
    lines = text.splitlines()
    # Raw and unfiltered: a pattern list only catches failures someone already thought of, and the
    # tail exists for the one nobody anticipated. The scan below is the safety net for the opposite
    # case, an error old enough to have scrolled out of the tail.
    # lines[-0:] is the whole log, so zero has to mean zero explicitly
    out["tail"] = [ln.rstrip() for ln in lines[-cfg.log_tail_lines :]] if cfg.log_tail_lines else []
    scanned = lines[-cfg.log_scan_lines :]
    out["errors"] = [ln.strip() for ln in scanned if any(p in ln for p in ERROR_PATS)][-5:]
    return out


def status_line(cfg: Config, cur: dict, prev: dict, log: dict, med_ms: Optional[float]) -> str:
    """The one line the report copies verbatim, so it has to carry every number that answers
    "where is this heading": how far along, iters left, eta, and how far the eval still is from
    target. Always returns a line, even before the first iter is logged."""
    it, mx = cur["iter"], log["max_iters"]
    if it is None:
        return f"STATUS: no iters logged yet, {eval_summary(cfg, log)}"
    bits = [f"iter {it}" + (f"/{mx} ({it / mx:.1%})" if mx else "")]
    # prev["iter"] is null on ticks taken while the job was still queued, hence the "or 0"
    bits.append(f"+{it - (prev.get('iter') or 0)} since last tick" if prev else "first tick")
    if mx:
        bits.append(f"{mx - it} left")
    if mx and med_ms:
        bits.append(f"eta {fmt_dur((mx - it) * med_ms / 1000)} at {med_ms:.0f}ms/iter")
    bits.append(eval_summary(cfg, log))
    return "STATUS: " + ", ".join(bits)


def train_line(cur: dict, prev: dict) -> Optional[str]:
    if cur["loss_med20"] is None:
        return None
    was = prev.get("loss_med20")
    trend = f", was {was:.3f} last tick" if isinstance(was, (int, float)) else ""
    mfu = f", mfu {cur['mfu']:.1f}%" if cur["mfu"] is not None else ""
    return f"train loss {cur['loss_med20']:.3f} (median of last 20 iters{trend}){mfu}"


def eval_summary(cfg: Config, log: dict) -> str:
    """The train job's own held-out eval. This is the number to report, not the train loss."""
    evals = [(s, v) for s, _, v in log["evals"] if math.isfinite(v)]
    if not evals:
        return "no val loss logged yet"
    trend = " -> ".join(f"{v:.3f}@{s}" for s, v in evals[-3:])
    best_step, best = min(evals, key=lambda sv: sv[1])
    verdict = "MET" if best <= cfg.target_val else f"{best - cfg.target_val:.3f} away"
    return f"val {trend}, best {best:.3f}@{best_step}, target <={cfg.target_val:.2f} {verdict}"


def issues(
    cfg: Config, cur: dict, prev: dict, log: dict, cks: List[int], med_ms: Optional[float]
) -> List[str]:
    """Two kinds of trouble, labelled so the report can separate them: 'instability' is the model
    diverging, 'infra' is the cluster or a node letting us down."""
    found = []
    if cur["job"].get("state") == "RUNNING" and prev and cur["iter"] is not None:
        if cur["iter"] == prev.get("iter"):
            found.append(
                f"infra: no new iters since last tick, still at {cur['iter']} (possible hang)"
            )
    if cur["loss"] is not None and not math.isfinite(cur["loss"]):
        found.append("instability: loss is NaN or inf")

    losses = [l for _, l, _, _ in log["iters"] if math.isfinite(l)]
    if len(losses) >= 60:
        recent, before = stats.median(losses[-20:]), stats.median(losses[-60:-20])
        if recent > before + 0.15:
            found.append(
                f"instability: loss rising, median {recent:.3f} vs {before:.3f} over the prior 40 iters"
            )
    finite = [(s, v) for s, _, v in log["evals"] if math.isfinite(v)]
    if len(finite) >= 2 and finite[-1][1] > finite[-2][1] + 0.05:
        found.append(
            f"instability: val loss worsening at step {finite[-1][0]}: "
            f"{finite[-1][1]:.3f} from {finite[-2][1]:.3f}"
        )

    times = [ms for _, _, ms, _ in log["iters"]]
    if len(times) >= 60 and med_ms:
        overall = stats.median(times)
        if med_ms > overall * 1.25:
            found.append(
                f"infra: {med_ms / overall - 1:.0%} slower than run median "
                f"({med_ms:.0f}ms vs {overall:.0f}ms)"
            )
    found += node_issues(cur["job"].get("nodes", ""))
    if failed := cur["job"].get("failed_node"):
        found.append(f"infra: slurm blames node {failed} for killing the job")
    for node in dict.fromkeys(n for e in log["errors"] for n in SRUN_NODE_RE.findall(e)):
        found.append(f"infra: srun reported a task failure on {node}")
    if cur["iter"] is not None and cks and cur["iter"] - (cks[-1] + 2 * cfg.ckpt_interval) > 0:
        found.append(f"infra: no ckpt for {cur['iter'] - cks[-1]} iters (latest is {cks[-1]})")
    # Only a second start is a restart: ticks taken while the job was still queued snapshot zero
    # starts, and 0 -> 1 is just the job starting for the first time.
    if prev and prev.get("starts", 0) >= 1 and log["starts"] > prev["starts"]:
        found.append(f"infra: job restarted, now {log['starts']} starts (preempted or requeued)")
    found += [f"infra: log says {e}" for e in log["errors"]]
    return found


def main(argv: Optional[List[str]] = None) -> None:
    cfg = parse_args(argv)
    job_id = train_job_id(cfg, None)
    d = run_dir(cfg, job_id)
    if not job_id:
        job_id = train_job_id(cfg, d)
    snap = cfg.snapshot_path(job_id)
    prev = json.loads(snap.read_text()) if snap.is_file() else {}
    if prev.get("job", {}).get("id") and job_id and prev["job"]["id"] != job_id:
        prev = {}
    info = job_info(job_id) if job_id else {"state": None}
    log = parse_log(cfg, find_log(cfg, job_id))
    cks = ckpts(d)
    last = log["iters"][-1] if log["iters"] else None
    recent_times = [ms for _, _, ms, _ in log["iters"][-20:]]
    med_ms = stats.median(recent_times) if recent_times else None
    recent_losses = [l for _, l, _, _ in log["iters"][-20:] if math.isfinite(l)]

    cur = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "job": {"id": job_id, **info},
        "iter": last[0] if last else None,
        "loss": last[1] if last else None,
        "loss_med20": stats.median(recent_losses) if recent_losses else None,
        "ms_per_iter": med_ms,
        "mfu": last[3] if last else None,
        "max_iters": log["max_iters"],
        "ckpts": cks,
        "starts": log["starts"],
    }
    found = issues(cfg, cur, prev, log, cks, med_ms)

    state, was = info.get("state"), prev.get("job", {}).get("state")
    label = f"job {job_id} {cfg.run}" if job_id else f"{cfg.run} (no slurm job id found)"
    nodes = (info.get("nodes") or "").strip()
    where = f" on {nodes}" if nodes and nodes not in {"None assigned", "(null)", "n/a"} else ""
    if state is None:
        why = "slurm unreachable" if job_id else "no job id yet"
        print(f"{label}: {why}; falling back to log and ckpts on disk")
    elif was != state:
        # squeue's %R reason arrives already parenthesised, e.g. "(Priority)"; exit codes do not
        detail = (info.get("reason") or info.get("exit_code") or "").strip()
        if detail and not detail.startswith("("):
            detail = f"({detail})"
        head = f"{label}: {was or 'new'} -> {state}"
        print(f"{head} {detail}{where}" if detail else f"{head}{where}")
    else:
        print(f"{label}: still {state} after {info.get('elapsed', '?')}{where}")

    if line := train_line(cur, prev):
        print(line)
    if state is not None and state not in LIVE:
        derived = info.get("derived_exit_code")
        step = f", steps {derived}" if derived and derived != info.get("exit_code") else ""
        print(
            f"TERMINAL: {state} exit {info.get('exit_code', '?')}{step} "
            f"after {info.get('elapsed', '?')}"
        )
    # STATUS and ISSUES stay adjacent: the report copies both verbatim. The raw tail goes after
    # them, fenced, so a log line that happens to contain "FAILED" cannot be read as a verdict.
    print(status_line(cfg, cur, prev, log, med_ms))
    print("ISSUES: " + ("; ".join(found) if found else "none"))
    if log["tail"]:
        print(f"--- last {len(log['tail'])} log lines (raw, not for copying) ---")
        print("\n".join(log["tail"]))
        print("--- end log ---")

    snap.parent.mkdir(parents=True, exist_ok=True)
    snap.write_text(json.dumps(cur, indent=2))


if __name__ == "__main__":
    main()
