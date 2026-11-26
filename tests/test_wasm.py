"""Run the Node tests of the WebAssembly runtime (wasm/test_*.mjs) and of the playground (playground/test_*.mjs)
when Node and a WASM build are available.

Build first with `make -C c wasm` (needs Emscripten); otherwise these tests are skipped.
"""
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WASM = os.path.join(ROOT, "wasm")
PLAYGROUND = os.path.join(ROOT, "playground")
BUILD = os.path.join(WASM, "build", "bo-core.wasm")
NATIVE = os.path.join(ROOT, "c", "bo")


@unittest.skipUnless(shutil.which("node"), "node is not available")
@unittest.skipUnless(os.path.exists(BUILD), "WASM runtime is not built (make -C c wasm)")
class WasmTests(unittest.TestCase):
    def run_script(self, directory, name):
        result = subprocess.run(["node", os.path.join(directory, name)], cwd=ROOT,
                                capture_output=True, text=True, timeout=600)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_examples(self):
        self.run_script(WASM, "test_examples.mjs")

    def test_puzzles(self):
        self.run_script(PLAYGROUND, "test_puzzles.mjs")

    def test_debugger(self):
        self.run_script(WASM, "test_debugger.mjs")

    def test_store(self):
        self.run_script(PLAYGROUND, "test_store.mjs")

    def test_views(self):
        self.run_script(PLAYGROUND, "test_views.mjs")

    def test_helpers(self):
        self.run_script(PLAYGROUND, "test_helpers.mjs")

    def test_stack_operations(self):
        self.run_script(PLAYGROUND, "test_stackops.mjs")

    @unittest.skipUnless(os.path.exists(NATIVE), "c/bo is not built")
    def test_parallel_matches_native(self):
        self.run_script(WASM, "test_parallel.mjs")


if __name__ == "__main__":
    unittest.main()
