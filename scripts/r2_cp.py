#!/usr/bin/env python3
"""Copy files to/from Cloudflare R2 (S3-compatible) using stdlib SigV4.

Env (same as scripts/publish-release-to-r2.sh). GitHub secrets use
COOK_RELEASES_R2_*; local `.env` may use COOK_S3_* aliases.

  COOK_RELEASES_R2_ENDPOINT / COOK_S3_ENDPOINT
  COOK_RELEASES_R2_ACCESS_KEY_ID / COOK_S3_ACCESS_KEY
  COOK_RELEASES_R2_SECRET_ACCESS_KEY / COOK_S3_SECRET_KEY
  COOK_RELEASES_R2_BUCKET / COOK_S3_BUCKET     default cook-releases
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()

# Prefer IPv4. On some networks (including this release runner) AAAA/IPv6 to
# Cloudflare R2 sits in SYN-SENT forever while A/IPv4 works.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_getaddrinfo(
    host: str | bytes | None,
    port: str | bytes | int | None,
    family: int = 0,
    type: int = 0,
    proto: int = 0,
    flags: int = 0,
):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_getaddrinfo  # type: ignore[assignment]


def _first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def _require_env() -> tuple[str, str, str, str]:
    endpoint = _first_env("COOK_RELEASES_R2_ENDPOINT", "COOK_S3_ENDPOINT").rstrip("/")
    access = _first_env("COOK_RELEASES_R2_ACCESS_KEY_ID", "COOK_S3_ACCESS_KEY")
    secret = _first_env("COOK_RELEASES_R2_SECRET_ACCESS_KEY", "COOK_S3_SECRET_KEY")
    bucket = _first_env("COOK_RELEASES_R2_BUCKET", "COOK_S3_BUCKET", default="cook-releases")
    missing = [
        name
        for name, val in (
            ("COOK_RELEASES_R2_ENDPOINT", endpoint),
            ("COOK_RELEASES_R2_ACCESS_KEY_ID", access),
            ("COOK_RELEASES_R2_SECRET_ACCESS_KEY", secret),
        )
        if not val
    ]
    if missing:
        raise SystemExit(f"error: missing {', '.join(missing)}")
    return endpoint, access, secret, bucket


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _uri_encode(path: str, *, is_key: bool) -> str:
    safe = "/" if is_key else ""
    return urllib.parse.quote(path, safe=safe)


def _canonical_query(query: str) -> str:
    if not query:
        return ""
    parts = []
    for item in query.split("&"):
        if "=" in item:
            k, v = item.split("=", 1)
        else:
            k, v = item, ""
        parts.append((_uri_encode(urllib.parse.unquote(k), is_key=False), _uri_encode(urllib.parse.unquote(v), is_key=False)))
    parts.sort()
    return "&".join(f"{k}={v}" for k, v in parts)


def signed_request(
    method: str,
    url: str,
    *,
    access: str,
    secret: str,
    region: str = "auto",
    service: str = "s3",
    payload: bytes = b"",
    payload_hash: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> urllib.request.Request:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc
    canonical_uri = _uri_encode(parsed.path or "/", is_key=True)
    canonical_query = _canonical_query(parsed.query)
    now = dt.datetime.now(dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = payload_hash or hashlib.sha256(payload).hexdigest()
    headers = {
        "host": host,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
    }
    if extra_headers:
        for key, value in extra_headers.items():
            headers[key.lower()] = value
    signed_keys = sorted(headers)
    canonical_headers = "".join(f"{k}:{headers[k].strip()}\n" for k in signed_keys)
    signed_headers = ";".join(signed_keys)
    canonical_request = (
        f"{method}\n{canonical_uri}\n{canonical_query}\n"
        f"{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
    scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = (
        f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n"
        f"{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
    )
    k_date = _sign(f"AWS4{secret}".encode("utf-8"), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    k_signing = _sign(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    # Host is set by urllib from the URL.
    req_headers = {k: v for k, v in headers.items() if k != "host"}
    data = payload if method in {"PUT", "POST"} else None
    return urllib.request.Request(url, data=data, method=method, headers=req_headers)


def _call(req: urllib.request.Request) -> bytes:
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"error: R2 {req.get_method()} {req.full_url} -> {exc.code}: {detail}") from exc


def object_url(endpoint: str, bucket: str, key: str) -> str:
    # Raw path; SigV4 encodes the URI. Do not pre-quote or signing double-encodes.
    return f"{endpoint}/{bucket}/{key.lstrip('/')}"


def put_object(local: Path, key: str, *, content_type: str, cache_control: str) -> None:
    endpoint, access, secret, bucket = _require_env()
    key = key.lstrip("/")
    body = local.read_bytes()
    extra = {
        "content-type": content_type,
        "cache-control": cache_control,
        "content-length": str(len(body)),
    }
    req = signed_request(
        "PUT",
        object_url(endpoint, bucket, key),
        access=access,
        secret=secret,
        payload=body,
        extra_headers=extra,
    )
    _call(req)
    print(f"  put s3://{bucket}/{key} ({len(body)} bytes)")


def delete_object(key: str) -> None:
    endpoint, access, secret, bucket = _require_env()
    key = key.lstrip("/")
    req = signed_request(
        "DELETE",
        object_url(endpoint, bucket, key),
        access=access,
        secret=secret,
        payload_hash=EMPTY_SHA256,
    )
    _call(req)
    print(f"  delete s3://{bucket}/{key}")


def get_object(key: str, dest: Path) -> None:
    endpoint, access, secret, bucket = _require_env()
    key = key.lstrip("/")
    req = signed_request(
        "GET",
        object_url(endpoint, bucket, key),
        access=access,
        secret=secret,
        payload_hash=EMPTY_SHA256,
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            size = 0
            with dest.open("wb") as out:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    size += len(chunk)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"error: R2 GET {req.full_url} -> {exc.code}: {detail}") from exc
    print(f"  get s3://{bucket}/{key} -> {dest} ({size} bytes)")


def copy_object(src_key: str, dest_key: str, *, content_type: str, cache_control: str) -> None:
    """Server-side copy within the same bucket (S3 CopyObject)."""
    endpoint, access, secret, bucket = _require_env()
    src_key = src_key.lstrip("/")
    dest_key = dest_key.lstrip("/")
    # CopySource is "/bucket/key"; path segments must be URI-encoded.
    copy_source = f"/{bucket}/{_uri_encode(src_key, is_key=True)}"
    extra = {
        "x-amz-copy-source": copy_source,
        "x-amz-metadata-directive": "REPLACE",
        "content-type": content_type,
        "cache-control": cache_control,
    }
    req = signed_request(
        "PUT",
        object_url(endpoint, bucket, dest_key),
        access=access,
        secret=secret,
        payload_hash=EMPTY_SHA256,
        extra_headers=extra,
    )
    _call(req)
    print(f"  copy s3://{bucket}/{src_key} -> s3://{bucket}/{dest_key}")


def _strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def list_keys(prefix: str) -> list[str]:
    endpoint, access, secret, bucket = _require_env()
    prefix = prefix.lstrip("/")
    keys: list[str] = []
    token: str | None = None
    while True:
        query = {
            "list-type": "2",
            "prefix": prefix,
        }
        if token:
            query["continuation-token"] = token
        qs = urllib.parse.urlencode(query)
        url = f"{endpoint}/{bucket}?{qs}"
        req = signed_request(
            "GET",
            url,
            access=access,
            secret=secret,
            payload_hash=EMPTY_SHA256,
        )
        xml = _call(req)
        root = ET.fromstring(xml)
        truncated = False
        next_token = None
        for child in root:
            name = _strip_ns(child.tag)
            if name == "IsTruncated":
                truncated = (child.text or "").lower() == "true"
            elif name == "NextContinuationToken":
                next_token = child.text
            elif name == "Contents":
                for inner in child:
                    if _strip_ns(inner.tag) == "Key" and inner.text:
                        keys.append(inner.text)
        if truncated and next_token:
            token = next_token
            continue
        break
    return keys


def get_prefix(prefix: str, dest_dir: Path) -> list[Path]:
    endpoint, access, secret, bucket = _require_env()
    full_prefix = prefix.lstrip("/")
    if full_prefix and not full_prefix.endswith("/"):
        full_prefix += "/"
    keys = list_keys(full_prefix)
    if not keys:
        raise SystemExit(f"error: no objects under s3://{bucket}/{full_prefix}")
    dest_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for key in keys:
        if key.endswith("/"):
            continue
        rel = key[len(full_prefix) :] if key.startswith(full_prefix) else Path(key).name
        rel = rel.lstrip("/") or Path(key).name
        path = dest_dir / Path(rel).name
        get_object(key, path)
        written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_put = sub.add_parser("put", help="upload a local file")
    p_put.add_argument("local")
    p_put.add_argument("key")
    p_put.add_argument("--content-type", default="application/octet-stream")
    p_put.add_argument("--cache-control", default="public, max-age=31536000, immutable")

    p_get = sub.add_parser("get", help="download one object")
    p_get.add_argument("key")
    p_get.add_argument("local")

    p_del = sub.add_parser("delete", help="delete one object")
    p_del.add_argument("key")

    p_list = sub.add_parser("list", help="list object keys under a prefix")
    p_list.add_argument("prefix")

    p_prefix = sub.add_parser("get-prefix", help="download every object under a prefix")
    p_prefix.add_argument("prefix")
    p_prefix.add_argument("dest_dir")

    p_copy = sub.add_parser("copy", help="server-side copy within the bucket")
    p_copy.add_argument("src_key")
    p_copy.add_argument("dest_key")
    p_copy.add_argument("--content-type", default="application/octet-stream")
    p_copy.add_argument("--cache-control", default="public, max-age=31536000, immutable")

    args = parser.parse_args(argv)
    if args.cmd == "put":
        put_object(Path(args.local), args.key, content_type=args.content_type, cache_control=args.cache_control)
    elif args.cmd == "get":
        get_object(args.key, Path(args.local))
    elif args.cmd == "delete":
        delete_object(args.key)
    elif args.cmd == "list":
        for key in list_keys(args.prefix):
            print(key)
    elif args.cmd == "get-prefix":
        get_prefix(args.prefix, Path(args.dest_dir))
    elif args.cmd == "copy":
        copy_object(
            args.src_key,
            args.dest_key,
            content_type=args.content_type,
            cache_control=args.cache_control,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
