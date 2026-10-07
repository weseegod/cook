#!/usr/bin/env python3
"""Local reverse proxy that pins OpenRouter provider routing on chat requests.

Cook and the shared evaluate harness do not send OpenRouter's request-body
`provider` object. This proxy sits in front of the upstream OpenAI-compatible
API and injects:

  "provider": {"only": ["<slug>"], "allow_fallbacks": false}

into POST /v1/chat/completions (and /chat/completions) JSON bodies so a model
flag like `--model deepseek/deepseek-v4.1-flash:relace` can force Relace only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import tomllib
from http.client import HTTPConnection, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

HOP_BY_HOP = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection',
    'content-length', 'host',
}
CHAT_SUFFIXES = ('/chat/completions', '/v1/chat/completions')


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)

    serve = sub.add_parser('serve', help='run the provider-pin reverse proxy')
    serve.add_argument('--upstream', required=True, help='upstream OpenAI-compatible base URL')
    serve.add_argument('--only', action='append', required=True, help='OpenRouter provider slug (repeatable)')
    serve.add_argument('--allow-fallbacks', choices=('true', 'false'), default='false')
    serve.add_argument('--bind', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=0)

    resolve = sub.add_parser('resolve-openrouter', help='fill EVAL_* from ~/.cook openrouter when needed')
    resolve.add_argument('--model', required=True, help='wire model id without :provider suffix')
    resolve.add_argument('--config', default=str(Path.home() / '.cook' / 'config.toml'))

    sub.add_parser('self-test', help='offline checks for provider injection and openrouter resolve')
    return parser.parse_args(list(argv) if argv is not None else None)


def first(*values):
    return next((value for value in values if value not in (None, '')), '')


def resolve_openrouter(model: str, config_path: str) -> int:
    """Print base_url, wire, api_key as NUL-separated fields for the harness."""
    try:
        config = tomllib.loads(Path(config_path).read_text())
    except (OSError, tomllib.TOMLDecodeError):
        config = {}

    models = config.get('model', {})
    entry = models.get(model)
    if not isinstance(entry, dict):
        matches = [value for value in models.values()
                   if isinstance(value, dict) and value.get('model') == model]
        entry = matches[0] if len(matches) == 1 else {}

    provider_name = entry.get('model_provider') if isinstance(entry, dict) else None
    providers = config.get('model_providers', {})
    provider = providers.get(provider_name, {}) if isinstance(provider_name, str) else {}
    if not isinstance(provider, dict):
        provider = {}

    openrouter = providers.get('openrouter', {})
    if not isinstance(openrouter, dict):
        openrouter = {}

    # Prefer an explicit model entry; otherwise fall back to the openrouter provider
    # so `--model org/slug:provider` works without a dedicated [model.*] block.
    if entry:
        base_url = first(entry.get('base_url'), provider.get('base_url'))
        wire = first(entry.get('model'), model)
        api_key = first(entry.get('api_key'), provider.get('api_key'))
        env_keys = first(entry.get('env_key'), provider.get('env_key'))
    else:
        base_url = first(openrouter.get('base_url'), 'https://openrouter.ai/api/v1')
        wire = model
        api_key = first(openrouter.get('api_key'))
        env_keys = first(openrouter.get('env_key'))
        if not openrouter:
            print('openrouter provider is not configured in cook config', file=sys.stderr)
            return 2

    if not api_key:
        for name in ([env_keys] if isinstance(env_keys, str) else env_keys or []):
            if isinstance(name, str) and os.environ.get(name):
                api_key = os.environ[name]
                break

    if not base_url:
        print(f'no base_url resolved for {model}', file=sys.stderr)
        return 2

    sys.stdout.buffer.write(b'\0'.join(value.encode() for value in (base_url, wire, api_key or '')) + b'\0')
    return 0


def is_chat_completions(path: str) -> bool:
    clean = path.split('?', 1)[0].rstrip('/')
    return any(clean.endswith(suffix.rstrip('/')) for suffix in CHAT_SUFFIXES)


def inject_provider(body: bytes, only: list[str], allow_fallbacks: bool) -> bytes:
    try:
        payload = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f'chat completions body must be JSON: {error}') from error
    if not isinstance(payload, dict):
        raise ValueError('chat completions body must be a JSON object')
    payload['provider'] = {'only': only, 'allow_fallbacks': allow_fallbacks}
    return json.dumps(payload, separators=(',', ':')).encode('utf-8')


def make_handler(upstream: str, only: list[str], allow_fallbacks: bool):
    parsed = urlparse(upstream if '://' in upstream else f'https://{upstream}')
    scheme = parsed.scheme or 'https'
    host = parsed.hostname or 'openrouter.ai'
    port = parsed.port or (443 if scheme == 'https' else 80)
    prefix = (parsed.path or '').rstrip('/')

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):  # noqa: A003
            sys.stderr.write('provider-pin-proxy: ' + (format % args) + '\n')

        def _forward(self) -> None:
            length = int(self.headers.get('Content-Length', '0') or 0)
            body = self.rfile.read(length) if length else b''
            path = self.path
            upstream_path = path if path.startswith('/') else f'/{path}'
            if prefix and not upstream_path.startswith(prefix):
                # Clients call http://127.0.0.1:PORT/v1/... while upstream is .../api/v1
                if upstream_path.startswith('/v1/') or upstream_path == '/v1':
                    upstream_path = prefix + upstream_path[3:]
                else:
                    upstream_path = prefix + upstream_path

            if self.command == 'POST' and is_chat_completions(upstream_path):
                try:
                    body = inject_provider(body, only, allow_fallbacks)
                except ValueError as error:
                    message = str(error).encode()
                    self.send_response(400)
                    self.send_header('Content-Type', 'text/plain')
                    self.send_header('Content-Length', str(len(message)))
                    self.end_headers()
                    self.wfile.write(message)
                    return

            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in HOP_BY_HOP}
            headers['Host'] = host if port in (80, 443) else f'{host}:{port}'
            headers['Content-Length'] = str(len(body))
            headers['Connection'] = 'close'

            connection: HTTPConnection
            if scheme == 'https':
                connection = HTTPSConnection(host, port, timeout=600)
            else:
                connection = HTTPConnection(host, port, timeout=600)
            try:
                connection.putrequest(self.command, upstream_path, skip_host=True, skip_accept_encoding=True)
                for key, value in headers.items():
                    connection.putheader(key, value)
                connection.endheaders(body if body else None)
                response = connection.getresponse()
                self.send_response(response.status, response.reason)
                for key, value in response.getheaders():
                    if key.lower() in HOP_BY_HOP:
                        continue
                    self.send_header(key, value)
                self.send_header('Connection', 'close')
                self.end_headers()
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            finally:
                connection.close()

        def do_GET(self):  # noqa: N802
            self._forward()

        def do_POST(self):  # noqa: N802
            self._forward()

        def do_PUT(self):  # noqa: N802
            self._forward()

        def do_DELETE(self):  # noqa: N802
            self._forward()

        def do_OPTIONS(self):  # noqa: N802
            self._forward()

        def do_HEAD(self):  # noqa: N802
            self._forward()

    return Handler


def serve(upstream: str, only: list[str], allow_fallbacks: bool, bind: str, port: int) -> int:
    if not only:
        print('at least one --only provider is required', file=sys.stderr)
        return 2
    handler = make_handler(upstream.rstrip('/'), only, allow_fallbacks)
    server = ThreadingHTTPServer((bind, port), handler)
    host, bound_port = server.server_address[:2]
    # Expose an OpenAI-compatible /v1 base URL to evaluation agents.
    print(f'READY http://{host}:{bound_port}/v1', flush=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        thread.join()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == 'resolve-openrouter':
        return resolve_openrouter(args.model, args.config)
    if args.command == 'self-test':
        return self_test()
    return serve(
        upstream=args.upstream,
        only=args.only,
        allow_fallbacks=args.allow_fallbacks == 'true',
        bind=args.bind,
        port=args.port,
    )


def self_test() -> int:
    import tempfile
    from http.server import HTTPServer

    injected = inject_provider(
        b'{"model":"deepseek/deepseek-v4.1-flash","messages":[]}',
        ['relace'],
        False,
    )
    payload = json.loads(injected)
    assert payload['provider'] == {'only': ['relace'], 'allow_fallbacks': False}, payload
    assert is_chat_completions('/v1/chat/completions')
    assert is_chat_completions('/chat/completions')
    assert not is_chat_completions('/v1/models')

    seen: dict = {}

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A003
            return

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length)
            seen['path'] = self.path
            seen['body'] = json.loads(body)
            reply = b'{"ok":true}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

    upstream = HTTPServer(('127.0.0.1', 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    upstream_url = f'http://127.0.0.1:{upstream.server_address[1]}/v1'

    ready: dict = {}

    def run_proxy() -> None:
        handler = make_handler(upstream_url, ['relace'], False)
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        ready['port'] = proxy.server_address[1]
        ready['server'] = proxy
        proxy.serve_forever()

    threading.Thread(target=run_proxy, daemon=True).start()
    for _ in range(100):
        if 'port' in ready:
            break
        threading.Event().wait(0.01)
    assert 'port' in ready

    connection = HTTPConnection('127.0.0.1', ready['port'], timeout=5)
    body = b'{"model":"deepseek/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
    connection.request('POST', '/v1/chat/completions', body=body, headers={
        'Content-Type': 'application/json',
        'Content-Length': str(len(body)),
    })
    response = connection.getresponse()
    assert response.status == 200, response.read()
    response.read()
    connection.close()
    assert seen['path'] == '/v1/chat/completions', seen
    assert seen['body']['provider'] == {'only': ['relace'], 'allow_fallbacks': False}, seen

    with tempfile.TemporaryDirectory() as tmp:
        config = Path(tmp) / 'config.toml'
        config.write_text('''
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
api_key = "sk-test"
api_backend = "chat_completions"
''')
        import io
        captured = io.BytesIO()

        class Stdout:
            buffer = captured

            def write(self, s):
                return len(s)

        real_stdout = sys.stdout
        sys.stdout = Stdout()
        try:
            assert resolve_openrouter('deepseek/deepseek-v4.1-flash', str(config)) == 0
        finally:
            sys.stdout = real_stdout
        parts = captured.getvalue().split(b'\0')
        assert parts[0] == b'https://openrouter.ai/api/v1', parts
        assert parts[1] == b'deepseek/deepseek-v4.1-flash', parts
        assert parts[2] == b'sk-test', parts

    ready['server'].shutdown()
    upstream.shutdown()
    print('provider_pin_proxy self-test passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
