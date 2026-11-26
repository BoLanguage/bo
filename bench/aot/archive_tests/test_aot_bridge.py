import os
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bench.aot.run import ROOT, build_bridge


@unittest.skip("Archived AOT experiment: runtime hooks were removed; snapshot bench/EXECUTION_EXPERIMENTS.md")
@unittest.skipUnless(sys.platform == "linux" and platform.machine() == "x86_64"
                     and shutil.which(os.environ.get("CC", "cc")), "Linux x86-64 compiler required")
class AotBridge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.binary = Path(cls.directory.name) / "bridge"
        build_bridge(cls.binary)

    def run_program(self, mode, source, collect=False, flag=None):
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                    "BO_AOT_BRIDGE_STATS", "BO_AOT_BRIDGE_COLLECT", "BO_AOT_BRIDGE_GC_EACH"):
            env.pop(key, None)
        if flag:
            env[flag] = "1"
        if collect:
            env["BO_AOT_BRIDGE_COLLECT"] = "1"
            env["BO_AOT_BRIDGE_GC_EACH"] = "1"
        env["BO_AOT_BRIDGE_STATS"] = "1"
        return subprocess.run([self.binary, mode, source], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=30)

    def compare(self, source, entries, fallbacks, flag=None, collect=False, direct_calls=0):
        bridge = self.run_program("bridge", source, collect, flag)
        reference = self.run_program("reference", source, collect, flag)
        self.assertEqual((bridge.returncode, bridge.stdout), (reference.returncode, reference.stdout))
        prefix = "BO_AOT_BRIDGE_STATS"
        self.assertEqual(bridge.stderr.split(prefix)[0], reference.stderr.split(prefix)[0])
        self.assertEqual(bridge.stderr.split(prefix)[-1].strip(),
                         f"entries={entries} fallbacks={fallbacks} direct_calls={direct_calls}")
        return bridge

    def test_direct_and_fallback_continuations(self):
        cases = (
            ("0 BRIDGE-STEP", "11", 1, 0),
            ("(() ADD) unconsl consl (+) PUSH 0 BRIDGE-STEP", "11", 3, 2),
            ("42 (+) PUSH 0 BRIDGE-STEP", "0 1 42 10 42", 1, 2),
            ("() (+) PUSH 0 BRIDGE-STEP", "0 1 10", 1, 2),
            ("((+) POP drop 7) (+) PUSH 0 BRIDGE-STEP", "0 1 17", 2, 1),
            ("(2 +) (BRIDGE-STEP) PUSH 0 BRIDGE-STEP", "2", 0, 0),
            ("0 (BRIDGE-STEP) POP () APPLY", "11", 1, 0),
        )
        for flag in (None, "BO_NO_JIT", "BO_NO_INTRINSICS"):
            for source, expected, entries, fallbacks in cases:
                with self.subTest(source=source, flag=flag):
                    result = self.compare(source, entries, fallbacks, flag, collect=True)
                    self.assertEqual((result.returncode, result.stdout.strip()), (0, expected))

    def test_catch_unwinds_or_resumes_correctly(self):
        cases = (
            ("((BRIDGE-STEP) () catch 99) () APPLY", 1, 0, "Stack-Error"),
            ("((missing) (+) PUSH 0 (BRIDGE-STEP 77) () catch 99) () APPLY", 1, 1, "Existence-Error"),
            ("(((+) POP drop (missing) (+) PUSH) (+) PUSH 0 "
             "(BRIDGE-STEP 77) () catch 99) () APPLY", 2, 2, "Existence-Error"),
            ("((missing) () catch drop 7) (+) PUSH 0 BRIDGE-STEP", 3, 2, None),
        )
        for source, entries, fallbacks, error in cases:
            with self.subTest(source=source):
                result = self.compare(source, entries, fallbacks, collect=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                if error:
                    codes = " ".join(str(ord(char)) for char in error)
                    self.assertIn(f"({codes})", result.stdout)
                    self.assertTrue(result.stdout.strip().endswith(" 99"))
                    self.assertNotIn(" 77", result.stdout)
                else:
                    self.assertEqual(result.stdout.strip(), "0 1 7 10 7")

    def test_uncaught_failure_matches_runtime(self):
        result = self.compare("(missing) (+) PUSH 0 BRIDGE-STEP", 1, 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Existence-Error", result.stderr)

    def test_nested_direct_calls_and_dynamic_resumption(self):
        cases = (
            ("0 BRIDGE-GRAND", "1111", 1, 0, 2),
            ("(() ADD) unconsl consl (+) PUSH 0 BRIDGE-GRAND", "1111", 7, 4, 2),
            ("(2 +) (BRIDGE-STEP) PUSH 0 BRIDGE-GRAND", "1102", 3, 1, 1),
            ("(3 +) (BRIDGE-OUTER) PUSH 0 BRIDGE-GRAND", "1003", 2, 1, 0),
            ("0 (BRIDGE-GRAND) POP () APPLY", "1111", 1, 0, 2),
            ("((BRIDGE-STEP) POP drop (+) POP drop 7) (+) PUSH 0 BRIDGE-GRAND",
             "0 1 1117", 4, 1, 2),
            ("((BRIDGE-OUTER) POP drop (+) POP drop 7) (+) PUSH 0 BRIDGE-GRAND",
             "0 1 1117", 4, 1, 2),
            ("((missing) () catch drop 7) (+) PUSH 0 BRIDGE-GRAND",
             "0 1 7 10 7 100 7 1000 7", 7, 4, 2),
        )
        for flag in (None, "BO_NO_JIT", "BO_NO_INTRINSICS"):
            for source, expected, entries, fallbacks, direct in cases:
                with self.subTest(source=source, flag=flag):
                    result = self.compare(source, entries, fallbacks, flag, collect=True, direct_calls=direct)
                    self.assertEqual((result.returncode, result.stdout.strip()), (0, expected))

    def test_nested_errors_unwind_all_native_frames(self):
        cases = (
            ("((missing) (+) PUSH 0 (BRIDGE-GRAND 77) () catch 99) () APPLY", 1, 1, "Existence-Error"),
            ("(((+) POP drop (missing) (+) PUSH) (+) PUSH 0 "
             "(BRIDGE-GRAND 77) () catch 99) () APPLY", 2, 2, "Existence-Error"),
            ("((BRIDGE-GRAND) () catch 99) () APPLY", 1, 0, "Stack-Error"),
        )
        for source, entries, fallbacks, error in cases:
            with self.subTest(source=source):
                result = self.compare(source, entries, fallbacks, collect=True, direct_calls=2)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("(" + " ".join(str(ord(char)) for char in error) + ")", result.stdout)
                self.assertNotIn(" 77", result.stdout)
                self.assertTrue(result.stdout.strip().endswith(" 99"))

    def test_nested_uncaught_failure(self):
        result = self.compare("(missing) (+) PUSH 0 BRIDGE-GRAND", 1, 1,
                              collect=True, direct_calls=2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Existence-Error", result.stderr)

    def test_benchmark_runner(self):
        result = subprocess.run([sys.executable, str(ROOT / "bench/aot/bridge.py"),
                                 "--iterations", "20", "--repeat", "1"],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 12)


if __name__ == "__main__":
    unittest.main()
