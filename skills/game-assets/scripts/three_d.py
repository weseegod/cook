#!/usr/bin/env python3
"""Image-to-3D client for the xAI `/v1/3d` API.

Stdlib only. Authenticates with the Grok Build OAuth session in `auth.json`
and never prints the bearer. Subcommands: auth, models, generate, poll.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_BASE_URL = "https://api.x.ai/v1"
DEFAULT_MODEL = "grok-imagine-3d"
USER_AGENT = "xai-grok-build-skill/game-assets"
GLB_MAGIC = b"glTF"


def grok_home() -> Path:
    return Path(os.environ.get("GROK_HOME") or Path.home() / ".cook")


def auth_json_path() -> Path:
    return Path(os.environ.get("GROK_AUTH_PATH") or grok_home() / "auth.json")


def parse_rfc3339(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def resolve_bearer() -> tuple[str, dict]:
    """Return (token, info). `info` is safe to print: it never contains the token."""
    path = auth_json_path()
    try:
        store = json.loads(path.read_text())
    except FileNotFoundError:
        fail(f"{path} not found; run `grok login`")
    except (OSError, json.JSONDecodeError) as e:
        fail(f"cannot read {path}: {e}")

    # Prefer the newest session; auth.json can hold one entry per issuer/client.
    entries = sorted(
        (v for v in store.values() if isinstance(v, dict) and v.get("key")),
        key=lambda v: v.get("create_time", ""),
        reverse=True,
    )
    if not entries:
        fail(f"{path} holds no session; run `grok login`")
    entry = entries[0]

    expires_at = parse_rfc3339(entry.get("expires_at", "") or "")
    now = datetime.now(timezone.utc)
    if expires_at is not None and expires_at <= now:
        fail(
            f"OAuth session in {path} expired at {expires_at.isoformat()}. The Grok Build "
            "client refreshes it on use: send any message in a running `grok` session, "
            "or run `grok login`, then retry. (This script never refreshes tokens itself: "
            "a concurrent refresh would rotate the refresh token under the client.)"
        )

    info = {
        "source": str(path),
        "auth_mode": entry.get("auth_mode"),
        "email": entry.get("email"),
        "team_id": entry.get("team_id"),
        "team_name": entry.get("team_name"),
        "expires_in_s": int((expires_at - now).total_seconds()) if expires_at else None,
    }
    return entry["key"], info


def fail(msg: str, code: int = 1) -> None:
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(code)


class Api:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token, self.info = resolve_bearer()

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        # A gateway-level 404 means the request never reached the API, so retrying is safe
        # for every verb.
        for attempt in range(3):
            status, payload = self._request_once(method, path, body)
            if not is_gateway_404(status, payload):
                return status, payload
            print(json.dumps({"retry": attempt + 1, "reason": "transient gateway 404"}), file=sys.stderr)
            time.sleep(1.0)
        return status, payload

    def _request_once(self, method: str, path: str, body: dict | None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                # Marks the call as first-party Build traffic so the data-retention
                # opt-out applies, matching the built-in image tools.
                "x-grok-client-identifier": os.environ.get("GROK_CLIENT_NAME", "grok-shell"),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"raw": raw[:500].decode(errors="replace")}
            return e.code, payload
        except urllib.error.URLError as e:
            fail(f"{method} {path}: {e.reason}")


def is_gateway_404(status: int, payload: dict) -> bool:
    """The API's own 404 is `{"code": "not-found", ...}`; the gateway's nests `{"error": {"code": 404}}`."""
    err = payload.get("error")
    return status == 404 and isinstance(err, dict) and err.get("code") == 404


def image_to_url(spec: str) -> str:
    if spec.startswith(("http://", "https://", "data:")):
        return spec
    p = Path(spec)
    if not p.is_file():
        fail(f"image not found: {spec}")
    mime = mimetypes.guess_type(p.name)[0]
    if mime not in {"image/jpeg", "image/png", "image/webp"}:
        fail(f"{spec}: unsupported type {mime}; use JPEG, PNG or WebP")
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"


def download_glb(url: str, out: Path) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as resp:
        blob = resp.read()
    if len(blob) < 12 or blob[:4] != GLB_MAGIC:
        fail("download is not a GLB file")
    if int.from_bytes(blob[8:12], "little") != len(blob):
        fail("downloaded GLB length does not match its header")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    return {"path": str(out), "bytes": len(blob)}


def poll_until_done(api: Api, request_id: str, interval: float, timeout: float) -> tuple[int, dict]:
    deadline = time.monotonic() + timeout
    while True:
        status, body = api.request("GET", f"/3d/{request_id}")
        if status not in (200, 202) or body.get("status") in ("done", "failed"):
            return status, body
        if time.monotonic() >= deadline:
            return status, {**body, "client_timeout": True}
        print(json.dumps({"status": body.get("status"), "progress": body.get("progress")}), file=sys.stderr)
        time.sleep(interval)


def cmd_auth(args: argparse.Namespace) -> None:
    _, info = resolve_bearer()
    print(json.dumps({"base_url": args.base_url, **info}, indent=2))


def cmd_models(args: argparse.Namespace) -> None:
    api = Api(args.base_url)
    path = f"/3d-generation-models/{args.model}" if args.model else "/3d-generation-models"
    status, body = api.request("GET", path)
    print(json.dumps({"http": status, **body}, indent=2))
    sys.exit(0 if status == 200 else 2)


def generation_result(status: int, body: dict) -> dict:
    result = {"http": status}
    for key in ("status", "error", "code", "message", "raw", "client_timeout"):
        if key in body:
            result[key] = body[key]
    if body.get("status") == "done":
        result["asset"] = {"url": body["asset"]["url"]}
        if "size_bytes" in body["asset"]:
            result["asset"]["size_bytes"] = body["asset"]["size_bytes"]
    return result


def cmd_generate(args: argparse.Namespace) -> None:
    api = Api(args.base_url)
    payload: dict = {"model": args.model, "image": {"url": image_to_url(args.image)}}
    if args.seed is not None:
        payload["seed"] = args.seed
    if args.store:
        if not args.store.endswith(".glb"):
            fail("--store filename must end in .glb")
        payload["storage_options"] = {"filename": args.store}
    if args.user:
        payload["user"] = args.user

    status, body = api.request("POST", "/3d/generations", payload)
    if status != 200 or "request_id" not in body:
        print(json.dumps(generation_result(status, body), indent=2))
        sys.exit(2)
    request_id = body["request_id"]
    print(json.dumps({"request_id": request_id}), file=sys.stderr)
    if args.no_wait:
        print(json.dumps({"request_id": request_id}, indent=2))
        return
    finish(api, request_id, args)


def cmd_poll(args: argparse.Namespace) -> None:
    finish(Api(args.base_url), args.request_id, args)


def finish(api: Api, request_id: str, args: argparse.Namespace) -> None:
    status, body = poll_until_done(api, request_id, args.interval, args.timeout)
    result = generation_result(status, body)
    if body.get("status") == "done" and args.out:
        result["download"] = download_glb(body["asset"]["url"], Path(args.out))
    print(json.dumps(result, indent=2))
    sys.exit(0 if body.get("status") == "done" else 2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("XAI_API_BASE_URL", DEFAULT_BASE_URL))
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("auth", help="show which credential would be used (never the token)").set_defaults(fn=cmd_auth)

    p = sub.add_parser("models", help="GET /v1/3d-generation-models[/{model}]")
    p.add_argument("model", nargs="?")
    p.set_defaults(fn=cmd_models)

    def add_poll_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--out", help="write the finished .glb here")
        p.add_argument("--interval", type=float, default=5.0)
        p.add_argument("--timeout", type=float, default=660.0, help="seconds to wait for done/failed")

    p = sub.add_parser("generate", help="POST /v1/3d/generations, then poll")
    p.add_argument("--image", required=True, help="local JPEG/PNG/WebP, https URL, or data URL")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--seed", type=int)
    p.add_argument("--store", help="also store via Files API under this .glb filename")
    p.add_argument("--user", help="end-user identifier")
    p.add_argument("--no-wait", action="store_true", help="print request_id and exit")
    add_poll_args(p)
    p.set_defaults(fn=cmd_generate)

    p = sub.add_parser("poll", help="GET /v1/3d/{request_id} until done or failed")
    p.add_argument("request_id")
    add_poll_args(p)
    p.set_defaults(fn=cmd_poll)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
