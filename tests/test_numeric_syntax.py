import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from python.bo.lower import lower_op_forms, valid_op_name
from python.bo.values import Op

ROOT = Path(__file__).resolve().parent.parent
C_BIN = ROOT / "c" / "bo"


class NumericSyntax(unittest.TestCase):
    def test_unicode_digits_are_op_names(self):
        for token in ("١٢٣", "１２３", "1١", "١.2", "1e٢"):
            with self.subTest(token=token):
                self.assertEqual(lower_op_forms(token)[0][1], [Op(token)])
                self.assertTrue(valid_op_name(token))

    @unittest.skipUnless(C_BIN.exists(), "c/bo is not built")
    def test_c_execution_modes_recognize_unicode_names(self):
        code = " ".join(
            f"{i} ({name}) PUSH {name}"
            for i, name in enumerate(("١٢٣", "１２３", "1١", "١.2", "1e٢"), 1)
        )
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory) / "stack"
            for mode in ("unoptimized-ops", "compiled-ops"):
                with self.subTest(mode=mode):
                    env = os.environ.copy()
                    env.pop("BO_NO_OP_OPTIMIZATIONS", None)
                    if mode == "unoptimized-ops":
                        env["BO_NO_OP_OPTIMIZATIONS"] = "1"
                    result = subprocess.run(
                        [str(C_BIN), "--dump", str(dump), "-e", code],
                        capture_output=True, text=True, env=env, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(dump.read_text(encoding="utf-8").strip(), "1 2 3 4 5")

    @unittest.skipUnless(C_BIN.exists(), "c/bo is not built")
    def test_c_accepts_very_long_zero_integer(self):
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory) / "stack"
            result = subprocess.run(
                [str(C_BIN), "--dump", str(dump), "-e", "0" * 5000],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(dump.read_text(encoding="utf-8").strip(), "0")


if __name__ == "__main__":
    unittest.main()
