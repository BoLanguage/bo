#!/usr/bin/env python3
"""Serve the Bo playground (playground/) from the repository root and open it in a browser.

    python3 tools/serve_playground.py [--port 8000] [--no-open]

The page fetches wasm/, examples/ and images/ next to playground/, so the repository root is served (as with
`python3 -m http.server`, which this replaces for convenience). Only the local machine can connect.
"""

from __future__ import annotations

import argparse
import functools
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8000
WASM = ROOT / "wasm" / "build" / "bo-core.wasm"


class QuietHandler(SimpleHTTPRequestHandler):
    """Static files without a log line per request, and always revalidated.

    Without Cache-Control a browser may keep using a script it loaded earlier for hours (it guesses a lifetime from
    Last-Modified), so a page edited since then would run an old script against new HTML.
    """

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def make_server(port: int = DEFAULT_PORT, root: Path = ROOT) -> ThreadingHTTPServer:
    """A server for `root` on 127.0.0.1; port 0 picks a free one. Raises OSError if the port is taken."""
    handler = functools.partial(QuietHandler, directory=str(root))
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def page_url(server: ThreadingHTTPServer) -> str:
    return f"http://localhost:{server.server_address[1]}/playground/"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to listen on (default {DEFAULT_PORT})")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = parser.parse_args(argv)

    if not WASM.exists():
        print("error: wasm/build has no WebAssembly build; run `make wasm` first (it needs Emscripten: `make emsdk`)", file=sys.stderr)
        return 1
    try:
        server = make_server(args.port)
    except OSError as error:
        print(f"error: cannot listen on port {args.port}: {error.strerror or error}. Is another server running? Try --port.", file=sys.stderr)
        return 1

    url = page_url(server)
    print(f"Bo Playground is running at {url} (Ctrl+C to stop)", flush=True)
    if not args.no_open:
        # open from a thread so that a slow or missing browser never delays the server
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
