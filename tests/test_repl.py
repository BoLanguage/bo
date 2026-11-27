import contextlib
import io
import unittest
from unittest.mock import patch

from python.bo.machine import Machine
from python.bo.repl import repl


class ReplInputTests(unittest.TestCase):
    def test_op_source_and_multiline_input(self):
        machine = Machine()
        self.assertTrue(machine.include_file("include/core.bo"))
        self.assertTrue(machine.include_file("include/std.bo"))
        prompts = []
        inputs = iter(["(1", "2 +) apply", '"OP" selector', ""])

        def reader(prompt):
            prompts.append(prompt)
            text = next(inputs)
            if not text:
                raise EOFError
            return text

        with patch("python.bo.repl._make_reader", return_value=reader), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            repl(machine)
        from python.bo.values import Op
        self.assertEqual(machine.data, [3, [Op("OP")]])
        self.assertEqual(prompts, ["| ", "  ", "| ", "| "])


if __name__ == "__main__":
    unittest.main()
