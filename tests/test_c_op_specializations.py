"""Compare specialized and generic C execution on operation edge cases."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BINARY = ROOT / "c" / "bo"


@unittest.skipUnless(BINARY.exists(), "c/bo is not built")
class OperationSpecializations(unittest.TestCase):
    def run_mode(self, source, generic):
        env = os.environ.copy()
        env.pop("BO_NO_OP_OPTIMIZATIONS", None)
        if generic:
            env["BO_NO_OP_OPTIMIZATIONS"] = "1"
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory) / "stack"
            result = subprocess.run(
                [str(BINARY), "--dump", str(dump), "-e", source],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
            )
            return result.returncode, result.stdout, result.stderr, dump.read_text()

    def test_specialized_execution_matches_generic(self):
        prefix = '"include/std.bo" () INCLUDE '
        cases = []
        for word, primitive in (
            ("drop", "DROP"), ("+", "ADD"), ("-", "SUB"), ("*", "MUL"),
            ("/", "DIV"), ("//", "IDIV"), ("=", "EQUAL"), ("pick", "PICK"),
            ("roll", "ROLL"),
        ):
            operands = "4 0" if word in ("pick", "roll") else "4 2"
            cases.extend((
                f"({operands} {word}) (CHECK) PUSH CHECK",
                f"((99) ({word}) PUSH) (CHANGE) PUSH (CHANGE {operands} {word}) (CHECK) PUSH CHECK",
                f"(({primitive}) UNLOCK (99) ({primitive}) PUSH) (CHANGE) PUSH "
                f"(CHANGE {operands} {word}) (CHECK) PUSH CHECK",
            ))
        for source in (
            "(drop) () catch", "(1 +) () catch", '(1 "x" +) () catch',
            '(1 "x" -) () catch', '(1 "x" *) () catch',
            '(1 "x" /) () catch', '(1 "x" //) () catch',
            "(0 0 /) () catch", "(0 0 //) () catch",
            "(1e308 1e308 *) () catch", "(1e308 1e308 +) () catch",
            "((1 2) (1 2) =) (CHECK) PUSH CHECK",
            "(0 pick) () catch", "(0 roll) () catch",
            "(1 -1 pick) () catch", "(1 -1 roll) () catch",
            "(1 0.5 pick) () catch", "(1 0.5 roll) () catch",
            "(1 63 pick) () catch", "(1 64 pick) () catch",
            "(1 63 roll) () catch", "(1 64 roll) () catch",
            "((1) (11) (22) ifte) (CHECK) PUSH CHECK",
            "((0) (11) (22) ifte) (CHECK) PUSH CHECK",
            "((() (11) (22) ifte) () catch) (CHECK) PUSH CHECK",
            '((("bad") (11) (22) ifte) () catch) (CHECK) PUSH CHECK',
            "(((1) (0) (1) ifte) (11) (22) ifte) (CHECK) PUSH CHECK",
            "((ifte) POP drop) (CHANGE) PUSH "
            "(CHANGE (1) (11) (22) ifte) (CHECK) PUSH (CHECK) () catch",
            "((IFTE) UNLOCK (99) (IFTE) PUSH) (CHANGE) PUSH "
            "(CHANGE (1) (11) (22) ifte) (CHECK) PUSH CHECK",
            "((1) (11) (22) () IFTE) (CHECK) PUSH CHECK",
        ):
            cases.append(source)
        for source in cases:
            with self.subTest(source=source):
                optimized = self.run_mode(prefix + source, False)
                generic = self.run_mode(prefix + source, True)
                self.assertEqual(optimized, generic)


if __name__ == "__main__":
    unittest.main()
