#!/usr/bin/env python3
"""Minimal tree-aligned ACP stdio client used by agents.acp_stdio."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    proc = subprocess.Popen(
        [args.binary, "agent", "-m", args.model, "--always-approve", "stdio"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True,
        cwd=args.cwd, env=os.environ.copy(), bufsize=1,
    )
    assert proc.stdin and proc.stdout

    def send(value: dict) -> None:
        proc.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        proc.stdin.flush()

    def request(rid: int, method: str, params: dict) -> None:
        send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})

    deadline = time.monotonic() + args.timeout
    request(1, "initialize", {})
    stage = "initialize"
    session_id = ""
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise SystemExit(f"ACP agent exited {proc.returncode}")
            continue
        line = line.rstrip("\n")
        print(line, flush=True)
        try: message = json.loads(line)
        except json.JSONDecodeError: continue
        if "method" in message and "id" in message:
            method = message["method"]
            if method == "session/request_permission":
                send({"jsonrpc":"2.0","id":message["id"],"result":{"outcome":{"outcome":"selected","optionId":"allow_always"}}})
            elif method == "fs/read_text_file":
                path = message.get("params", {}).get("path", "")
                try: content = open(path, encoding="utf-8").read()
                except OSError: content = ""
                send({"jsonrpc":"2.0","id":message["id"],"result":{"content":content}})
            else:
                send({"jsonrpc":"2.0","id":message["id"],"result":{}})
            continue
        if message.get("id") == 1 and stage == "initialize":
            request(2, "session/new", {"cwd": args.cwd, "mcpServers": [], "_meta": {"yoloMode": True}})
            stage = "new"
        elif message.get("id") == 2 and stage == "new":
            session_id = str(message.get("result", {}).get("sessionId", ""))
            if not session_id: raise SystemExit("session/new returned no sessionId")
            request(3, "session/prompt", {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": args.prompt}],
            })
            stage = "prompt"
        elif message.get("id") == 3 and stage == "prompt":
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: proc.kill()
            return
    proc.kill()
    raise SystemExit("ACP driver timeout")


if __name__ == "__main__":
    main()
