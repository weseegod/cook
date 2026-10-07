#!/usr/bin/env python3
"""Cross-platform host helpers for bundled orchestrator skills.

Stdlib only. Works on Windows, macOS, and Linux. Resolves a real Python
(rejecting the Microsoft Store stub), a per-user scratch dir, and a short
run id so skills never need ``python3``, ``umask``, ``id -u``, or ``/tmp``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
import tempfile
import uuid
from pathlib import Path


def _is_store_stub(path: str) -> bool:
    return "WindowsApps" in path.replace("\\", "/")


def resolve_python() -> str:
    """Return an absolute Python 3 executable that is not a Store stub."""
    # Prefer the interpreter running this file when it is already good.
    current = sys.executable or ""
    if current and not _is_store_stub(current):
        return current

    candidates: list[list[str]] = [["python"], ["py", "-3"], ["python3"]]
    for argv in candidates:
        found = shutil.which(argv[0])
        if not found or _is_store_stub(found):
            continue
        return found
    raise SystemExit(
        "host.py: no real Python 3 on PATH "
        "(tried python, py -3, python3; rejected WindowsApps stubs)"
    )


def scratch_dir() -> Path:
    user = os.environ.get("USERNAME") or os.environ.get("USER") or "user"
    # Keep the name filesystem-safe on Windows and POSIX.
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in user) or "user"
    path = Path(tempfile.gettempdir()) / f"grok-{safe}"
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, stat.S_IRWXU)
    except OSError:
        pass
    return path


def run_id(hex_len: int = 8) -> str:
    if hex_len <= 0:
        raise SystemExit("host.py: hex_len must be > 0")
    return uuid.uuid4().hex[:hex_len]


def cmd_setup(_args: argparse.Namespace) -> int:
    payload = {
        "python": resolve_python(),
        "scratch_dir": str(scratch_dir()),
        "run_id": run_id(8),
    }
    json.dump(payload, sys.stdout, indent=None, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


def cmd_uuid(args: argparse.Namespace) -> int:
    if args.full:
        sys.stdout.write(str(uuid.uuid4()) + "\n")
    else:
        sys.stdout.write(run_id(args.hex_len) + "\n")
    return 0


def cmd_scratch(_args: argparse.Namespace) -> int:
    sys.stdout.write(str(scratch_dir()) + "\n")
    return 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    for raw in args.paths:
        try:
            Path(raw).unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            print(f"host.py: could not remove {raw}: {exc}", file=sys.stderr)
    return 0


def cmd_git_cwd(_args: argparse.Namespace) -> int:
    import subprocess

    result = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or result.stdout.strip() != "true":
        print("host.py: cwd is not a git work tree", file=sys.stderr)
        return 1
    print("true")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="host.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("setup", help="Print JSON {python, scratch_dir, run_id}.")
    u = sub.add_parser("uuid", help="Print a UUID (default: 8 hex chars).")
    u.add_argument("--full", action="store_true", help="Print a full UUID4.")
    u.add_argument("--hex-len", type=int, default=8)
    sub.add_parser("scratch", help="Create and print the per-user scratch dir.")
    c = sub.add_parser("cleanup", help="Unlink files; missing paths are ok.")
    c.add_argument("paths", nargs="+")
    sub.add_parser("git-cwd", help="Exit 0 if cwd is a git work tree.")

    args = parser.parse_args(argv)
    handlers = {
        "setup": cmd_setup,
        "uuid": cmd_uuid,
        "scratch": cmd_scratch,
        "cleanup": cmd_cleanup,
        "git-cwd": cmd_git_cwd,
    }
    return handlers[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
