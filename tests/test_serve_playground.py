"""Tests for tools/serve_playground.py: serving the repository root, locally, with the right types."""

from __future__ import annotations

import socket
import threading
import unittest
import urllib.request

from tools import serve_playground


class ServePlaygroundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = serve_playground.make_server(0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def fetch(self, path: str) -> tuple[int, str, bytes]:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=10) as response:
            return response.status, response.headers.get("content-type", ""), response.read()

    def test_serves_the_page_and_the_files_it_needs_from_the_repository_root(self) -> None:
        for path, kind in [
            ("/playground/index.html", "text/html"),
            ("/playground/app.mjs", "javascript"),
            ("/wasm/bo.mjs", "javascript"),
            ("/examples/puzzles/lib.bo", ""),
            ("/images/mascot.png", "image/png"),
        ]:
            status, content_type, body = self.fetch(path)
            self.assertEqual(status, 200, path)
            self.assertIn(kind, content_type, path)
            self.assertGreater(len(body), 0, path)

    def test_files_are_revalidated_so_an_edited_script_is_not_served_from_the_browser_cache(self) -> None:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/playground/app.mjs", timeout=10) as response:
            self.assertEqual(response.headers.get("cache-control"), "no-cache")

    def test_listens_on_the_local_machine_only(self) -> None:
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(serve_playground.page_url(self.server), f"http://localhost:{self.port}/playground/")

    def test_a_port_in_use_is_an_error_not_a_silent_choice(self) -> None:
        with self.assertRaises(OSError):
            serve_playground.make_server(self.port)

    def test_the_command_reports_a_busy_port_and_a_bad_option(self) -> None:
        with socket.socket() as blocker:
            blocker.bind(("127.0.0.1", 0))
            blocker.listen()
            busy = blocker.getsockname()[1]
            self.assertEqual(serve_playground.main(["--port", str(busy), "--no-open"]), 1)
        with self.assertRaises(SystemExit):
            serve_playground.main(["--bogus"])


if __name__ == "__main__":
    unittest.main()
