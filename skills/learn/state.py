#!/usr/bin/env python3
"""Read or update GROK_HOME/learn/state.json for the /learn skill.

  state.py get
  state.py set --run-dir DIR --status collected|running|report_ready|curating|done [--mode M] [--scope S] [--note TEXT]
  state.py clear
  state.py trash --run-name NAME PATH [PATH ...]   move files or directories into GROK_HOME/learn/trash/NAME/
  state.py restrict PATH [PATH ...]                owner-only permissions where the OS supports it
  state.py decide --run-dir DIR --id A3 --kind skill --action delete --target NAME --path P --decision applied|rejected|deferred [--undo P]
  state.py wait --run-dir DIR [--timeout-min 90]      block until report.md + actions.json exist (exit 0); exit 3 if verifiers finished but no report
                                                     appears within --report-stall-min (default 45); exit 4 if no file under the run dir changes for
                                                     --phase-stall-min (default 60); exit 2 when the deadline passes

`get` prints the state as JSON (plus `python`, the interpreter running this file, and `grok_home`,
so the skill never resolves either in shell) and exits 3 when a run is pending (status other than
done). All writes merge into the existing file. `trash`, `restrict`, and `decide` exist so the
skill never needs mkdir/mv/chmod/echo >>; they work the same in bash and PowerShell.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import stat
import sys
import time

STATUSES = ("collected", "running", "report_ready", "curating", "done")


def state_path(grok_home: str) -> str:
    return os.path.join(grok_home, "learn", "state.json")


def load(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--grok-home", default=os.environ.get("GROK_HOME") or os.path.expanduser("~/.grok"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("get")
    s = sub.add_parser("set")
    s.add_argument("--run-dir", required=True)
    s.add_argument("--status", required=True, choices=STATUSES)
    s.add_argument("--mode")
    s.add_argument("--scope")
    s.add_argument("--note")
    sub.add_parser("clear")
    t = sub.add_parser("trash")
    t.add_argument("--run-name", required=True)
    t.add_argument("paths", nargs="+")
    r = sub.add_parser("restrict")
    r.add_argument("paths", nargs="+")
    d = sub.add_parser("decide")
    for name in ("--run-dir", "--id", "--kind", "--action", "--target", "--path"):
        d.add_argument(name, required=True)
    d.add_argument("--decision", required=True, choices=("applied", "rejected", "deferred"))
    d.add_argument("--undo", default=None)
    w = sub.add_parser("wait")
    w.add_argument("--run-dir", required=True)
    w.add_argument("--timeout-min", type=int, default=90)
    w.add_argument("--phase-stall-min", type=int, default=60, help="minutes without any file changing under the run dir before the run counts as frozen in its current phase")
    w.add_argument("--report-stall-min", type=int, default=45, help="minutes after all three verifier files exist before the run counts as stalled at the Report stage (report workers take 30-40 min on 80-session runs)")
    args = ap.parse_args()

    grok_home = os.path.abspath(os.path.expanduser(args.grok_home))
    path = state_path(grok_home)

    if args.cmd == "trash":
        # the run name is one directory component under learn/trash; anything else lands somewhere unintended
        if args.run_name in ("", ".", "..") or os.path.basename(args.run_name) != args.run_name:
            print(json.dumps({"error": "run-name must be a single path component", "run_name": args.run_name}))
            return 2
        dest_dir = os.path.join(grok_home, "learn", "trash", args.run_name)
        # only these shapes are ever deleted by the skill: a skill directory, a workflow file, a hook file,
        # under GROK_HOME, ~/.agents, or a project .grok directory. Sessions, config, and roots never move.
        home_real = os.path.realpath(grok_home)
        agents_real = os.path.realpath(os.path.expanduser("~/.agents"))
        moved = []
        for src in args.paths:
            src = os.path.abspath(os.path.expanduser(src))
            real = os.path.realpath(src)
            if not os.path.exists(src):
                print(json.dumps({"error": "missing", "path": src}))
                return 1
            parent = os.path.dirname(real)
            kind = os.path.basename(parent)
            grand = os.path.dirname(parent)
            is_skill_dir = os.path.isdir(real) and kind == "skills" and (grand in (home_real, agents_real) or grand.endswith(os.sep + ".grok"))
            is_workflow = os.path.isfile(real) and real.endswith(".rhai") and kind == "workflows" and (grand == home_real or grand.endswith(os.sep + ".grok"))
            is_hook = os.path.isfile(real) and kind == "hooks" and (grand == home_real or grand.endswith(os.sep + ".grok"))
            if not (is_skill_dir or is_workflow or is_hook):
                print(json.dumps({"error": "refusing: only a skills/<name> directory, a workflows/*.rhai file, or a hooks/* file under GROK_HOME, ~/.agents, or a project .grok directory can be trashed", "path": src}))
                return 2
        os.makedirs(dest_dir, exist_ok=True)
        for src in args.paths:
            src = os.path.abspath(os.path.expanduser(src))
            dest = os.path.join(dest_dir, os.path.basename(src.rstrip("\\/")))
            if os.path.exists(dest):
                dest += "-" + dt.datetime.now(dt.timezone.utc).strftime("%H%M%S")
            shutil.move(src, dest)
            moved.append({"from": src, "to": dest})
        print(json.dumps({"moved": moved}, indent=1))
        return 0

    if args.cmd == "wait":
        # the workflow dies with the turn that launched it in headless, scheduled, or subagent sessions;
        # blocking here keeps that turn alive until the report agent has written both files.
        # The parent records report_ready: a worker writing outside the run dir can hit a permission prompt nobody answers.
        deadline = time.time() + args.timeout_min * 60
        report = os.path.join(args.run_dir, "report.md")
        actions = os.path.join(args.run_dir, "actions.json")
        verify_dir = os.path.join(args.run_dir, "verify")
        last_phase = None
        verify_done_at = None
        last_progress = (newest_mtime(args.run_dir), time.time())
        while time.time() < deadline:
            if os.path.isfile(report) and os.path.isfile(actions):
                mark(path, args.run_dir, "report_ready")
                print(json.dumps({"status": "report_ready", "report": report, "actions": actions}))
                return 0
            phase = next((p for p in ("verify", "reduce") if os.path.isdir(os.path.join(args.run_dir, p)) and os.listdir(os.path.join(args.run_dir, p))), None)
            if phase is None:
                # mappers write map0000-0009.md at the run root, not under map/
                phase = "map" if any(f.startswith("map") and f.endswith(".md") for f in os.listdir(args.run_dir)) else "collected"
            if phase != last_phase:
                print(json.dumps({"status": "running", "phase": phase, "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}), flush=True)
                last_phase = phase
            # any phase can freeze (a reducer on a 246-session run sat 5 h with no output): no new or changed file
            # under the run dir for --phase-stall-min means the run is not progressing, whatever the host says
            newest = newest_mtime(args.run_dir)
            if newest > last_progress[0]:
                last_progress = (newest, time.time())
            elif time.time() - last_progress[1] > args.phase_stall_min * 60:
                mark(path, args.run_dir, "phase_stalled", {"note": f"no file changed under the run dir for {args.phase_stall_min} min"})
                print(json.dumps({"status": "phase_stalled", "phase": last_phase, "synthesis": latest_synthesis(args.run_dir), "run_dir": args.run_dir}))
                return 4
            # Report stage stall: all three verifier files exist but no report appears. Seen on runs where the
            # report worker never started or looped on reads; exit so the parent can hand over the synthesis.
            verdicts = [f for f in ("phrases.md", "stale.md", "deletes.md") if os.path.isfile(os.path.join(verify_dir, f))]
            if len(verdicts) == 3:
                verify_done_at = verify_done_at or time.time()
                if time.time() - verify_done_at > args.report_stall_min * 60:
                    mark(path, args.run_dir, "report_stalled", {"note": f"verifiers finished; no report.md after {args.report_stall_min} min"})
                    print(json.dumps({"status": "report_stalled", "synthesis": latest_synthesis(args.run_dir), "verify_dir": verify_dir, "run_dir": args.run_dir}))
                    return 3
            time.sleep(30)
        print(json.dumps({"status": "timeout", "last_phase": last_phase, "run_dir": args.run_dir}))
        return 2

    if args.cmd == "restrict":
        for p in args.paths:
            try:
                os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass
        print(json.dumps({"restricted": args.paths}))
        return 0

    if args.cmd == "decide":
        line = {"date": dt.datetime.now(dt.timezone.utc).date().isoformat(), "run_dir": args.run_dir, "id": args.id,
                "kind": args.kind, "action": args.action, "target": args.target, "path": args.path,
                "decision": args.decision, "undo": args.undo}
        dec_path = os.path.join(grok_home, "learn", "decisions.jsonl")
        os.makedirs(os.path.dirname(dec_path), exist_ok=True)
        with open(dec_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
        print(json.dumps(line))
        return 0

    state = load(path)

    if args.cmd == "get":
        pending = state.get("pending") or {}
        # a run whose files exist is report_ready even if nothing recorded it (the parent died before wait returned)
        if pending.get("status") in ("collected", "running") and files_ready(pending.get("run_dir") or ""):
            state = mark(path, pending["run_dir"], "report_ready")
            pending = state["pending"]
        view = dict(state)
        view["python"] = sys.executable
        view["grok_home"] = grok_home
        print(json.dumps(view, indent=1))
        return 3 if pending and pending.get("status") != "done" else 0

    if args.cmd == "clear":
        state.pop("pending", None)
        save(path, state)
        print(json.dumps(state, indent=1))
        return 0

    state = mark(path, args.run_dir, args.status, {k: getattr(args, k) for k in ("mode", "scope", "note")})
    print(json.dumps(state, indent=1))
    return 0


def newest_mtime(run_dir: str) -> float:
    """Latest modification time of any file under the run dir (0 if none) — the run's heartbeat."""
    newest = 0.0
    for root, _dirs, files in os.walk(run_dir):
        for f in files:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(root, f)))
            except OSError:
                pass
    return newest


def latest_synthesis(run_dir: str) -> str | None:
    """Newest reducer output; the best available result when the report stage never produced report.md."""
    d = os.path.join(run_dir, "reduce")
    if not os.path.isdir(d):
        return None
    files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".md")]
    return max(files, key=os.path.getmtime) if files else None


def files_ready(run_dir: str) -> bool:
    return bool(run_dir) and os.path.isfile(os.path.join(run_dir, "report.md")) and os.path.isfile(os.path.join(run_dir, "actions.json"))


def mark(path: str, run_dir: str, status: str, extra: dict | None = None) -> dict:
    """Record `status` for `run_dir` as the pending run and save; `done` also stamps last_completed_*."""
    state = load(path)
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    pending = state.get("pending") or {}
    if pending.get("run_dir") != run_dir:
        pending = {"run_dir": run_dir, "started_at": now}
    pending["status"] = status
    pending["updated_at"] = now
    pending["report_ready"] = files_ready(run_dir)
    for k, v in (extra or {}).items():
        if v:
            pending[k] = v
    if status == "done":
        state["last_completed_at"] = now
        state["last_completed_dir"] = run_dir
    state["pending"] = pending
    save(path, state)
    return state


if __name__ == "__main__":
    sys.exit(main())
