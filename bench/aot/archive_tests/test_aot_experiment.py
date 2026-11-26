import os
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bench.aot.run import ROOT, build, build_integrated


@unittest.skip("Archived AOT experiment: runtime hooks were removed; snapshot bench/EXECUTION_EXPERIMENTS.md")
@unittest.skipUnless(sys.platform == "linux" and platform.machine() == "x86_64"
                     and shutil.which(os.environ.get("CC", "cc")), "Linux x86-64 compiler required")
class AotExperiment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.binary = Path(cls.directory.name) / "step"
        build(cls.binary)

    def run_step(self, implementation, scenario, count, flag=None):
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS"):
            env.pop(key, None)
        if flag:
            env[flag] = "1"
        return subprocess.run([self.binary, implementation, scenario, str(count)], cwd=ROOT,
                              env=env, capture_output=True, text=True, timeout=30)

    def test_dynamic_definitions_and_fallback_match_reference(self):
        for flag in (None, "BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS"):
            for scenario, count, expected in (("normal", 120, "120"),
                                               ("rebind", 1, "4"),
                                               ("number", 1, "0 1 42")):
                with self.subTest(flag=flag, scenario=scenario):
                    results = [self.run_step(mode, scenario, count, flag)
                               for mode in ("aot", "reference")]
                    for result in results:
                        self.assertEqual((result.returncode, result.stdout.strip(), result.stderr),
                                         (0, expected, ""))
            with self.subTest(flag=flag, scenario="empty"):
                for mode in ("aot", "reference"):
                    result = self.run_step(mode, "empty", 1, flag)
                    self.assertEqual((result.returncode, result.stdout.strip(), result.stderr),
                                     (0, "0 1", ""))

    def test_errors_match_reference(self):
        for flag in (None, "BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS"):
            for scenario, error in (("missing", "Existence-Error"), ("underflow", "Stack-Error")):
                with self.subTest(scenario=scenario, flag=flag):
                    aot, reference = (self.run_step(mode, scenario, 1, flag)
                                      for mode in ("aot", "reference"))
                    self.assertEqual((aot.returncode, aot.stdout, aot.stderr),
                                     (reference.returncode, reference.stdout, reference.stderr))
                    self.assertNotEqual(aot.returncode, 0)
                    self.assertIn(error, aot.stderr)

    def test_invalid_inputs_fail(self):
        for scenario, count in (("unknown", 1), ("normal", 0), ("normal", -1)):
            with self.subTest(scenario=scenario, count=count):
                result = self.run_step("aot", scenario, count)
                self.assertEqual(result.returncode, 2)
                self.assertIn("AOT experiment:", result.stderr)

    def test_comparison_runner(self):
        result = subprocess.run([sys.executable, str(ROOT / "bench/aot/run.py"),
                                 "--iterations", "60", "--repeat", "1"],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 6)
        self.assertTrue(all("result=60" in line for line in result.stdout.splitlines()))


@unittest.skip("Archived AOT experiment: runtime hooks were removed; snapshot bench/EXECUTION_EXPERIMENTS.md")
@unittest.skipUnless(sys.platform == "linux" and platform.machine() == "x86_64"
                     and shutil.which(os.environ.get("CC", "cc")), "Linux x86-64 compiler required")
class IntegratedAotExperiment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.binary = Path(cls.directory.name) / "integrated"
        build_integrated(cls.binary)

    def run_program(self, mode, source, no_jit=False, stats=False, collect=False):
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                    "BO_AOT_STATS", "BO_AOT_COLLECT"):
            env.pop(key, None)
        if no_jit:
            env["BO_NO_JIT"] = "1"
        if stats:
            env["BO_AOT_STATS"] = "1"
        if collect:
            env["BO_AOT_COLLECT"] = "1"
        return subprocess.run([self.binary, mode, source], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=30)

    def test_dynamic_dispatch_matches_reference(self):
        cases = (
            ("0 (dup 100 <) (STEP) loop", "100"),
            ("0 STEP (() ADD 1 () ADD) (+) PUSH STEP (+) POP drop STEP", "4"),
            ("1 STEP (2 +) (STEP) PUSH STEP (STEP) POP drop STEP", "5"),
            ("42 (+) PUSH 0 STEP", "0 1 42"),
            ("() (+) PUSH 0 STEP", "0 1"),
            ("(ADD) UNLOCK (99) (ADD) PUSH 0 STEP", "0 1 () 99"),
            ("((99) (STEP) PUSH 7) (+) PUSH 0 STEP STEP", "0 1 7 99"),
            ("0 (STEP) POP () APPLY", "1"),
        )
        for no_jit in (False, True):
            for source, expected in cases:
                with self.subTest(no_jit=no_jit, source=source):
                    aot = self.run_program("aot", source, no_jit, stats=True)
                    reference = self.run_program("reference", source, no_jit, stats=True)
                    self.assertEqual((aot.returncode, aot.stdout.strip()), (0, expected), aot.stderr)
                    self.assertEqual((aot.returncode, aot.stdout), (reference.returncode, reference.stdout))
                    native = self.run_program("native", source, no_jit)
                    self.assertEqual((native.returncode, native.stdout), (reference.returncode, reference.stdout),
                                     native.stderr)
                    self.assertIn("step_entries=0", reference.stderr)
                    if "STEP" in source:
                        entries = int(aot.stderr.strip().split()[1].split("=")[1])
                        self.assertGreater(entries, 0)

    def test_catch_and_errors_match_reference(self):
        cases = (
            ("((STEP) () catch) () APPLY", "(83 116 97 99 107 45 69 114 114 111 114)"),
            ("(+) CLEAR (0 STEP) () catch", "(69 120 105 115 116 101 110 99 101 45 69 114 114 111 114)"),
            ("((() (STEP) PUSH (STEP) POP drop 8) (+) PUSH 0 STEP) () catch", None),
        )
        for no_jit in (False, True):
            for source, error in cases:
                with self.subTest(no_jit=no_jit, source=source):
                    aot, reference = (self.run_program(mode, source, no_jit)
                                      for mode in ("aot", "reference"))
                    self.assertEqual((aot.returncode, aot.stdout, aot.stderr),
                                     (reference.returncode, reference.stdout, reference.stderr))
                    self.assertEqual(aot.returncode, 0, aot.stderr)
                    if error:
                        self.assertIn(error, aot.stdout)

    def test_collection_keeps_compiled_definition_alive(self):
        source = "0 (STEP) POP () APPLY (() ADD 1 () ADD) (+) PUSH"
        for mode in ("aot", "reference"):
            result = self.run_program(mode, source, stats=True, collect=True)
            self.assertEqual((result.returncode, result.stdout.strip()), (0, "1"), result.stderr)
            if mode == "aot":
                self.assertIn("step_entries=1", result.stderr)

    def test_benchmark_runner(self):
        result = subprocess.run([sys.executable, str(ROOT / "bench/aot/integrated.py"),
                                 "--iterations", "60", "--repeat", "1"],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 10)


if __name__ == "__main__":
    unittest.main()
