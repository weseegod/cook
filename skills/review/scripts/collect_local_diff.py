#!/usr/bin/env python3
"""Collect a local (staged + unstaged + untracked) unified diff.

Non-mutating. ``git diff --no-index`` exits 1 when files differ; this helper
treats that as success. Works on Windows (no ``/dev/null``, no ``read -d ''``).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def _run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(prog="collect_local_diff.py")
    parser.add_argument("--diff", required=True, help="Output unified-diff path.")
    parser.add_argument("--files", required=True, help="Output changed-files list.")
    args = parser.parse_args()

    inside = _run(["git", "rev-parse", "--is-inside-work-tree"])
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        print("collect_local_diff.py: cwd is not a git work tree", file=sys.stderr)
        return 2

    diff_path = Path(args.diff)
    files_path = Path(args.files)
    diff_path.parent.mkdir(parents=True, exist_ok=True)

    chunks: list[str] = []
    names: list[str] = []

    has_head = _run(["git", "rev-parse", "--verify", "--quiet", "HEAD"]).returncode == 0
    if has_head:
        tracked = _run(["git", "-c", "core.quotepath=false", "diff", "HEAD"])
        if tracked.returncode not in (0, 1):
            sys.stderr.write(tracked.stderr)
            return tracked.returncode
        chunks.append(tracked.stdout)
        named = _run(["git", "-c", "core.quotepath=false", "diff", "--name-only", "HEAD"])
        names.extend(line for line in named.stdout.splitlines() if line)

    untracked = _run(["git", "ls-files", "--others", "--exclude-standard", "-z"])
    if untracked.returncode != 0:
        sys.stderr.write(untracked.stderr)
        return untracked.returncode

    empty = os.devnull
    for rel in untracked.stdout.split("\0"):
        if not rel:
            continue
        names.append(rel)
        piece = _run(
            ["git", "-c", "core.quotepath=false", "diff", "--no-index", "--", empty, rel]
        )
        # 0 = identical (shouldn't happen), 1 = differ (expected), else error.
        if piece.returncode not in (0, 1):
            sys.stderr.write(piece.stderr)
            continue
        chunks.append(piece.stdout)

    # Preserve order, drop duplicates.
    seen: set[str] = set()
    unique: list[str] = []
    for name in names:
        if name not in seen:
            seen.add(name)
            unique.append(name)

    text = "".join(chunks)
    diff_path.write_text(text, encoding="utf-8", errors="replace")
    files_path.write_text("\n".join(unique) + ("\n" if unique else ""), encoding="utf-8")

    payload = {
        "bytes": diff_path.stat().st_size,
        "files": unique,
        "empty": not unique,
    }
    json.dump(payload, sys.stdout, indent=None, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
