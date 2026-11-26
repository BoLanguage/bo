import base64
import contextlib
import io
import math
import os
import random
import subprocess
import tempfile
import unittest
from pathlib import Path

from python.bo.machine import Machine
from python.bo.values import Word, from_str
from tests.diff_c import dump


ROOT = Path(__file__).resolve().parent.parent
C_BIN = ROOT / "c" / "bo"


def uint(value):
    result = []
    while value >= 128:
        result.append((value % 128) + 128)
        value //= 128
    return bytes(result + [value])


def serialize(value):
    if isinstance(value, Word):
        return b"W" + b"".join(uint(ord(char)) for char in value.name) + b"\0"
    if isinstance(value, list):
        return b"L" + b"".join(serialize(item) for item in value) + b"E"
    if value == 0:
        return b"N\0\0\0"
    fraction, exponent = math.frexp(abs(value))
    mantissa = int(fraction * 2**53)
    return b"N" + bytes([value < 0]) + uint(exponent - 1 + 1074) + uint(mantissa)


def expected_key(value, tag):
    payload = base64.urlsafe_b64encode(serialize(value)).decode("ascii").rstrip("=")
    return [Word(f"{tag}.{payload}")]


class TagKeys(unittest.TestCase):
    def run_program(self, program):
        source = '"include/core.bo" () INCLUDE "include/dict.bo" () INCLUDE ' + program
        machine = Machine()
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            self.assertTrue(machine.execute(source), errors.getvalue())
        self.assertEqual(errors.getvalue(), "")
        if C_BIN.exists():
            for mode in ("generic", "specialized"):
                env = os.environ.copy()
                env.pop("BO_NO_OP_OPTIMIZATIONS", None)
                if mode == "generic":
                    env["BO_NO_OP_OPTIMIZATIONS"] = "1"
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "stack"
                    result = subprocess.run(
                        [str(C_BIN), "--bare", "--dump", str(path), "-e", source],
                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120,
                    )
                    self.assertEqual(result.returncode, 0, (mode, result.stderr))
                    self.assertEqual(result.stderr, "")
                    self.assertEqual(path.read_text().strip(),
                                     " ".join(dump(value) for value in machine.data), mode)
        return machine.data

    def test_base64url_helper_is_private(self):
        # the encoder is a private word of dict.bo; tagkey's output is checked against the
        # reference base64url encoder below
        result = self.run_program("(() \"f\" __key-b64-0) () catch unconsl apply text")
        self.assertEqual(result[-1], from_str("Existence-Error"))

    def test_structural_values_and_tags(self):
        cases = [
            ("()", [], "T"),
            ('"hello, world!\\n"', from_str("hello, world!\n"), "My.Dictionary"),
            ("(0 1 (a (b C) ()) 1114112 -1)", [0, 1, [Word("a"), [Word("b"), Word("C")], []], 1114112, -1], "T"),
            ("(97 98 99)", [97, 98, 99], "T"),
            ("(abc)", [Word("abc")], "T"),
            ("(())", [[]], "T"),
            ("(0)", [0], "T"),
            ("40", 40, "-"),
            ("40", 40, "+"),
            ("40", 40, "a.b"),
            ("40", 40, "π"),
        ]
        program = " ".join(f"{source} ({tag}) tagkey" for source, _, tag in cases)
        self.assertEqual(self.run_program(program),
                         [expected_key(value, tag) for _, value, tag in cases])

    def test_exact_finite_numbers_against_reference(self):
        values = [0.0, -0.0, 1.0, -1.0, 0.1, -0.1, 0.5,
                  5e-324, -5e-324, 2.2250738585072014e-308,
                  1.7976931348623157e308, -1.7976931348623157e308,
                  9007199254740991, 9007199254740992,
                  math.nextafter(1.0, 0.0), math.nextafter(1.0, 2.0)]
        rng = random.Random(42)
        values.extend(math.ldexp(rng.uniform(-1, 1), rng.randrange(-1070, 1024))
                      for _ in range(24))
        program = " ".join(f"{value!r} (NUMBERS) tagkey" for value in values)
        self.assertEqual(self.run_program(program),
                         [expected_key(value, "NUMBERS") for value in values])

    def test_equal_keys_and_distinct_entries(self):
        program = (
            '10 1 (X) tagkey PUSH 1.0 (X) tagkey TOP '
            '20 "abc" (X) tagkey PUSH (97 98 99) (X) tagkey TOP '
            '30 (1 (2 A)) (X) tagkey PUSH (1.0 (2 A)) (X) tagkey TOP '
            '0 (X) tagkey -0.0 (X) tagkey = '
            '(1) (X) tagkey 1 (X) tagkey = '
            '1 (X) tagkey 1 (Y) tagkey ='
        )
        self.assertEqual(self.run_program(program), [10, 20, 30, 1, 0, 0])

    def test_invalid_tags_are_catchable(self):
        for tag in ("()", "(1)", "((X))", "(A B)", '"X"'):
            with self.subTest(tag=tag):
                data = self.run_program(f"(42 {tag} tagkey) () catch")
                self.assertEqual(data[0], 42)
                self.assertEqual(data[-1][:2], [[Word("Type-Error")], [Word("TEXT")]])


if __name__ == "__main__":
    unittest.main()
