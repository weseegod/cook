#!/usr/bin/env python3
"""Summarize isolated Cook, OpenCode, and Pi evaluation runs."""

import argparse
import json
import os
from pathlib import Path
import subprocess


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def total(values):
    found = [number(value) for value in values]
    found = [value for value in found if value is not None]
    return sum(found) if found else None


def events(path):
    if not path.exists():
        return []
    result = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                result.append(value)
        except json.JSONDecodeError:
            pass
    return result


def usage_cook(path):
    stdout_exists = path.is_file()
    raw = path.read_text(errors="replace") if stdout_exists else ""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        obj = {}
    if not isinstance(obj, dict):
        obj = {}
    usage = obj.get("usage") or {}
    if not isinstance(usage, dict):
        usage = {}
    metrics = dict(calls=number(obj.get("num_turns")),
                   input=number(usage.get("input_tokens")),
                   output=number(usage.get("output_tokens")),
                   read=number(usage.get("cache_read_input_tokens")),
                   write=number(usage.get("cache_creation_input_tokens")))
    source = "stdout.json" if any(value is not None for value in metrics.values()) else "unreported"
    # A missing stdout.json is an incomplete headless result, so do not
    # attribute a possibly unrelated persisted session to it.
    if stdout_exists and (metrics["calls"] is None or not usage):
        usage_files = list((path.parent / "home" / "cook" / "sessions").rglob("usage.json"))
        if len(usage_files) == 1:
            try:
                persisted = json.loads(usage_files[0].read_text(errors="replace"))
            except (OSError, json.JSONDecodeError):
                persisted = {}
            session = persisted.get("session", {}) if isinstance(persisted, dict) else {}
            purposes = session.get("purposeUsage", {}) if isinstance(session, dict) else {}
            main = purposes.get("main_loop", {}) if isinstance(purposes, dict) else {}
            if isinstance(main, dict):
                cache_present = main.get("cacheFieldPresent") is True
                fallback = dict(calls=number(main.get("modelCalls")),
                                input=number(main.get("uncachedInputTokens")),
                                output=number(main.get("outputTokens")),
                                read=number(main.get("cachedReadTokens")) if cache_present else None,
                                write=number(main.get("cacheCreationTokens")) if cache_present else None)
                filled = False
                for key, value in fallback.items():
                    if metrics[key] is None and value is not None:
                        metrics[key] = value
                        filled = True
                if filled:
                    source = "stdout.json + session usage.json" if source != "unreported" else "session usage.json"
    tool_events = []
    for event_file in (path.parent / "home" / "cook" / "sessions").rglob("events.jsonl"):
        tool_events.extend(e for e in events(event_file) if e.get("type") == "tool_started")
    tools = len(tool_events) if tool_events else obj.get("tool_calls")
    if isinstance(tools, list):
        tools = len(tools)
    return dict(**metrics, tools=number(tools), source=source)


def usage_opencode(path):
    rows = events(path)
    steps = [r.get("part", {}) for r in rows if r.get("type") == "step_finish"]
    tokens = [s.get("tokens", {}) for s in steps if isinstance(s, dict)]
    token = lambda key: total(t.get(key) for t in tokens if isinstance(t, dict))
    cache = [t.get("cache", {}) for t in tokens if isinstance(t, dict)]
    tool_ids = set()
    for row in rows:
        part = row.get("part") or {}
        if row.get("type") == "tool_use" or isinstance(part, dict) and part.get("type") == "tool":
            tool_ids.add(part.get("id") or part.get("callID") or json.dumps(part, sort_keys=True))
    return dict(calls=len(steps), tools=len(tool_ids), input=token("input"),
                output=token("output"), read=total(c.get("read") for c in cache if isinstance(c, dict)),
                write=total(c.get("write") for c in cache if isinstance(c, dict)))


def usage_pi(path):
    rows = events(path)
    messages = [r.get("message", {}) for r in rows if r.get("type") == "message_end"]
    usages = [m["usage"] for m in messages if isinstance(m, dict) and m.get("role") == "assistant"
              and isinstance(m.get("usage"), dict)]
    return dict(calls=len(usages), tools=sum(r.get("type") == "tool_execution_end" for r in rows),
                input=total(u.get("input") for u in usages),
                output=total(u.get("output") for u in usages),
                read=total(u.get("cacheRead") for u in usages),
                write=total(u.get("cacheWrite") for u in usages))


def files_and_bytes(workdir):
    if not workdir.is_dir():
        return 0, 0, []
    files = []
    for parent, dirs, names in os.walk(workdir):
        base = Path(parent)
        dirs[:] = sorted(d for d in dirs if d not in {".git", "node_modules"}
                         and not (base / d).is_symlink())
        files.extend(base / name for name in sorted(names)
                     if (base / name).is_file() and not (base / name).is_symlink())
    return len(files), sum(p.stat().st_size for p in files), files


def cell(value):
    return "unreported" if value is None else str(value)


def render(run_dir, model, wire, task, agents, thinking, parallel):
    lines = [f"# Agent comparison: {model}", "", f"Wire model: `{wire}`", f"Thinking: `{thinking}`", f"Parallel: `{parallel}`", "",
             "Task:", "", "> " + task.replace("|", "\\|").replace("\n", "\n> "), "",
             "| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Usage source | Files | Bytes | Output tokens/s |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |"]
    for agent in agents:
        directory = run_dir / agent
        metrics = {"cook": usage_cook, "opencode": usage_opencode, "pi": usage_pi}[agent](directory / "stdout.json")
        count, size, _ = files_and_bytes(directory / "workdir")
        try:
            seconds = float((directory / "elapsed-seconds.txt").read_text().strip())
        except (OSError, ValueError):
            seconds = None
        try:
            exit_code = int((directory / "exit-code.txt").read_text().strip())
        except (OSError, ValueError):
            exit_code = None
        cache_presence = "present" if metrics["read"] is not None or metrics["write"] is not None else "unreported"
        rate = round(metrics["output"] / seconds, 2) if metrics["output"] is not None and seconds and seconds > 0 else None
        values = [agent, f"{seconds:.2f}" if seconds is not None else None, exit_code,
                  metrics["calls"], metrics["tools"], metrics["input"], metrics["output"],
                  metrics["read"], metrics["write"], cache_presence,
                  metrics.get("source", "stdout.json"), count, size, rate]
        lines.append("| " + " | ".join(cell(v) for v in values) + " |")
    lines += ["", "Metrics come from each agent's JSON output or the labeled Cook session usage file. `unreported` means the field was absent.",
              "Files and bytes count regular files in each workdir, excluding .git and node_modules.", ""]
    return "\n".join(lines)


def self_test():
    from tempfile import TemporaryDirectory
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        cook = root / "cook.json"
        cook.write_text(json.dumps({"num_turns": 2, "usage": {"input_tokens": 5, "output_tokens": 6,
            "cache_read_input_tokens": 0, "cache_creation_input_tokens": 1}}))
        assert usage_cook(cook)["read"] == 0
        assert usage_cook(cook)["source"] == "stdout.json"
        oc = root / "oc.jsonl"
        oc.write_text(json.dumps({"type": "step_finish", "part": {"tokens": {"input": 3, "output": 4, "cache": {"read": 0}}}}) + "\n"
                      + json.dumps({"type": "tool_use", "part": {"id": "call-1"}}) + "\n")
        assert usage_opencode(oc)["read"] == 0 and usage_opencode(oc)["write"] is None
        assert usage_opencode(oc)["tools"] == 1
        pi = root / "pi.jsonl"
        pi.write_text(json.dumps({"type": "message_end", "message": {"role": "assistant", "usage": {"input": 3, "output": 4}}}) + "\n")
        assert usage_pi(pi)["read"] is None
        assert cell(usage_pi(pi)["write"]) == "unreported"

        repo = root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / ".gitignore").write_text("/evaluation/\n")
        run_dir = repo / "evaluation"
        directory = run_dir / "cook"
        workdir = directory / "workdir"
        workdir.mkdir(parents=True)
        for name in ("index.html", "style.css", "app.js"):
            (workdir / name).write_text(name)
        (workdir / "node_modules").mkdir()
        (workdir / "node_modules" / "skip.js").write_text("skip")
        assert subprocess.run(["git", "check-ignore", "-q", "evaluation/cook/workdir/index.html"],
                              cwd=repo).returncode == 0
        assert not (workdir / ".git").exists()
        count, size, files = files_and_bytes(workdir)
        assert count == 3 and size == sum(len(name) for name in ("index.html", "style.css", "app.js"))
        assert {p.name for p in files} == {"index.html", "style.css", "app.js"}

        stdout = directory / "stdout.json"
        stdout.write_text("{}")
        session = directory / "home" / "cook" / "sessions" / "one"
        session.mkdir(parents=True)
        (session / "usage.json").write_text(json.dumps({"session": {"purposeUsage": {
            "main_loop": {"modelCalls": 7, "uncachedInputTokens": 11, "outputTokens": 12,
                          "cachedReadTokens": 13, "cacheCreationTokens": 0,
                          "cacheFieldPresent": True}}}}))
        fallback = usage_cook(stdout)
        assert (fallback["calls"], fallback["input"], fallback["output"], fallback["read"],
                fallback["write"], fallback["source"]) == (7, 11, 12, 13, 0, "session usage.json")
        stdout.write_text(json.dumps({"num_turns": 2}))
        partial = usage_cook(stdout)
        assert partial["calls"] == 2 and partial["input"] == 11
        assert partial["source"] == "stdout.json + session usage.json"
        persisted = json.loads((session / "usage.json").read_text())
        persisted["session"]["purposeUsage"]["main_loop"]["cacheFieldPresent"] = False
        (session / "usage.json").write_text(json.dumps(persisted))
        stdout.write_text("{}")
        no_cache_field = usage_cook(stdout)
        assert no_cache_field["read"] is None and no_cache_field["write"] is None
        stdout.write_text("{}")
        (directory / "exit-code.txt").write_text("1")
        report = render(run_dir, "fixture", "fixture", "task", ["cook"], "false", 1)
        row = next(line for line in report.splitlines() if line.startswith("| cook |"))
        cells = [value.strip() for value in row.strip("|").split("|")]
        assert cells[2] == "1" and cells[11] == "3"

        stdout.unlink()
        absent = usage_cook(stdout)
        assert absent["calls"] is None and absent["input"] is None
        assert absent["source"] == "unreported"
        (session / "usage.json").unlink()
        stdout.write_text("{}")
        absent = usage_cook(stdout)
        assert absent["calls"] is None and absent["input"] is None
        assert absent["source"] == "unreported"
    print("summarizer self-test passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--model")
    parser.add_argument("--wire")
    parser.add_argument("--task")
    parser.add_argument("--agents")
    parser.add_argument("--thinking", choices=("true", "false"), default="false")
    parser.add_argument("--parallel", type=int, choices=(1, 2, 3), default=1)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if not all((args.run_dir, args.model, args.wire, args.task, args.agents, args.report)):
            parser.error("report arguments are required")
        report = render(args.run_dir, args.model, args.wire, args.task, args.agents.split(","), args.thinking, args.parallel)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report)
        (args.run_dir / "report.md").write_text(report)
        print(args.report)
