import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from bench.aot.run import ROOT, build_linked

CASES = (
    ("(1 +) (BODY-MARKER) PUSH 0 (dup 5 <) (BODY-MARKER 0 +) loop", "5"),
    ("0 (1 +) unconsl consl () APPLY", "1"),
    ("0 (1 +) unconsl consl (Q) PUSH Q (() ADD 1 () ADD) (+) PUSH Q (+) POP drop", "3"),
    ("0 (1 + (() ADD 1 () ADD) (+) PUSH 1 + (+) POP drop) () APPLY", "3"),
    ("0 (dup 4 <) (1 + 0 (rec) PUSH) loop", "1 0"),
    ("0 (dup 3 <) (0 (dup 2 <) (1 +) loop drop 1 +) loop", "3"),
    ("0 ((1 0 /) (drop 9) () CATCH 7) () APPLY", "0 1 0 9 7"),
    ("((missing 77) (drop 9) () CATCH 8) () APPLY", None),
    ("(missing) () APPLY", None),
    ("(1 2 3) unconsl drop (9) consl () APPLY", "9 2 3"),
    ("(1 2 3) unconsr drop () APPLY", "1 2"),
    ("(1 +) (MID) PUSH (11 MID 22) unconsr drop () APPLY", "12"),
    ("(1 2 3) unconsl consl unconsl", "(2 3) (1)"),
    ("(1 2 3 4 5 6 7 8 OP) unconsr consr", "(1 2 3 4 5 6 7 8 OP)"),
    ("0 ((1 +) () APPLY) () APPLY", "1"),
    ("((dup 0 >) (1 - COUNT) () () IFTE) (COUNT) PUSH 100000 COUNT", "0"),
)


@unittest.skip("Archived linked experiment: runtime hooks were removed; snapshot bench/EXECUTION_EXPERIMENTS.md")
@unittest.skipUnless(shutil.which(os.environ.get("CC", "cc")), "C compiler required")
class LinkedFragments(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.binary = Path(cls.directory.name) / "fragments"
        build_linked(cls.binary, [source for source, _ in CASES])

    def run_program(self, mode, source, *, collect=False, flag=None, trace=None, after_gc=None):
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                    "BO_LINKED_STATS", "BO_LINKED_GC_EACH", "BO_LINKED_TRACE"):
            env.pop(key, None)
        env["BO_LINKED_STATS"] = "1"
        if collect:
            env["BO_LINKED_GC_EACH"] = "1"
        if flag:
            env[flag] = "1"
        if trace:
            env["BO_LINKED_TRACE"] = trace
        command = [self.binary, mode, source]
        if after_gc is not None:
            command.append(after_gc)
        return subprocess.run(command, cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=30)

    @staticmethod
    def counts(result):
        line = next(line for line in result.stderr.splitlines() if line.startswith("BO_FRAGMENT_STATS "))
        return {key: int(value) for key, value in (part.split("=") for part in line.split()[1:])}

    def test_equivalence(self):
        for flag in (None, "BO_NO_JIT", "BO_NO_INTRINSICS"):
            for source, expected in CASES[:-1]:
                with self.subTest(source=source, flag=flag):
                    fragment, reference = (self.run_program(mode, source, collect=True, flag=flag)
                                           for mode in ("fragments", "reference"))
                    self.assertEqual((fragment.returncode, fragment.stdout),
                                     (reference.returncode, reference.stdout))
                    self.assertEqual(fragment.stderr.split("BO_LINKED_STATS")[0],
                                     reference.stderr.split("BO_LINKED_STATS")[0])
                    if expected is not None:
                        self.assertEqual((fragment.returncode, fragment.stdout.strip()), (0, expected))
                    self.assertGreater(self.counts(fragment)["operations"], 0)

    def test_copied_loop_body_enters_whole_fragment(self):
        result = self.run_program("fragments", CASES[0][0], collect=True, trace="BODY-MARKER")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "5"), result.stderr)
        counts = self.counts(result)
        self.assertEqual(counts["trace"], 5)
        self.assertGreater(counts["resumes"], 0)
        self.assertGreater(counts["yields"], 0)

    def test_partial_fragment_falls_back(self):
        source = "(1 +) (MID) PUSH (11 MID 22) unconsr drop () APPLY"
        result = self.run_program("fragments", source, collect=True, trace="MID")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "12"), result.stderr)
        self.assertGreaterEqual(self.counts(result)["fallbacks"], 2)
        self.assertEqual(self.counts(result)["trace"], 0)
        self.assertIn("trace=1", result.stderr.splitlines()[0].split())

    def test_fragment_origin_survives_collection_after_construction(self):
        setup = "(1 +) unconsl consl (Q) PUSH"
        fragment, reference = (self.run_program(mode, setup, collect=True, trace="+", after_gc="0 Q")
                               for mode in ("fragments", "reference"))
        self.assertEqual((fragment.returncode, fragment.stdout), (reference.returncode, reference.stdout))
        self.assertEqual((fragment.returncode, fragment.stdout.strip()), (0, "1"), fragment.stderr)
        self.assertEqual(self.counts(fragment)["trace"], 1)

    def test_tail_recursion(self):
        source, expected = CASES[-1]
        fragment, reference = (self.run_program(mode, source) for mode in ("fragments", "reference"))
        self.assertEqual((fragment.returncode, fragment.stdout), (reference.returncode, reference.stdout))
        self.assertEqual((fragment.returncode, fragment.stdout.strip()), (0, expected), fragment.stderr)


if __name__ == "__main__":
    unittest.main()
