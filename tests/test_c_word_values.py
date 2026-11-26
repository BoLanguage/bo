import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(shutil.which("cc"), "C compiler not available")
class CWordValues(unittest.TestCase):
    def test_word_identity_gc_and_execution_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "word-values"
            sources = ["machine.c", "heap.c", "units.c", "words.c", "lower.c", "lineedit.c"]
            build = subprocess.run(
                ["cc", "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
                 "-I", str(ROOT / "c"), str(ROOT / "tests" / "c_word_values.c"),
                 *(str(ROOT / "c" / source) for source in sources), "-lm", "-o", str(binary)],
                capture_output=True, text=True,
            )
            self.assertEqual(build.returncode, 0, build.stderr)
            for mode in ("generic-ops", "specialized-ops"):
                with self.subTest(mode=mode):
                    env = os.environ.copy()
                    env.pop("BO_NO_OP_OPTIMIZATIONS", None)
                    if mode == "generic-ops":
                        env["BO_NO_OP_OPTIMIZATIONS"] = "1"
                    result = subprocess.run(
                        [str(binary), str(ROOT / "include" / "std.bo"), directory,
                         str(ROOT / "include" / "core.bo")],
                        env=env, capture_output=True, text=True, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
