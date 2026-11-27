"""Private ops: in a source file an op that starts with `__` belongs to that file."""

import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from python.bo.machine import Machine
from python.bo.values import to_str

ROOT = Path(__file__).resolve().parent.parent
STD = str(ROOT / "include" / "std.bo")


def machine_with(files, std=True, private=True):
    """A machine that has loaded the files, given as {name: text}, from a temporary directory."""
    machine = Machine()
    machine.private_ops = private
    if std:
        assert machine.include_file(str(ROOT / "include" / "core.bo"))
        assert machine.include_file(STD)
    with tempfile.TemporaryDirectory() as directory:
        for name, text in files.items():
            path = Path(directory) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        for name in files:
            if name.endswith("main.bo") or not any(n.endswith("main.bo") for n in files):
                assert machine.include_file(str(Path(directory) / name)), name
    return machine


def error_kind(machine, text):
    """The kind of the error that `text` raises, or None."""
    with redirect_stderr(io.StringIO()) as stderr:
        ok = machine.execute(text)
    return None if ok else stderr.getvalue().split(" ")[4]


class PrivateOps(unittest.TestCase):
    def test_a_private_op_works_in_its_file_and_is_unreachable_elsewhere(self):
        machine = machine_with({"main.bo": """
(+) (__plus) PUSH
(1 __plus) (succ) PUSH
(__plus) EXISTS (__plus) TOP
"""})
        self.assertEqual(machine.data[0], 1)  # inside the file the op exists
        machine.data.clear()
        self.assertTrue(machine.execute("2 succ"))
        self.assertEqual(machine.data, [3])
        machine.data.clear()
        self.assertTrue(machine.execute("(__plus) EXISTS"))
        self.assertEqual(machine.data, [0])
        self.assertEqual(error_kind(machine, "1 2 __plus"), "Existence-Error")
        self.assertEqual(error_kind(machine, "(__plus) TOP"), "Stack-Error")  # as for any absent stack

    def test_the_code_of_a_public_op_shows_the_private_op_by_name(self):
        machine = machine_with({"main.bo": "(+) (__plus) PUSH\n(1 __plus) (succ) PUSH\n"})
        self.assertTrue(machine.execute("(succ) TOP"))
        self.assertEqual([getattr(item, "name", item) for item in machine.data[-1]], [1, "__plus"])

    def test_private_ops_are_not_in_the_lexicon(self):
        machine = machine_with({"main.bo": "(1) (__hidden) PUSH\n(1) (shown) PUSH\n"})
        self.assertTrue(machine.execute("() LEXICON"))
        names = [item[0].name for item in machine.data[-1]]
        self.assertIn("shown", names)
        self.assertNotIn("__hidden", names)
        self.assertNotIn("__hidden", machine.stack_snapshot()["named"])

    def test_two_files_may_use_the_same_private_name(self):
        machine = machine_with({
            "a/lib.bo": "(1) (__x) PUSH\n(__x) (one) PUSH\n",
            "b/lib.bo": "(2) (__x) PUSH\n(__x) (two) PUSH\n",
        })
        self.assertTrue(machine.execute("one two"))
        self.assertEqual(machine.data, [1, 2])

    def test_a_private_op_given_to_a_callback_keeps_its_meaning(self):
        machine = machine_with({
            "lib.bo": "(dup *) (__square) PUSH\n((__square)) (callback) PUSH\n",
        })
        self.assertTrue(machine.execute("3 callback apply"))
        self.assertEqual(machine.data, [9])

    def test_private_ops_may_be_recursive_and_mutually_recursive(self):
        machine = machine_with({"main.bo": """
((dup 0 =) (drop 1) (dup 1 - __fact *) ifte) (__fact) PUSH
((dup 0 =) (drop 1) (1 - __odd) ifte) (__even) PUSH
((dup 0 =) (drop 0) (1 - __even) ifte) (__odd) PUSH
(__fact) (fact) PUSH
(__even) (even) PUSH
"""})
        self.assertTrue(machine.execute("5 fact 10 even 7 even"))
        self.assertEqual(machine.data, [120, 1, 0])

    def test_equality_tells_a_private_op_from_a_plain_one(self):
        machine = machine_with({"main.bo": "(1 __w) (code) PUSH\n(7) (__w) PUSH\n"})
        self.assertTrue(machine.execute("(code) TOP unconsl drop (__w) ="))
        self.assertEqual(machine.data, [0])
        machine.data.clear()
        self.assertTrue(machine.execute("(code) TOP unconsl drop name (__w) name ="))
        self.assertEqual(machine.data, [1])

    def test_loading_a_file_again_replaces_its_private_ops(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lib.bo"
            path.write_text("(1) (__x) PUSH\n(__x) (get-x) PUSH\n", encoding="utf-8")
            machine = Machine()
            self.assertTrue(machine.include_file(str(path)))
            path.write_text("(2) (__x) PUSH\n(__x) (get-x) PUSH\n", encoding="utf-8")
            self.assertTrue(machine.execute(f'"{path}" () INCLUDE get-x'))
            self.assertEqual(machine.data, [2])
            self.assertEqual(len([k for k in machine.stacks if len(k[1]) == 1 and len(k[1][0]) == 3]), 1)

    def test_outside_a_file_and_without_ownership_the_ops_are_plain(self):
        machine = machine_with({})
        self.assertTrue(machine.execute("(1 +) (__inc) PUSH 2 __inc"))
        self.assertEqual(machine.data, [3])
        machine = machine_with({"main.bo": "(1 +) (__inc) PUSH\n"}, private=False)
        self.assertTrue(machine.execute("2 __inc"))
        self.assertEqual(machine.data, [3])

    def test_a_private_op_can_call_public_ops_in_tail_position_without_growth(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tail.bo"
            path.write_text("""
((dup 0 =) (drop) (1 - again) ifte) (__down) PUSH
(__down) (again) PUSH
3000 again
""", encoding="utf-8")
            machine = Machine()
            self.assertTrue(machine.include_file(str(ROOT / "include" / "core.bo")))
            self.assertTrue(machine.include_file(STD))
            deepest = [0]
            enter = machine._enter

            def watch(element, name=None):
                deepest[0] = max(deepest[0], len(machine.control))
                enter(element, name)

            machine._enter = watch
            self.assertTrue(machine.include_file(str(path)))
            self.assertLess(deepest[0], 40)


if __name__ == "__main__":
    unittest.main()
