import os
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bench.aot.run import ROOT, build_translated
@unittest.skip("Archived AOT experiment: runtime hooks were removed; snapshot bench/EXECUTION_EXPERIMENTS.md")
@unittest.skipUnless(sys.platform == "linux" and platform.machine() == "x86_64"
                     and shutil.which(os.environ.get("CC", "cc")), "Linux x86-64 compiler required")
class TranslatedAot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.binary = Path(cls.directory.name) / "translated"
        chain = " ".join(f"(CHAIN-{i + 1} 1 +) (CHAIN-{i}) PUSH" for i in range(69))
        chain += " (1 +) (CHAIN-69) PUSH"
        failing = " ".join(f"(FAIL-{i + 1} 1 +) (FAIL-{i}) PUSH" for i in range(40))
        failing += " (missing) (FAIL-40) PUSH"
        build_translated(cls.binary, "(1 +) (STEP) PUSH (() ADD) (+) PUSH "
                         "((2 +) () APPLY 3 +) (NEST) PUSH "
                         "(() (STEP) PUSH 7) (REPLACE) PUSH "
                         "(missing) (MISSING) PUSH "
                         "((1) (STEP) (99) () IFTE) (PICK-STEP) PUSH "
                         "((dup 0 >) (1 - COUNT) () () IFTE) (COUNT) PUSH "
                         "((ACTIVE) POP drop 8) (ACTIVE) PUSH "
                         '("hé") (AOT-TEXT) PUSH ' + chain + " " + failing)

    @staticmethod
    def stats(result):
        line = result.stderr.split("BO_AOT_STATS ")[-1].strip()
        return {key: int(value) for key, value in (part.split("=") for part in line.split())}

    def run_program(self, mode, source, collect=False, flag=None, stats=True):
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                    "BO_AOT_STATS", "BO_AOT_BLOCK_STATS", "BO_AOT_COLLECT", "BO_AOT_GC_EACH"):
            env.pop(key, None)
        if stats:
            env["BO_AOT_STATS"] = "1"
        if collect:
            env["BO_AOT_COLLECT"] = "1"
            env["BO_AOT_GC_EACH"] = "1"
        if flag:
            env[flag] = "1"
        return subprocess.run([self.binary, mode, source], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=30)

    def test_stats_are_opt_in(self):
        measured = self.run_program("aot", "0 NEST")
        unmeasured = self.run_program("aot", "0 NEST", stats=False)
        self.assertEqual((measured.returncode, measured.stdout),
                         (unmeasured.returncode, unmeasured.stdout))
        self.assertGreater(self.stats(measured)["operations"], 0)
        self.assertEqual(unmeasured.stderr, "")

    def test_redefinition_inside_generated_branch(self):
        source = "0 PICK-STEP (2 +) (STEP) PUSH PICK-STEP (STEP) POP drop PICK-STEP"
        for flag in (None, "BO_NO_JIT"):
            with self.subTest(flag=flag):
                aot, reference = (self.run_program(mode, source, collect=True, flag=flag)
                                  for mode in ("aot", "reference"))
                self.assertEqual((aot.returncode, aot.stdout), (reference.returncode, reference.stdout))
                self.assertEqual((aot.returncode, aot.stdout.strip()), (0, "4"), aot.stderr)
                self.assertGreater(self.stats(aot)["nested"], 0)

    def test_control_quotation_block_entries(self):
        source = ("((1) (11) (22) () IFTE) (BRANCH) PUSH "
                  "((0) (11) (22) () IFTE) (OTHER-BRANCH) PUSH "
                  "((0 1 0 /) (drop 9) () CATCH) (GUARD) PUSH "
                  "((5) () APPLY) (DO-APPLY) PUSH "
                  "(0 (dup 3 <) (1 +) loop) (DO-LOOP) PUSH")
        binary = Path(self.directory.name) / "control-blocks"
        build_translated(binary, source)
        cases = {
            "BRANCH": ("11", {0: 1, 1: 1, 2: 1}),
            "OTHER-BRANCH": ("22", {5: 1, 6: 1, 8: 1}),
            "GUARD": ("0 1 0 9", {10: 1, 11: 1, 12: 1}),
            "DO-APPLY": ("5", {14: 1, 15: 1}),
            "DO-LOOP": ("3", {17: 1, 18: 4}),
        }
        for flag in (None, "BO_NO_JIT"):
            for word, (expected, active) in cases.items():
                with self.subTest(word=word, flag=flag):
                    env = os.environ.copy()
                    for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                                "BO_AOT_STATS", "BO_AOT_BLOCK_STATS", "BO_AOT_COLLECT",
                                "BO_AOT_GC_EACH"):
                        env.pop(key, None)
                    env.update(BO_AOT_STATS="1", BO_AOT_BLOCK_STATS="1",
                               BO_AOT_COLLECT="1", BO_AOT_GC_EACH="1")
                    if flag:
                        env[flag] = "1"
                    results = [subprocess.run([binary, mode, word], cwd=ROOT, env=env,
                                              capture_output=True, text=True, timeout=30)
                               for mode in ("aot", "reference")]
                    aot, reference = results
                    self.assertEqual((aot.returncode, aot.stdout), (reference.returncode, reference.stdout))
                    self.assertEqual((aot.returncode, aot.stdout.strip()), (0, expected), aot.stderr)
                    entries = {}
                    for line in aot.stderr.splitlines()[1:]:
                        prefix, index, count = line.split()
                        self.assertEqual(prefix, "BO_AOT_BLOCK")
                        entries[int(index.split("=")[1])] = int(count.split("=")[1])
                    self.assertEqual(entries, {i: active.get(i, 0) for i in range(20)})

    def test_dynamic_dispatch_and_continuations(self):
        cases = (
            ("0 STEP", "1"),
            ("0 (dup 100 <) (STEP) loop", "100"),
            ("0 STEP (() ADD 1 () ADD) (+) PUSH STEP (+) POP drop STEP", "4"),
            ("1 STEP (2 +) (STEP) PUSH STEP (STEP) POP drop STEP", "5"),
            ("42 (+) PUSH 0 STEP", "0 1 42"),
            ("() (+) PUSH 0 STEP", "0 1"),
            ("(ADD) UNLOCK (99) (ADD) PUSH 0 STEP", "0 1 () 99"),
            ("((99) (STEP) PUSH 7) (+) PUSH 0 STEP STEP", "0 1 7 99"),
            ("0 (STEP) POP () APPLY", "1"),
            ("0 NEST", "5"),
            ("REPLACE STEP", "7"),
            ("ACTIVE", "8"),
            ("AOT-TEXT", "(104 233)"),
        )
        for flag in (None, "BO_NO_JIT", "BO_NO_INTRINSICS"):
            for source, expected in cases:
                with self.subTest(source=source, flag=flag):
                    aot, reference = (self.run_program(mode, source, flag=flag)
                                      for mode in ("aot", "reference"))
                    self.assertEqual((aot.returncode, aot.stdout.strip()), (0, expected), aot.stderr)
                    self.assertEqual((aot.returncode, aot.stdout), (reference.returncode, reference.stdout))
                    operations = self.stats(aot)["operations"]
                    self.assertGreater(operations, 0)
                    self.assertIn("operations=0", reference.stderr)

    def test_errors_and_collection(self):
        cases = ("((STEP) () catch) () APPLY", "(MISSING) () catch",
                 "MISSING", "0 (STEP) POP () APPLY",
                 "((() (STEP) PUSH (STEP) POP drop 8) (+) PUSH 0 STEP) () catch")
        for source in cases:
            for collect in (False, True):
                with self.subTest(source=source, collect=collect):
                    aot, reference = (self.run_program(mode, source, collect)
                                      for mode in ("aot", "reference"))
                    self.assertEqual((aot.returncode, aot.stdout), (reference.returncode, reference.stdout))
                    self.assertEqual(aot.stderr.split("BO_AOT_STATS")[0],
                                     reference.stderr.split("BO_AOT_STATS")[0])
                    self.assertGreater(self.stats(aot)["operations"], 0)

    def test_tail_recursion(self):
        for mode in ("aot", "reference"):
            result = self.run_program(mode, "100000 COUNT")
            self.assertEqual((result.returncode, result.stdout.strip()), (0, "0"), result.stderr)

    def test_nested_blocks_and_runtime_fallback(self):
        for source, expected, operations in (("0 NEST", "5", 11),
                                             ("(2 +) (STEP) PUSH 0 STEP", "2", 2)):
            with self.subTest(source=source):
                result = self.run_program("aot", source, collect=True)
                self.assertEqual((result.returncode, result.stdout.strip()), (0, expected), result.stderr)
                self.assertEqual(self.stats(result)["operations"], operations)

    def test_compiled_values_remain_inspectable_and_transformable(self):
        cases = (
            ("(STEP) POP unconsl", "(+) (1)"),
            ("(STEP) POP unconsl consl 0 swap () APPLY", "1"),
            ("(STEP) POP (OTHER) PUSH 0 OTHER", "1"),
            ("0 (STEP) POP () APPLY", "1"),
            ("(STEP) POP (1 +) =", "1"),
        )
        for source, expected in cases:
            with self.subTest(source=source):
                result, reference = (self.run_program(mode, source, collect=True)
                                     for mode in ("aot", "reference"))
                self.assertEqual((result.returncode, result.stdout), (reference.returncode, reference.stdout))
                self.assertEqual((result.returncode, result.stdout.strip()), (0, expected), result.stderr)
                if source == "(STEP) POP (OTHER) PUSH 0 OTHER":
                    self.assertGreater(self.stats(result)["operations"], 0)

    def test_reconstructed_quotation_is_interpreted(self):
        original = self.run_program("aot", "(STEP) POP 0 swap () APPLY", collect=True)
        rebuilt = self.run_program("aot", "(STEP) POP unconsl consl 0 swap () APPLY", collect=True)
        for result in (original, rebuilt):
            self.assertEqual((result.returncode, result.stdout.strip()), (0, "1"), result.stderr)
        self.assertEqual(self.stats(original)["operations"], 4)
        self.assertEqual(self.stats(rebuilt)["operations"], 2)

    def test_bounded_nested_native_calls_and_error_unwinding(self):
        for source, expected in (("0 CHAIN-0", "70"),
                                 ("0 (FAIL-0 77) () catch 99", None)):
            with self.subTest(source=source):
                result, reference = (self.run_program(mode, source, collect=True)
                                     for mode in ("aot", "reference"))
                self.assertEqual((result.returncode, result.stdout), (reference.returncode, reference.stdout))
                self.assertEqual(result.returncode, 0, result.stderr)
                stats = self.stats(result)
                self.assertEqual(stats["max_depth"], 32)
                self.assertGreater(stats["depth_yields"], 0)
                self.assertGreater(stats["direct"], 30)
                if expected:
                    self.assertEqual(result.stdout.strip(), expected)
                else:
                    self.assertIn("(69 120 105 115 116 101 110 99 101 45 69 114 114 111 114)", result.stdout)
                    self.assertNotIn(" 77", result.stdout)
                    self.assertTrue(result.stdout.strip().endswith(" 99"))

    def test_benchmark_runner(self):
        result = subprocess.run([sys.executable, str(ROOT / "bench/aot/translated.py"),
                                 "--iterations", "60", "--repeat", "1"],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 25)


if __name__ == "__main__":
    unittest.main()
