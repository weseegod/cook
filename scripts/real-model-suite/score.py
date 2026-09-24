#!/usr/bin/env python3
"""Pure artifact scorer for the real-model feature suite."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any


class Failure(Exception):
    pass


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def json_lines(path: Path) -> list[Any]:
    result = []
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    except OSError:
        pass
    return result


def walk(value: Any):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def result_obj(root: Path, suffix: str = "") -> dict[str, Any]:
    data = load_json(root / f"stdout{suffix}.json", {})
    if isinstance(data, dict):
        return data
    if suffix or not (root / "stdout.json").exists():
        return {}
    lines = json_lines(root / "stdout.json")
    for value in reversed(lines):
        if isinstance(value, dict) and ("text" in value or "sessionId" in value):
            return value
    return {}


def events(root: Path, suffix: str = "") -> list[dict[str, Any]]:
    path = root / f"events{suffix}.jsonl"
    return [x for x in json_lines(path) if isinstance(x, dict)]


def tool_events(root: Path, kind: str | None = None) -> list[dict[str, Any]]:
    all_events = events(root)
    if kind:
        return [e for e in all_events if e.get("type") == kind]
    return [e for e in all_events if e.get("type") in {"tool_started", "tool_completed"}]


def argument_objects(root: Path, tool: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for filename in ("chat_history.jsonl", "updates.jsonl"):
        for record in json_lines(root / filename):
            for node in walk(record):
                if not isinstance(node, dict):
                    continue
                fn = node.get("function") if isinstance(node.get("function"), dict) else node
                name = fn.get("name") or node.get("tool_name") or node.get("toolName")
                if name != tool:
                    continue
                args = fn.get("arguments", node.get("arguments", node.get("input")))
                if isinstance(args, str):
                    try: args = json.loads(args)
                    except json.JSONDecodeError: continue
                if isinstance(args, dict): found.append(args)
    return found


ARG_KEYS = {
    "read_file": "target_file", "grep": "pattern", "list_dir": "target_directory",
    "search_replace": "file_path", "run_terminal_cmd": "command", "web_fetch": "url",
}

TOOL_ALIASES = {
    "run_terminal_command": "run_terminal_cmd",
    "spawn_subagent": "task",
    "get_command_or_subagent_output": "get_task_output",
    "wait_commands_or_subagents": "wait_tasks",
    "kill_command_or_subagent": "kill_task",
}


def canonical_tool(name: Any) -> Any:
    return TOOL_ALIASES.get(name, name)


def check_tool_called(case: dict[str, Any], root: Path) -> None:
    completed = tool_events(root, "tool_completed")
    expected = case.get("expect_tools", [])
    any_groups = case.get("expect_any_tools", [])
    for name in expected:
        if not any(canonical_tool(e.get("tool_name")) == name and e.get("outcome") == "success" for e in completed):
            raise Failure(f"tool_called: no successful {name}")
    for group in any_groups:
        if not any(canonical_tool(e.get("tool_name")) in group and e.get("outcome") == "success" for e in completed):
            raise Failure(f"tool_called: none successful from {','.join(group)}")
    wire = (root / "wire.log").read_text(encoding="utf-8", errors="replace") if (root / "wire.log").exists() else ""
    for name in expected + [n for group in any_groups for n in group]:
        matching_names = [raw for raw in {name, *TOOL_ALIASES} if canonical_tool(raw) == name]
        if not any(canonical_tool(e.get("tool_name")) == name and e.get("outcome") == "success" for e in completed):
            continue
        args = [arg for raw in matching_names for arg in argument_objects(root, raw)]
        if "<tool_call>" in wire and (not args or any(not x for x in args)):
            raise Failure(f"tool_called: empty {name} arguments with XML envelope")
        key = ARG_KEYS.get(name)
        if key and args and not any(a.get(key) not in (None, "", []) for a in args):
            raise Failure(f"tool_called: {name} missing non-empty {key}")


def check_tool_not_called(case: dict[str, Any], root: Path) -> None:
    forbidden = set(case.get("forbid_tools", []))
    bad = [e.get("tool_name") for e in tool_events(root) if canonical_tool(e.get("tool_name")) in forbidden]
    if bad:
        raise Failure(f"tool_not_called: forbidden tool {bad[0]}")


def manifest(root: Path) -> dict[str, Any]:
    return load_json(root / "MANIFEST.json", {}) or {}


def marker(root: Path) -> str:
    return str(manifest(root).get("nonce", ""))


def current_files(root: Path) -> dict[str, str]:
    workdir = root / "workdir"
    out = {}
    for path in sorted(workdir.rglob("*")):
        if path.is_file() and ".git" not in path.parts:
            out[str(path.relative_to(workdir))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def check_file_unchanged(case: dict[str, Any], root: Path) -> None:
    if current_files(root) != manifest(root).get("files", {}):
        raise Failure("file_unchanged: workdir changed")


def check_file_contains(case: dict[str, Any], root: Path) -> None:
    for spec in case.get("files", []):
        path = root / "workdir" / spec["path"]
        expected = spec.get("contains", "{{MARKER}}").replace("{{MARKER}}", marker(root))
        if not path.exists() or expected not in path.read_text(encoding="utf-8", errors="replace"):
            raise Failure(f"file_contains: {spec['path']} lacks expected text")


def check_file_equals(case: dict[str, Any], root: Path) -> None:
    for spec in case.get("files", []):
        path = root / "workdir" / spec["path"]
        expected = spec["equals"].replace("{{MARKER}}", marker(root))
        actual = path.read_text(encoding="utf-8", errors="replace") if path.exists() else None
        if actual != expected:
            raise Failure(f"file_equals: {spec['path']} differs")


def check_file_absent(case: dict[str, Any], root: Path) -> None:
    for name in case.get("absent_files", []):
        if (root / "workdir" / name).exists():
            raise Failure(f"file_absent: {name} exists")


def workflow_result_blob(root: Path) -> str:
    """Serialized workflow `result_summary` values under the case session home."""
    blobs: list[str] = []
    sessions = root / "session"
    if not sessions.exists():
        return ""
    for state in sessions.rglob("workflows/**/state.json"):
        data = load_json(state, {}) or {}
        node = data.get("state") if isinstance(data, dict) else None
        if not isinstance(node, dict):
            node = data if isinstance(data, dict) else {}
        summary = node.get("result_summary")
        if summary:
            blobs.append(str(summary))
    return "\n".join(blobs)


def check_text_contains_marker(case: dict[str, Any], root: Path) -> None:
    text = str(result_obj(root).get("text", ""))
    suffix = case.get("marker_suffix", "")
    needle = marker(root) + suffix
    # Spec § agents.workflow_live: parent text **or** the workflow result may carry the nonce.
    if needle not in text and needle not in workflow_result_blob(root):
        raise Failure("text_contains_marker: top-level text lacks marker")
    for forbidden in case.get("text_forbid", []):
        value = forbidden.replace("{{MARKER}}", marker(root))
        if value in text:
            raise Failure(f"text_contains_marker: forbidden text {value!r}")


def check_text_contains(case: dict[str, Any], root: Path) -> None:
    text = str(result_obj(root).get("text", ""))
    for value in case.get("text_contains", []):
        value = value.replace("{{MARKER}}", marker(root))
        if value not in text:
            raise Failure(f"text_contains: missing {value!r}")
    for value in case.get("text_not_contains", []):
        if value in text:
            raise Failure(f"text_contains: forbidden {value!r}")


def check_text_nonempty(case: dict[str, Any], root: Path) -> None:
    result = result_obj(root)
    if not str(result.get("text", "")).strip():
        raise Failure("text_nonempty: empty top-level text")
    allowed = {"end_turn", *case.get("allow_stop", [])}
    if result.get("stopReason") not in allowed:
        raise Failure(f"text_nonempty: stopReason {result.get('stopReason')!r}")


def usage_session(root: Path) -> dict[str, Any]:
    data = load_json(root / "usage.json", {}) or {}
    return data if "purposeUsage" in data else data.get("session", {})


def check_usage_honest(case: dict[str, Any], root: Path) -> None:
    session = usage_session(root)
    rows = session.get("purposeUsage")
    if not isinstance(rows, dict):
        raise Failure("usage_honest: missing purposeUsage")
    def validate(label: str, row: dict[str, Any], reject_zero: bool = True) -> None:
        present = row.get("cacheFieldPresent")
        has_uncached = "uncachedInputTokens" in row
        if not isinstance(present, bool):
            raise Failure(f"usage_honest: {label} missing boolean cacheFieldPresent")
        if present is False and has_uncached:
            raise Failure(f"usage_honest: {label} has uncachedInputTokens when cacheFieldPresent=false")
        if present is True and (not has_uncached or not isinstance(row.get("uncachedInputTokens"), (int, float)) or row["uncachedInputTokens"] < 0):
            raise Failure(f"usage_honest: {label} invalid uncachedInputTokens")
        keys = ("modelCalls", "inputTokens", "outputTokens", "usageMissingCalls")
        if reject_zero and all(row.get(k, 0) == 0 for k in keys):
            raise Failure(f"usage_honest: {label} is all zero")
    validate("session", session, False)
    for name, row in rows.items():
        if isinstance(row, dict): validate(name, row)
    for key in ("modelCalls", "inputTokens"):
        total = sum(row.get(key, 0) for row in rows.values() if isinstance(row, dict))
        if total != session.get(key):
            raise Failure(f"usage_honest: {key} purpose sum {total} != session {session.get(key)}")
    result = result_obj(root)
    if not str(result.get("text", "")) and result.get("stopReason") == "cancelled":
        successful = {canonical_tool(e.get("tool_name")) for e in tool_events(root, "tool_completed") if e.get("outcome") == "success"}
        if not set(case.get("expect_tools", [])).issubset(successful):
            raise Failure("side-call-aborted")


def check_loop_realtime(case: dict[str, Any], root: Path) -> None:
    wire = (root / "wire.log").read_text(encoding="utf-8", errors="replace")
    if not ("/v1/chat/completions" in wire or "/v1/responses" in wire):
        raise Failure("loop_realtime: no realtime model request")
    if "/v1/batches" in wire:
        raise Failure("loop_realtime: batch endpoint used")


def check_denied(case: dict[str, Any], root: Path) -> None:
    expected = set(case.get("expect_tools", []))
    completed = tool_events(root, "tool_completed")
    successful = [e for e in completed if canonical_tool(e.get("tool_name")) in expected and e.get("outcome") == "success"]
    if successful:
        raise Failure(f"denied: {successful[0].get('tool_name')} succeeded")
    attempted = any(canonical_tool(e.get("tool_name")) in expected and e.get("outcome") in {"permission_rejected", "hook_denied"} for e in completed)
    attempted |= any(e.get("type") == "permission_resolved" and e.get("decision") == "deny" for e in events(root))
    if case.get("denial_required", True) and not attempted:
        raise Failure("denied: no denial recorded")


def check_resumed(case: dict[str, Any], root: Path) -> None:
    first, second = result_obj(root, "-1"), result_obj(root, "-2")
    if not first.get("sessionId") or first.get("sessionId") != second.get("sessionId"):
        raise Failure("resumed: session ids differ")
    if marker(root) not in str(second.get("text", "")):
        raise Failure("resumed: second response lacks marker")


def check_forked(case: dict[str, Any], root: Path) -> None:
    first, second = result_obj(root, "-1"), result_obj(root, "-2")
    if not first.get("sessionId") or first.get("sessionId") == second.get("sessionId"):
        raise Failure("forked: session ids are not distinct")
    if marker(root) not in str(second.get("text", "")):
        raise Failure("forked: fork response lacks marker")


def check_ordered_tools(case: dict[str, Any], root: Path) -> None:
    completed = [canonical_tool(e.get("tool_name")) for e in tool_events(root, "tool_completed") if e.get("outcome") == "success"]
    pos = -1
    for name in case.get("ordered_tools", []):
        try: pos = completed.index(name, pos + 1)
        except ValueError: raise Failure(f"ordered_tools: {name} absent or out of order")


def check_no_session(case: dict[str, Any], root: Path) -> None:
    if not (root / "session" / "summary.json").exists():
        raise Failure("no-session")


def check_no_external_http(case: dict[str, Any], root: Path) -> None:
    wire = (root / "wire.log").read_text(encoding="utf-8", errors="replace")
    allowed = re.sub(r"/v1/?$", "", case.get("base_url", "http://127.0.0.1:8080/v1"))
    # Catalog fetch and config echo print remote URLs on every run; those are not
    # tool HTTP. Real requests must still stay on the local model server.
    noise = re.compile(
        r"Fetching models from |data capture config resolved|Failed to fetch models"
    )
    for line in wire.splitlines():
        if noise.search(line):
            continue
        for url in re.findall(r"https?://[^\s\"']+", line):
            if not url.startswith(allowed):
                raise Failure(f"no_external_http: non-local-model URL found ({url})")


def check_ssrf_safe(case: dict[str, Any], root: Path) -> None:
    text = str(result_obj(root).get("text", ""))
    if "root:x:0:0:" in text or "ami-id" in text:
        raise Failure("ssrf_safe: protected content leaked")


def check_streaming_json(case: dict[str, Any], root: Path) -> None:
    raw = (root / "stdout.json").read_text(encoding="utf-8", errors="replace").splitlines()
    if not raw: raise Failure("streaming_json: empty stdout")
    parsed = []
    for line in raw:
        try: parsed.append(json.loads(line))
        except json.JSONDecodeError: raise Failure("streaming_json: non-JSON stdout line")
    if marker(root) not in json.dumps(parsed[-1], ensure_ascii=False):
        raise Failure("streaming_json: final record lacks marker")


def check_todo_record(case: dict[str, Any], root: Path) -> None:
    records = "\n".join(
        (root / name).read_text(encoding="utf-8", errors="replace")
        for name in ("chat_history.jsonl", "updates.jsonl") if (root / name).exists()
    ).lower()
    if "alpha" not in records or "beta" not in records or "completed" not in records:
        raise Failure("no-todo-record")


def check_home_memory(case: dict[str, Any], root: Path) -> None:
    memory = root / "home" / "memory"
    if not memory.exists() or not any(marker(root) in p.read_text(encoding="utf-8", errors="replace") for p in memory.rglob("*") if p.is_file()):
        raise Failure("home_memory: marker absent")


def check_scheduler_clean(case: dict[str, Any], root: Path) -> None:
    home = root / "home"
    for path in home.rglob("*"):
        if not path.is_file():
            continue
        # Session transcripts under home/sessions/ legitimately contain the nonce
        # (read_file results, tool calls). Only non-session files matter.
        rel = path.relative_to(home)
        if any(part == "sessions" or part.startswith("session") for part in rel.parts[:-1]) or (
            rel.parts and rel.parts[0] == "sessions"
        ):
            continue
        # Match path components under home only: the case directory is named
        # tools.scheduler_roundtrip, so a full-path "schedul" match false-positives.
        rel_s = str(rel).lower()
        if "schedul" not in rel_s:
            continue
        if marker(root) in path.read_text(encoding="utf-8", errors="replace"):
            raise Failure("scheduler_clean: scheduled-task record remains")


def check_hook_once(case: dict[str, Any], root: Path) -> None:
    path = root / "home" / "hook-log.txt"
    count = len(path.read_text().splitlines()) if path.exists() else 0
    if count == 0: raise Failure("hook-not-fired")
    if count != 1: raise Failure("hook-repeated")


def check_purpose_present(case: dict[str, Any], root: Path) -> None:
    rows = usage_session(root).get("purposeUsage", {})
    groups = case.get("purpose_any", [])
    if case.get("id") == "session.compaction":
        present = "compact_single" in rows or ("compact_pass1" in rows and "compact_pass2" in rows)
    else:
        present = any(name in rows for name in groups)
    if groups and not present:
        raise Failure("measured-nothing")


def check_lsp_smoke(case: dict[str, Any], root: Path) -> None:
    ok = any(e.get("tool_name") == "lsp" for e in tool_events(root, "tool_completed"))
    text = str(result_obj(root).get("text", "")).lower()
    # Unavailability phrasing the case prompt allows ("say so in one sentence"):
    # either the generic "language server" wording or an explicit "no LSP server…".
    # spark25 often says "No LSP (language server) tool is available… no MCP server".
    unavailable = any(
        phrase in text
        for phrase in (
            "no language server",
            "no lsp server",
            "no lsp tool",
            "no lsp (language",
            "no lsp/diagnostics",
            "no mcp server",
            "no mcp servers",
            "no mcp tools",
            "no mcp/lsp",
            "mcp/lsp server",
            "not available",
            "not configured",
            "no server is configured",
            "none are configured",
        )
    )
    if not ok and not unavailable:
        raise Failure("lsp_smoke: neither completion nor unavailable response")


def check_marker_in_record(case: dict[str, Any], root: Path) -> None:
    content = str(result_obj(root).get("text", ""))
    for name in ("chat_history.jsonl", "updates.jsonl"):
        if (root / name).exists(): content += (root / name).read_text(encoding="utf-8", errors="replace")
    if marker(root) not in content:
        raise Failure("marker_in_record: marker absent")


def check_max_turns(case: dict[str, Any], root: Path) -> None:
    result = result_obj(root)
    stderr = (root / "stderr.log").read_text(encoding="utf-8", errors="replace").lower()
    if result.get("stopReason") != "max_turn_requests" and "max turns" not in stderr:
        raise Failure("max_turns: cap not observed")


def session_dirs(root: Path) -> list[Path]:
    sessions = root / "home" / "sessions"
    return list(sessions.rglob("summary.json")) if sessions.exists() else []


def check_subagent_present(case: dict[str, Any], root: Path) -> None:
    rows = usage_session(root).get("purposeUsage", {})
    if "subagent" not in rows and len(session_dirs(root)) < 2:
        raise Failure("subagent_present: no subagent usage or child session")


def check_subagent_absent(case: dict[str, Any], root: Path) -> None:
    if len(session_dirs(root)) > 1:
        raise Failure("subagent_absent: child session exists")
    if any(canonical_tool(e.get("tool_name")) == "task" and e.get("outcome") == "success" for e in tool_events(root, "tool_completed")):
        raise Failure("subagent_absent: task succeeded")


def check_child_budget(case: dict[str, Any], root: Path) -> None:
    if max(0, len(session_dirs(root)) - 1) > int(case.get("agent_budget", 0)):
        raise Failure("child_budget: exceeded")


def check_worktree_edit(case: dict[str, Any], root: Path) -> None:
    candidates = [p for p in (root / "home").rglob("note.txt") if p.is_file()]
    if not any("DONE-EDIT" in p.read_text(encoding="utf-8", errors="replace") for p in candidates):
        raise Failure("worktree_edit: edited worktree note not found")


def check_acp_result(case: dict[str, Any], root: Path) -> None:
    records = json_lines(root / "stdout.json")
    if not records:
        raise Failure("acp_result: stdout has no JSON-RPC lines")
    if marker(root) not in json.dumps(records, ensure_ascii=False):
        raise Failure("acp_result: turn output lacks marker")
    if not any(isinstance(x, dict) and x.get("id") == 3 and "result" in x for x in records):
        raise Failure("acp_result: no session/prompt response")


CHECKS = {
    "tool_called": check_tool_called, "tool_not_called": check_tool_not_called,
    "file_unchanged": check_file_unchanged, "file_contains": check_file_contains,
    "file_equals": check_file_equals, "file_absent": check_file_absent,
    "text_contains_marker": check_text_contains_marker, "text_contains": check_text_contains,
    "text_nonempty": check_text_nonempty, "usage_honest": check_usage_honest,
    "loop_realtime": check_loop_realtime, "denied": check_denied, "resumed": check_resumed,
    "forked": check_forked, "ordered_tools": check_ordered_tools, "no_session": check_no_session,
    "no_external_http": check_no_external_http, "ssrf_safe": check_ssrf_safe,
    "streaming_json": check_streaming_json,
    "todo_record": check_todo_record, "home_memory": check_home_memory,
    "scheduler_clean": check_scheduler_clean, "hook_once": check_hook_once,
    "purpose_present": check_purpose_present, "lsp_smoke": check_lsp_smoke,
    "marker_in_record": check_marker_in_record, "max_turns": check_max_turns,
    "subagent_present": check_subagent_present, "subagent_absent": check_subagent_absent,
    "child_budget": check_child_budget, "worktree_edit": check_worktree_edit,
    "acp_result": check_acp_result,
}


def score(case: dict[str, Any], root: Path) -> tuple[bool, str]:
    for name in case.get("checks", []):
        fn = CHECKS.get(name)
        if fn is None: raise RuntimeError(f"unknown check: {name}")
        try: fn(case, root)
        except Failure as exc: return False, str(exc)
    return True, "pass"


def self_test() -> None:
    base_case = {"checks": ["usage_honest"]}
    def run_usage(session: dict[str, Any]) -> bool:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "usage.json").write_text(json.dumps(session))
            return score(base_case, Path(tmp))[0]
    row = {"modelCalls": 1, "inputTokens": 2, "outputTokens": 1, "usageMissingCalls": 0,
           "cacheFieldPresent": False, "uncachedInputTokens": 0}
    assert not run_usage({"modelCalls": 1, "inputTokens": 2, "cacheFieldPresent": False, "purposeUsage": {"main_loop": row}})
    row.pop("uncachedInputTokens")
    assert run_usage({"modelCalls": 1, "inputTokens": 2, "cacheFieldPresent": False, "purposeUsage": {"main_loop": row}})
    zero = {"modelCalls": 0, "inputTokens": 0, "outputTokens": 0, "usageMissingCalls": 0, "cacheFieldPresent": False}
    assert not run_usage({"modelCalls": 0, "inputTokens": 0, "cacheFieldPresent": False, "purposeUsage": {"main_loop": zero}})
    zero["usageMissingCalls"] = 1
    assert run_usage({"modelCalls": 0, "inputTokens": 0, "cacheFieldPresent": False, "purposeUsage": {"main_loop": zero}})
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "events.jsonl").write_text(json.dumps({"type":"tool_completed","tool_name":"read_file","outcome":"success"})+"\n")
        (root / "chat_history.jsonl").write_text(json.dumps({"name":"read_file","arguments":{}})+"\n")
        (root / "wire.log").write_text("<tool_call>")
        assert not score({"checks":["tool_called"],"expect_tools":["read_file"]}, root)[0]
        (root / "chat_history.jsonl").write_text(json.dumps({"name":"read_file","arguments":{"target_file":"secret.txt"}})+"\n")
        (root / "wire.log").write_text("")
        assert score({"checks":["tool_called"],"expect_tools":["read_file"]}, root)[0]
    with tempfile.TemporaryDirectory() as tmp:
        # Regression: absolute case path contains tools.scheduler_roundtrip, and
        # home/sessions/.../chat_history.jsonl holds the nonce after a clean delete.
        root = Path(tmp)
        nonce = "MARKER-tools.scheduler_roundtrip-deadbeef"
        (root / "MANIFEST.json").write_text(json.dumps({"case": "tools.scheduler_roundtrip", "nonce": nonce}))
        nested = root / "home" / "sessions" / "tools.scheduler_roundtrip" / "abc"
        nested.mkdir(parents=True)
        (nested / "chat_history.jsonl").write_text(nonce + "\n")
        (root / "updates.jsonl").write_text(nonce + "\n")
        (root / "events.jsonl").write_text("{}\n")
        scase = {"checks": ["scheduler_clean"]}
        store = root / "home" / "scheduled"
        store.mkdir(parents=True, exist_ok=True)
        (store / "placeholder.txt").write_text("no marker\n")
        assert score(scase, root)[0], "session/case-dir noise must not fail scheduler_clean"
        (store / "tasks.json").write_text(nonce + "\n")
        assert not score(scase, root)[0], "marker under home/scheduled must fail scheduler_clean"
    with tempfile.TemporaryDirectory() as tmp:
        # Unavailable LSP wording: "No LSP server is configured" must pass (no lsp tool call).
        root = Path(tmp)
        (root / "stdout.json").write_text(json.dumps({
            "text": "No LSP server is configured in this session, so I cannot retrieve diagnostics.",
            "stopReason": "end_turn",
        }))
        (root / "events.jsonl").write_text("{}\n")
        assert score({"checks": ["lsp_smoke"]}, root)[0], "no-lsp-server phrasing must pass"
        # spark25 live wording from tools.lsp_smoke
        (root / "stdout.json").write_text(json.dumps({
            "text": "No LSP (language server) tool is available in this session — no MCP server is connected, so I cannot request diagnostics on `lib.rs`.",
            "stopReason": "end_turn",
        }))
        assert score({"checks": ["lsp_smoke"]}, root)[0], "no-lsp-tool phrasing must pass"
        # mimo26 live wording from tools.lsp_smoke
        (root / "stdout.json").write_text(json.dumps({
            "text": "No LSP/diagnostics server is configured in this session, so diagnostics were not performed.",
            "stopReason": "end_turn",
        }))
        assert score({"checks": ["lsp_smoke"]}, root)[0], "no-lsp/diagnostics phrasing must pass"
        (root / "stdout.json").write_text(json.dumps({
            "text": "No MCP tools are available in this session, so I can't query an LSP server.",
            "stopReason": "end_turn",
        }))
        assert score({"checks": ["lsp_smoke"]}, root)[0], "no-mcp-tools phrasing must pass"
        # mimo26: "No MCP/LSP server is configured…"
        (root / "stdout.json").write_text(json.dumps({
            "text": "No MCP/LSP server is configured in this session — I have no diagnostic tool to run against `lib.rs`.",
            "stopReason": "end_turn",
        }))
        assert score({"checks": ["lsp_smoke"]}, root)[0], "no-mcp/lsp phrasing must pass"
        (root / "stdout.json").write_text(json.dumps({
            "text": "Diagnostics unavailable for other reasons.",
            "stopReason": "end_turn",
        }))
        assert not score({"checks": ["lsp_smoke"]}, root)[0], "unrelated prose must still fail"
    with tempfile.TemporaryDirectory() as tmp:
        # Spec § agents.workflow_live: nonce may live in the workflow result when top-level text is empty/garbled.
        root = Path(tmp)
        nonce = "MARKER-agents.workflow_live-cafebabe"
        (root / "MANIFEST.json").write_text(json.dumps({"case": "agents.workflow_live", "nonce": nonce}))
        (root / "stdout.json").write_text(json.dumps({"text": "started only", "stopReason": "end_turn"}))
        (root / "events.jsonl").write_text("{}\n")
        scase = {"checks": ["text_contains_marker"]}
        assert not score(scase, root)[0], "text-only fail without workflow result"
        wf = root / "session" / "workflows" / "wf_x"
        wf.mkdir(parents=True)
        (wf / "state.json").write_text(json.dumps({
            "state": {"result_summary": json.dumps({"output": nonce})}
        }))
        assert score(scase, root)[0], "workflow result_summary must satisfy the marker check"
        (root / "stdout.json").write_text(json.dumps({"text": f"done {nonce}", "stopReason": "end_turn"}))
        assert score(scase, root)[0]
        # max_tokens after a finished workflow: empty text, nonce only in result_summary;
        # tool_called still sees the parent workflow completion once copy_session prefers
        # the workflows-bearing session. run.sh fails on nonzero exit; this fixture only
        # locks the score.py oracle.
        (root / "stdout.json").write_text(json.dumps({
            "type": "error",
            "message": "response truncated by max_tokens",
            "text": "",
            "stopReason": "max_tokens",
        }))
        (root / "events.jsonl").write_text(
            json.dumps({"type": "tool_completed", "tool_name": "workflow", "outcome": "success"}) + "\n"
        )
        full = {"checks": ["tool_called", "text_contains_marker"], "expect_tools": ["workflow"]}
        assert score(full, root)[0], "workflow_live must score from state.json after max_tokens"
        # Child-only events (no workflow) must still fail tool_called.
        (root / "events.jsonl").write_text(
            json.dumps({"type": "tool_completed", "tool_name": "read_file", "outcome": "success"}) + "\n"
        )
        assert not score(full, root)[0], "child events without workflow must not pass"
    print("score.py self-test: pass")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("case", nargs="?", type=Path)
    parser.add_argument("case_dir", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test(); return
    if not args.case or not args.case_dir: parser.error("case and case_dir are required")
    case = load_json(args.case)
    if not isinstance(case, dict): raise SystemExit("invalid case JSON")
    try: ok, reason = score(case, args.case_dir)
    except RuntimeError as exc: print(f"HARNESS {exc}"); raise SystemExit(2)
    print("pass" if ok else f"fail {reason}")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
