#!/usr/bin/env python3
"""Trace tool calls and loops in one SWE-bench audit bundle.

Reads each cell's chat_history.jsonl, events.jsonl, usage.json, signals.json
and the bundle's run-status.json. Prints the phase split, repeated commands,
git-history lookups, unbounded searches, paths outside the cell workdir,
edit failures, and timelines for the longest tasks.

Classifier caveats, kept stable so a rerun matches an older report:
- "test" matches any command containing pytest, runtests.py, manage.py test,
  tox, or unittest, including pip download and grep of those names.
- "outside workdir" is any /home/thanh path that is not the cell workdir,
  so the cell's own cook/ parent and ~/.local interpreters count too.
- "lookup" is git log --all, git fsck, git show <hex>, and git log --grep.
- Identical-command repeats require the same whitespace-normalized string.

Usage:
  python3 scripts/swe-bench/trace_audit.py docs/audits/<audit-dir>
  python3 scripts/swe-bench/trace_audit.py docs/audits/<audit-dir> -o /tmp/trace.txt
"""
import argparse
import json
import re
import collections
import sys
from pathlib import Path


def _parse_args():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "audit_dir",
        type=Path,
        help="audit bundle directory that contains run-status.json",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="write the report to this path instead of stdout",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=8,
        help="how many longest-wall task timelines to print (default 8)",
    )
    return parser.parse_args()


_ARGS = _parse_args()
ROOT = _ARGS.audit_dir
if not (ROOT / "run-status.json").is_file():
    sys.exit(f"no run-status.json under {ROOT}")
if _ARGS.output:
    sys.stdout = open(_ARGS.output, "w")


def load_jsonl(p):
    rows = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows

def text_of(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for x in content:
            if isinstance(x, dict):
                parts.append(x.get("text") or x.get("content") or "")
            else:
                parts.append(str(x))
        return "\n".join(parts)
    return str(content)

def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip()

def first_exe(command):
    seg = re.split(r"\s*(?:&&|\|\||;|\|)\s*", command.strip(), maxsplit=1)[0]
    toks = seg.split()
    i = 0
    while i < len(toks) and "=" in toks[i] and not toks[i].startswith(("-", "=")):
        i += 1
    while i < len(toks) and toks[i] in ("sudo", "command", "builtin", "time", "nice"):
        i += 1
    return toks[i] if i < len(toks) else "?"

def shell_exit(result):
    m = re.match(r"exit:\s*(-?\d+)", result or "")
    return int(m.group(1)) if m else None

def is_edit(name):
    return name in ("search_replace", "write")

def short(s, n=110):
    s = norm_ws(s)
    return s if len(s) <= n else s[: n - 1] + "…"

EDIT_FAIL_RE = re.compile(
    r"(not found|multiple matches|old_string|does not match|Error|error:|failed|ambiguous|No such file|rejected|too large|exceeds)",
    re.I,
)

TEST_RE = re.compile(
    r"\b(pytest|runtests\.py|manage\.py\s+test|tox|unittest|python3?\s+-m\s+pytest|python3?\s+-m\s+unittest)\b"
)
LOOKUP_RE = re.compile(
    r"git\s+(log\s+--all|log\s+.*--all|fsck|show\s+[0-9a-f]{6,}|log\s+.*--grep|rev-list\s+--all)"
)
UNBOUNDED_RE = re.compile(
    r"(?:^|[;&|]\s*)find\s+/\s|find\s+/\s+-|git\s+fsck|git\s+log\s+--all|git\s+log\s+.*--all"
)

status = json.loads((ROOT / "run-status.json").read_text())
by_key = {}
for k, t in status["tasks"].items():
    by_key[(f"seed-{t['seed']}", f"{t['level']}-{t['instance_id']}")] = t

cells = []
for chat in sorted(ROOT.glob("seed-*/*/*/home/cook/sessions/*/*/chat_history.jsonl")):
    rel = chat.relative_to(ROOT)
    seed, slot = rel.parts[0], rel.parts[1]
    sess = chat.parent
    durations = {}
    outcomes = {}
    for e in load_jsonl(sess / "events.jsonl"):
        if e.get("type") == "tool_completed":
            durations[e.get("tool_call_id")] = e.get("duration_ms")
            outcomes[e.get("tool_call_id")] = e.get("outcome")
    usage = json.loads((sess / "usage.json").read_text())
    signals = json.loads((sess / "signals.json").read_text())
    hist = load_jsonl(chat)
    workdir = ""
    calls = []
    results = {}
    reminders = []
    assistant_turns = 0
    batch_sizes = []
    for rec in hist:
        t = rec.get("type")
        if t == "user":
            tx = text_of(rec.get("content"))
            if not workdir:
                m = re.search(r"Workspace Path: ([^\n<]+)", tx)
                if m:
                    workdir = m.group(1).strip()
            for m in re.finditer(r"<system-reminder>\s*(.*?)\s*</system-reminder>", tx, re.S):
                reminders.append(norm_ws(m.group(1))[:200])
        elif t == "assistant":
            assistant_turns += 1
            tcs = rec.get("tool_calls") or []
            batch_sizes.append(len(tcs))
            for tc in tcs:
                raw = tc.get("arguments") or "{}"
                try:
                    args = json.loads(raw) if isinstance(raw, str) else raw
                except Exception:
                    args = {"_raw": str(raw)[:300]}
                if not isinstance(args, dict):
                    args = {"_raw": str(args)[:300]}
                calls.append({
                    "id": tc.get("id"),
                    "name": tc.get("name"),
                    "args": args,
                    "turn": assistant_turns,
                })
        elif t == "tool_result":
            results[rec.get("tool_call_id")] = text_of(rec.get("content"))
    for c in calls:
        c["result"] = results.get(c["id"], "")
        c["dur"] = durations.get(c["id"])
        c["outcome"] = outcomes.get(c["id"])
        c["res_len"] = len(c["result"])
    st = by_key.get((seed, slot), {})
    cells.append({
        "seed": seed, "slot": slot, "workdir": workdir,
        "calls": calls, "batch_sizes": batch_sizes,
        "assistant_turns": assistant_turns, "reminders": reminders,
        "usage": usage, "signals": signals, "status": st,
    })

print(f"cells {len(cells)}")

# ---------- aggregates ----------
mix = collections.Counter()
exe = collections.Counter()
batch = collections.Counter()
block = collections.Counter()
exit_nz = collections.Counter()
edit_fail = []
lookup_cmds = []
unbounded = []
outside = []
bg = []
read_paths = collections.Counter()  # global path basename counts not useful
test_cmds = []
write_results = []
sr_shapes = collections.Counter()
phases = collections.Counter()  # pre/mid/post tool names
phase_calls = collections.Counter()
identical_waste = 0
identical_groups = []  # (cell, cmd, n)
reread_after_edit = []
reread_before = 0
reread_total_extra = 0
same_turn_edit_and_test = []
same_turn_multi = 0
post_kinds = collections.Counter()
pre_kinds = collections.Counter()
mid_kinds = collections.Counter()
fail_then_same = []
streaks = []  # (cell, start, length, signature)
reminders_c = collections.Counter()
bg_wait_ms = []
long_shell = []
comp = collections.Counter()
comp_tokens = collections.Counter()
main_uncached = 0
main_out = 0
main_cache = 0
main_calls = 0
reasoning_out = 0
ctx_usage = []
tool_fail_signal = 0
doom = 0

def classify_shell(cmd):
    c = cmd
    if TEST_RE.search(c):
        return "test"
    if LOOKUP_RE.search(c) or "git show" in c and re.search(r"git\s+show\s+[0-9a-f]{6,}", c):
        return "lookup"
    if re.search(r"\bgit\s+diff\b|\bgit\s+status\b|\bgit\s+log\b", c):
        return "git-meta"
    if re.search(r"\bpip\b|\buv\b|\bvenv\b|\bvirtualenv\b|python3?\s+-m\s+pip|setup\.py|pip install", c):
        return "env"
    exe0 = first_exe(c)
    base = exe0.rsplit("/", 1)[-1]
    if base in ("grep", "rg", "ag"):
        return "grep"
    if base in ("ls", "find", "tree"):
        return "list"
    if base in ("sed", "cat", "head", "tail", "less", "nl", "awk"):
        return "peek"
    if base in ("python", "python3", "pytest"):
        return "python"
    if base in ("git",):
        return "git-other"
    return "other:" + base

def outside_workdir(text, workdir):
    hits = []
    for m in re.finditer(r"(/home/thanh/[^\s'\"|;>&]+)", text):
        p = m.group(1).rstrip(".,)")
        if workdir and p.startswith(workdir):
            continue
        if "/usr/" in p or p.startswith("/tmp"):
            continue
        hits.append(p)
    return hits

for cell in cells:
    label = f"{cell['seed']}/{cell['slot']}"
    calls = cell["calls"]
    wd = cell["workdir"]
    sig = cell["signals"]
    tool_fail_signal += sig.get("toolFailureCount") or 0
    doom += sig.get("doomLoopRecoveryAttempts") or 0
    ctx_usage.append(sig.get("contextWindowUsage") or 0)
    for r in cell["reminders"]:
        reminders_c[r] += 1
    sess_u = cell["usage"].get("session") or {}
    purpose = (sess_u.get("purposeUsage") or {}).get("main_loop") or {}
    main_uncached += purpose.get("uncachedInputTokens") or 0
    main_out += purpose.get("outputTokens") or 0
    main_cache += purpose.get("cachedReadTokens") or 0
    main_calls += purpose.get("modelCalls") or 0
    reasoning_out += purpose.get("reasoningTokens") or 0
    rc = (sess_u.get("requestComponents") or {})
    for k, v in rc.items():
        if k.endswith("Tokens") and isinstance(v, (int, float)):
            comp_tokens[k] += v
    comp["requests"] += rc.get("requestsMeasured") or 0

    edit_idx = [i for i, c in enumerate(calls) if is_edit(c["name"])]
    first_e = edit_idx[0] if edit_idx else None
    last_e = edit_idx[-1] if edit_idx else None

    # identical commands
    cmd_counts = collections.Counter()
    for c in calls:
        if c["name"] == "run_terminal_command":
            cmd_counts[norm_ws(c["args"].get("command", ""))] += 1
    for cmd, n in cmd_counts.items():
        if n >= 2 and cmd:
            identical_waste += n - 1
            identical_groups.append((n, label, cmd))

    # reads
    read_i = collections.defaultdict(list)
    edited_files = set()
    for i, c in enumerate(calls):
        if c["name"] == "read_file":
            p = c["args"].get("target_file") or c["args"].get("file_path") or c["args"].get("path") or "?"
            read_i[p].append(i)
        if is_edit(c["name"]):
            fp = c["args"].get("file_path") or c["args"].get("target_file") or c["args"].get("path") or "?"
            edited_files.add(fp)
    for p, idxs in read_i.items():
        if len(idxs) >= 2:
            reread_total_extra += len(idxs) - 1
            # after an edit of same file?
            edit_positions = [i for i, c in enumerate(calls) if is_edit(c["name"]) and (
                (c["args"].get("file_path") or c["args"].get("target_file") or "") == p
                or p.endswith("/" + (c["args"].get("file_path") or "___"))
                or (c["args"].get("file_path") or "").endswith(p)
                or p.endswith(c["args"].get("file_path") or "\0")
            )]
            after = [i for i in idxs if edit_positions and i > min(edit_positions)]
            if after:
                reread_after_edit.append((label, p, len(idxs), len(after)))
            else:
                reread_before += len(idxs) - 1

    # per-call classify + phases
    prev_cmd = None
    for i, c in enumerate(calls):
        mix[c["name"]] += 1
        if first_e is None:
            phase = "no-edit"
        elif i < first_e:
            phase = "pre"
        elif i <= last_e:
            phase = "mid"
        else:
            phase = "post"
        phase_calls[phase] += 1
        name = c["name"]
        if phase == "pre":
            pre_kinds[name] += 1
        elif phase == "mid":
            mid_kinds[name] += 1
        elif phase == "post":
            post_kinds[name] += 1

        if name == "run_terminal_command":
            cmd = c["args"].get("command") or ""
            exe[first_exe(cmd)] += 1
            bu = c["args"].get("block_until_ms")
            block["omit" if bu is None else str(bu)] += 1
            ex = shell_exit(c["result"])
            if ex not in (None, 0):
                exit_nz[ex] += 1
            kind = classify_shell(cmd)
            if phase == "post":
                post_kinds["shell:" + kind] += 1
            if phase == "pre":
                pre_kinds["shell:" + kind] += 1
            if LOOKUP_RE.search(cmd):
                lookup_cmds.append((label, c["dur"], short(cmd, 160), ex))
            if UNBOUNDED_RE.search(cmd) or re.search(r"(^|[;&|]\s*)find\s+/(\s|$)", cmd):
                unbounded.append((label, c["dur"], short(cmd, 160)))
            if c["dur"] and c["dur"] >= 20000:
                long_shell.append((c["dur"], label, short(cmd, 140), ex, bu))
            hits = outside_workdir(cmd, wd)
            # also result paths? skip, too noisy. command is enough. also read paths below.
            if hits:
                outside.append((label, "shell", hits[:3], short(cmd, 120)))
            if TEST_RE.search(cmd):
                test_cmds.append((label, phase, ex, c["dur"], short(cmd, 140)))
            if prev_cmd and norm_ws(cmd) == prev_cmd and ex not in (None, 0):
                fail_then_same.append((label, short(cmd, 100), ex))
            prev_cmd = norm_ws(cmd)
        else:
            prev_cmd = None

        if name == "read_file":
            p = c["args"].get("target_file") or "?"
            hits = outside_workdir(p, wd)
            if hits:
                outside.append((label, "read", hits[:2], short(p, 120)))
        if name == "search_replace":
            if "edits" in c["args"] and c["args"].get("edits"):
                sr_shapes["multi"] += 1
                sr_shapes["hunks"] += len(c["args"]["edits"])
            else:
                sr_shapes["single"] += 1
            res = c["result"]
            ok = "updated successfully" in res or res.startswith("The file")
            if not ok:
                edit_fail.append((label, short(c["args"].get("file_path", "?"), 60), short(res, 160)))
        if name == "write":
            write_results.append((label, short(c["args"].get("file_path") or c["args"].get("target_file") or "?", 70), short(c["result"], 140), c["res_len"]))
        if name == "background_task":
            bg.append((label, c["args"], c["dur"], short(c["result"], 140)))

    # same-turn batches
    # regroup by turn
    by_turn = collections.defaultdict(list)
    for c in calls:
        by_turn[c["turn"]].append(c)
    for b in cell["batch_sizes"]:
        batch[b] += 1
    for turn, group in by_turn.items():
        if len(group) > 1:
            same_turn_multi += 1
            names = [g["name"] for g in group]
            cmds = [g["args"].get("command", "") for g in group if g["name"] == "run_terminal_command"]
            if any(is_edit(n) for n in names) and any(TEST_RE.search(cmd) for cmd in cmds):
                same_turn_edit_and_test.append((label, turn, [short(x, 60) for x in cmds]))

    # shell streaks with no edit: runs of >=6 consecutive non-edit after start
    run = 0
    run_start = 0
    sigs = []
    for i, c in enumerate(calls + [{"name": "search_replace"}]):  # sentinel
        if not is_edit(c["name"]):
            if run == 0:
                run_start = i
            run += 1
            if c["name"] == "run_terminal_command":
                sigs.append(classify_shell(c["args"].get("command", "")))
            else:
                sigs.append(c["name"])
        else:
            if run >= 8:
                streaks.append((run, label, run_start, collections.Counter(sigs).most_common(4)))
            run = 0
            sigs = []

    cell["_first_e"] = first_e
    cell["_last_e"] = last_e
    cell["_n_edit"] = len(edit_idx)

# ---------- print ----------
def section(t):
    print("\n" + "=" * 8 + " " + t + " " + "=" * 8)

section("HEADLINE")
print("tool mix", dict(mix))
print("calls", sum(mix.values()), "assistant turns", sum(c["assistant_turns"] for c in cells))
print("batch sizes", dict(sorted(batch.items())), "multi-tool turns", same_turn_multi)
print("phase calls", dict(phase_calls))
print("pre kinds", pre_kinds.most_common(12))
print("mid kinds", mid_kinds.most_common(12))
print("post kinds", post_kinds.most_common(16))
print("shell exe", exe.most_common(20))
print("block_until_ms", block.most_common(12))
print("nonzero shell exits", dict(exit_nz), "total", sum(exit_nz.values()))
print("search_replace shapes", dict(sr_shapes), "edit fails", len(edit_fail))
print("identical extra calls", identical_waste, "groups", len(identical_groups))
print("reread extras", reread_total_extra, "of which before any edit of that file", reread_before, "files reread after own edit", len(reread_after_edit))
print("lookup cmds", len(lookup_cmds), "unbounded", len(unbounded), "outside", len(outside))
print("background_task", len(bg), "same-turn edit+test", len(same_turn_edit_and_test))
print("signal toolFailureCount sum", tool_fail_signal, "doomLoopRecoveryAttempts", doom)
print("main_loop calls", main_calls, "uncached", main_uncached, "output", main_out, "cache", main_cache, "reasoning_out", reasoning_out)
print("request components", dict(comp_tokens), "requests", comp["requests"])
print("ctx usage min/mean/max", min(ctx_usage), round(sum(ctx_usage)/len(ctx_usage),1), max(ctx_usage))

section("REMINDERS")
for k, v in reminders_c.most_common(15):
    print(f"  {v:3d}  {k}")

section("IDENTICAL COMMANDS n>=3")
for n, label, cmd in sorted(identical_groups, reverse=True):
    if n >= 3:
        print(f"  x{n:2d}  {label}  {short(cmd, 150)}")

section("IDENTICAL n==2 (count only by kind)")
kind2 = collections.Counter()
for n, label, cmd in identical_groups:
    if n == 2:
        kind2[classify_shell(cmd)] += 1
print(dict(kind2))
print("examples:")
shown = 0
for n, label, cmd in sorted(identical_groups, key=lambda x: -x[0]):
    if n == 2 and shown < 18:
        print(f"  x2  {label}  {short(cmd, 140)}")
        shown += 1

section("LOOKUP")
for label, dur, cmd, ex in lookup_cmds:
    print(f"  {label}  {dur}ms exit={ex}  {cmd}")

section("UNBOUNDED / LONG SEARCH")
for label, dur, cmd in unbounded:
    print(f"  {label}  {dur}ms  {cmd}")

section("LONG SHELL >=20s")
for dur, label, cmd, ex, bu in sorted(long_shell, reverse=True):
    print(f"  {dur/1000:6.1f}s exit={ex} block={bu}  {label}  {cmd}")

section("OUTSIDE WORKDIR")
by_cell = collections.Counter(x[0] for x in outside)
print("cells", len(by_cell), "events", len(outside))
for label, n in by_cell.most_common():
    samples = [x for x in outside if x[0]==label][:4]
    print(f"  {n:3d}  {label}")
    for _, kind, hits, cmd in samples:
        print(f"       {kind} {hits} :: {cmd}")

section("EDIT FAILS")
for row in edit_fail[:40]:
    print(" ", row)

section("WRITE RESULTS")
for row in write_results:
    print(" ", row[0], row[1], "reslen", row[3], row[2])

section("REREAD AFTER EDIT (top)")
for row in sorted(reread_after_edit, key=lambda r: -r[2])[:25]:
    print(f"  reads={row[2]} after_edit_reads={row[3]}  {row[0]}  {row[1]}")

section("BACKGROUND")
for label, args, dur, res in bg:
    print(f"  {label} dur={dur} args={short(json.dumps(args), 160)}")
    print(f"     {res}")

section("SAME TURN EDIT+TEST")
for row in same_turn_edit_and_test:
    print(" ", row)

section("NON-EDIT STREAKS >=8")
for run, label, start, top in sorted(streaks, reverse=True)[:25]:
    print(f"  len={run:3d} start={start:3d}  {label}  {top}")

section("TEST COMMANDS")
print("count", len(test_cmds))
by = collections.Counter((a, b) for a, b, *_ in test_cmds)
# per cell
per = collections.Counter(a for a, *_ in test_cmds)
print("per cell top", per.most_common(12))
phase_t = collections.Counter(b for _, b, *_ in test_cmds)
print("by phase", dict(phase_t))
ex_t = collections.Counter(c for _, _, c, *_ in test_cmds)
print("by exit", dict(ex_t))
# repeats within cell of similar test
print("--- cells with >=3 test cmds")
for label, n in per.most_common():
    if n < 3:
        break
    cmds = [c for c in test_cmds if c[0]==label]
    print(f"  {n} {label}")
    for c in cmds:
        print(f"     phase={c[1]} exit={c[2]} dur={c[3]} {c[4]}")

section("PER TASK")
rows = []
for cell in cells:
    st = cell["status"]
    calls = cell["calls"]
    n = len(calls)
    fe, le = cell["_first_e"], cell["_last_e"]
    pre = fe if fe is not None else n
    post = (n - le - 1) if le is not None else 0
    mid = (le - fe + 1) if fe is not None else 0
    shell_nz = sum(1 for c in calls if c["name"]=="run_terminal_command" and shell_exit(c["result"]) not in (None, 0))
    rows.append((
        st.get("wall_seconds") or 0,
        st.get("calls") or 0,
        n,
        pre, mid, post,
        cell["_n_edit"],
        shell_nz,
        st.get("input") or 0,
        st.get("output") or 0,
        st.get("cache_read") or 0,
        f"{cell['seed']}/{cell['slot']}",
        st.get("label"),
    ))
print(f"{'wall':>7} {'mcall':>5} {'tools':>5} {'pre':>4} {'mid':>4} {'post':>4} {'edit':>4} {'sherr':>5} {'uncached':>9} {'out':>7} {'cache':>9} task")
for r in sorted(rows, reverse=True):
    print(f"{r[0]:7.0f} {r[1]:5d} {r[2]:5d} {r[3]:4d} {r[4]:4d} {r[5]:4d} {r[6]:4d} {r[7]:5d} {r[8]:9d} {r[9]:7d} {r[10]:9d} {r[11]} {r[12]}")

# save timelines for the 8 longest wall
section("TIMELINES top wall")
rank = {r[11]: r for r in rows}
top = [r[11] for r in sorted(rows, reverse=True)[: _ARGS.top]]
for cell in cells:
    label = f"{cell['seed']}/{cell['slot']}"
    if label not in top:
        continue
    print(f"\n--- {label} wall={rank[label][0]:.0f}s tools={len(cell['calls'])} pre={rank[label][3]} mid={rank[label][4]} post={rank[label][5]}")
    for i, c in enumerate(cell["calls"]):
        name = c["name"]
        if name == "run_terminal_command":
            arg = c["args"].get("command", "")
            extra = f" exit={shell_exit(c['result'])} block={c['args'].get('block_until_ms','-')}"
        elif name == "read_file":
            arg = f"{c['args'].get('target_file')} off={c['args'].get('offset')} lim={c['args'].get('limit')}"
            extra = ""
        elif name == "search_replace":
            nh = len(c["args"].get("edits") or []) or 1
            arg = f"{c['args'].get('file_path')} hunks={nh}"
            extra = " OK" if "updated successfully" in c["result"] or c["result"].startswith("The file") else " FAIL " + short(c["result"], 60)
        elif name == "background_task":
            arg = json.dumps(c["args"])[:100]
            extra = ""
        else:
            arg = json.dumps(c["args"])[:100]
            extra = ""
        dur = f"{(c['dur'] or 0)/1000:6.1f}s" if c["dur"] is not None else "     ?s"
        mark = ""
        fe, le = cell["_first_e"], cell["_last_e"]
        if fe is not None and i == fe:
            mark = " <<FIRST-EDIT"
        if le is not None and i == le and le != fe:
            mark = " <<LAST-EDIT"
        print(f"  {i:02d} {dur} {name:22} {short(arg, 100)}{extra}{mark}")
