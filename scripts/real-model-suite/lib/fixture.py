#!/usr/bin/env python3
"""Create deterministic throwaway repositories for real-model suite cases."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def write(root: Path, name: str, text: str, executable: bool = False) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def files_for(case: str, marker: str, file_bytes: int) -> dict[str, str]:
    simple_secret = {
        "sampler.xml_arguments", "tools.read_file", "tools.bash", "tools.write_new",
        "tools.update_goal", "tools.kill_and_wait", "tools.monitor_short",
        "tools.scheduler_roundtrip", "tools.memory_roundtrip", "session.resume",
        "session.resume_by_id", "session.fork", "session.permissions_deny_bash",
        "session.memory_flush", "session.hooks", "session.streaming_json", "agents.subagent_read",
        "agents.no_subagents_flag", "agents.mcp_echo", "agents.acp_stdio",
        "agents.opencode_read", "tools.unknown_and_sibling",
    }
    out: dict[str, str] = {}
    if case in simple_secret:
        out["secret.txt"] = marker + "\n"
    if case == "tools.read_file":
        out["other.txt"] = marker.replace("MARKER-", "OTHER-") + "\n"
    if case == "tools.read_file_range":
        out["secret.txt"] = "".join(marker + "\n" if i == 20 else f"line-{i:02d}\n" for i in range(1, 41))
    if case == "tools.list_dir":
        out.update({name: name + "\n" for name in ("alpha.txt", "beta.txt", "gamma.txt")})
    if case == "tools.grep":
        out["nested/note.txt"] = "ordinary\n" + marker + "\ntrailer\n"
        out["unrelated.txt"] = "nothing here\n"
    if case in {"tools.search_replace", "tools.serial_edit_read", "session.permissions_read_only",
                "session.worktree", "agents.codex_apply_patch", "agents.hashline_edit",
                "session.max_turns"}:
        out["note.txt"] = "first\nREPLACE_ME\nlast\n"
    if case == "session.max_turns":
        out["secret.txt"] = marker + "\n"
    if case == "tools.parallel_reads":
        for i in range(1, 4):
            out[f"secret{i}.txt"] = f"{marker}-{i}\n"
    if case == "session.compaction":
        filler = "abcdefghij" * ((file_bytes // 10) + 1)
        for i in range(1, 13):
            special = f"{marker}-FIRST" if i == 1 else (f"{marker}-LAST" if i == 12 else f"file-{i:02d}")
            body = special + "\n" + filler
            out[f"corpus/{i:02d}.txt"] = body[:file_bytes - 1] + "\n"
    if case == "agents.workflow_validate":
        out["script.rhai"] = 'let meta = #{ name: "suite-validate", description: "validate only" };\nlet answer = "ok";\n'
    if case == "agents.workflow_live":
        out["secret.txt"] = marker + "\n"
        out["script.rhai"] = (
            'let meta = #{ name: "suite-live", description: "one child" };\n'
            'let result = agent(`Read secret.txt and return its exact line.`);\nresult\n'
        )
    if case == "tools.web_fetch_public":
        out["served/body.txt"] = marker + "\n"
    if case == "tools.lsp_smoke":
        out["lib.rs"] = "fn main() {}\n"
    if not out:
        out["README.txt"] = "real-model suite fixture\n"
    return out


def snapshot(root: Path) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and ".git" not in path.parts:
            result[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("case")
    parser.add_argument("workdir", type=Path)
    parser.add_argument("nonce")
    parser.add_argument("--file-bytes", type=int, default=8000)
    args = parser.parse_args()
    root = args.workdir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    for name, contents in files_for(args.case, args.nonce, args.file_bytes).items():
        write(root, name, contents)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Real Model Suite"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "suite@example.com"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture"], check=True)
    manifest = {"case": args.case, "nonce": args.nonce, "files": snapshot(root)}
    (root.parent / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
