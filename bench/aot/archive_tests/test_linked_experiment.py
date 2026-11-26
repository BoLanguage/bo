import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from bench.aot.run import ROOT, build_linked


@unittest.skip("Archived linked experiment: runtime hooks were removed; snapshot bench/EXECUTION_EXPERIMENTS.md")
@unittest.skipUnless(shutil.which(os.environ.get("CC", "cc")), "C compiler required")
class LinkedExperiment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.binary = Path(cls.directory.name) / "linked"
        build_linked(cls.binary)

    def run_program(self, mode, source, *, collect=False, flag=None, trace=None, stats=True):
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                    "BO_LINKED_STATS", "BO_LINKED_GC_EACH", "BO_LINKED_TRACE"):
            env.pop(key, None)
        if stats:
            env["BO_LINKED_STATS"] = "1"
        if collect:
            env["BO_LINKED_GC_EACH"] = "1"
        if flag:
            env[flag] = "1"
        if trace:
            env["BO_LINKED_TRACE"] = trace
        return subprocess.run([self.binary, mode, source], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=30)

    @staticmethod
    def stats(result):
        line = result.stderr.split("BO_LINKED_STATS ")[-1].strip()
        return {key: int(value) for key, value in (part.split("=") for part in line.split())}

    def test_equivalence_and_forced_collection(self):
        cases = (
            ("1 2 +", "3"),
            ("0 (1 +) unconsl consl () APPLY", "1"),
            ("(1 +) unconsl consl (Q) PUSH 0 Q Q", "2"),
            ("0 (1 +) unconsl consl () APPLY (() ADD 1 () ADD) (+) PUSH "
             "(1 +) () APPLY (+) POP drop", "3"),
            ("0 (1 + (() ADD 1 () ADD) (+) PUSH 1 + (+) POP drop) () APPLY", "3"),
            ("(1 +) (Q) PUSH 0 Q (2 +) (Q) PUSH Q (Q) POP drop Q", "4"),
            ("42 (+) PUSH 0 (1 +) () APPLY", "0 1 42"),
            ("() (+) PUSH 0 (1 +) () APPLY", "0 1"),
            ("0 ((1 +) () APPLY) () APPLY", "1"),
            ("(1 0 /) (drop 9) () CATCH", "1 0 9"),
            ("0 ((1 0 /) (drop 9) () CATCH 7) () APPLY", "0 1 0 9 7"),
            ("(missing 77) (drop 9) () CATCH", None),
            ("(missing) () APPLY", None),
            ("0 (dup 5 <) (1 +) loop", "5"),
            ("0 (dup 4 <) (1 + 0 (rec) PUSH) loop", "1 0"),
            ("0 (dup 4 <) (1 + (99) (rec) PUSH (rec) POP drop) loop", "4"),
            ("0 (dup 3 <) (0 (dup 2 <) (1 +) loop drop 1 +) loop", "3"),
            ("(1 +) unconsl consl (1 +) =", "1"),
            ("(1 +) unconsl consl unconsl", "(+) (1)"),
            ("(1 2 3 4 5 6 7 8 OP) unconsl consl", "(1 2 3 4 5 6 7 8 OP)"),
            ("(1 2 3 4 5 6 7 8 OP) unconsr consr", "(1 2 3 4 5 6 7 8 OP)"),
        )
        for flag in (None, "BO_NO_JIT", "BO_NO_INTRINSICS"):
            for source, expected in cases:
                with self.subTest(source=source, flag=flag):
                    linked = self.run_program("linked", source, collect=True, flag=flag)
                    reference = self.run_program("reference", source, collect=True, flag=flag)
                    self.assertEqual((linked.returncode, linked.stdout), (reference.returncode, reference.stdout))
                    self.assertEqual(linked.stderr.split("BO_LINKED_STATS")[0],
                                     reference.stderr.split("BO_LINKED_STATS")[0])
                    if expected is not None:
                        self.assertEqual((linked.returncode, linked.stdout.strip()), (0, expected), linked.stderr)
                    self.assertGreater(self.stats(linked)["operations"], 0)

    def test_reuses_body_operation_in_library_loop(self):
        source = "(1 +) (BODY-MARKER) PUSH 0 (dup 5 <) (BODY-MARKER) loop"
        result = self.run_program("linked", source, collect=True, trace="BODY-MARKER")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "5"), result.stderr)
        stats = self.stats(result)
        self.assertGreater(stats["copies"], 0)
        self.assertGreater(stats["reused_entries"], 0)
        self.assertEqual(stats["trace"], 5)

    def test_stats_are_opt_in(self):
        result = self.run_program("linked", "0 (1 +) unconsl consl () APPLY", stats=False)
        self.assertEqual((result.returncode, result.stdout.strip(), result.stderr), (0, "1", ""))

    def test_tail_recursion(self):
        source = "((dup 0 >) (1 - COUNT) () () IFTE) (COUNT) PUSH 100000 COUNT"
        linked, reference = (self.run_program(mode, source) for mode in ("linked", "reference"))
        self.assertEqual((linked.returncode, linked.stdout), (reference.returncode, reference.stdout))
        self.assertEqual((linked.returncode, linked.stdout.strip()), (0, "0"), linked.stderr)


if __name__ == "__main__":
    unittest.main()
