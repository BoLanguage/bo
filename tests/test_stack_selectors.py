import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from python.bo.machine import Machine
from python.bo.values import BoError, Word, canon, from_str
from tests.diff_c import dump


ROOT = Path(__file__).resolve().parent.parent
C_BIN = ROOT / "c" / "bo"
OPERATIONS = (
    "PUSH", "POP", "TOP", "SNAPSHOT", "DEPTH", "CLEAR", "LOCK", "UNLOCK",
    "DROP", "PICK", "ROLL", "UNIT", "CONSL", "CONSR", "UNCONSL", "UNCONSR",
    "TYPE", "RATIO", "APPLY", "IFTE", "LOOP", "PARALLEL",
    "ADD", "SUB", "MUL", "DIV", "IDIV",
    "POW", "BROADCAST", "EQUAL", "OPEN", "CLOSE", "READ", "WRITE", "INCLUDE", "INCLUDED", "PARSE",
    "CATCH", "CALL", "THROW", "RETHROW", "EXIT", "ABORT", "UNITTYPE", "WORD",
    "TEXT", "ARRAY", "SHAPE", "RANK", "RESHAPE", "FETCH", "STORE",
    "CHUNK", "CONCAT", "REDUCE", "DOT", "MEAN", "MEDIAN", "TRANSPOSE", "OUTER", "MATMUL",
    "LEXICON", "DELETE", "BREAKPOINT", "STEP", "NEXT", "CONTINUE", "STOP", "BACKTRACE",
)


class StackSelectors(unittest.TestCase):
    def run_both(self, source, library=True):
        if library:
            source = '"include/core.bo" () INCLUDE "include/std.bo" () INCLUDE ' + source
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
                    stack_path = Path(directory) / "stack"
                    result = subprocess.run(
                        [str(C_BIN), "--bare", "--dump", str(stack_path), "-e", source],
                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, (mode, source, result.stderr))
                    self.assertEqual(result.stderr, "", (mode, source))
                    self.assertEqual(
                        stack_path.read_text(encoding="utf-8").strip(),
                        " ".join(dump(value) for value in machine.data),
                        (mode, source),
                    )
        return machine

    def check_rejected(self, selector_source, selector, operation):
        prefix = "9 " if operation == "PUSH" else ""
        machine = self.run_both(f"({prefix}{selector_source} {operation}) () catch")
        expected_operands = ([9] if prefix else []) + [selector]
        self.assertEqual(machine.data[:-1], expected_operands)
        error = machine.data[-1]
        self.assertEqual(error[:3], [[Word("Type-Error")], [Word(operation)], [selector]])
        if isinstance(selector, list) and selector:
            self.assertNotIn(canon(selector), machine.stacks)

    def test_invalid_selector_shapes(self):
        cases = (
            ("42", 42),
            ("(7)", [7]),
            ("((a))", [[Word("a")]]),
            ("(a b)", [Word("a"), Word("b")]),
            ('"name"', from_str("name")),
        )
        for source, value in cases:
            for operation in ("PUSH", "POP", "TOP", "SNAPSHOT", "DEPTH", "CLEAR", "LOCK", "UNLOCK"):
                with self.subTest(selector=source, operation=operation):
                    self.check_rejected(source, value, operation)

    def test_all_selected_primitives_reject_invalid_selectors(self):
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                self.check_rejected("(a b)", [Word("a"), Word("b")], operation)

    def test_default_and_word_selectors_remain_usable(self):
        machine = self.run_both(
            "3 4 () ADD 5 (Name) PUSH 6 (name) PUSH "
            '(Name) TOP (name) TOP "Name" word TOP (Name) POP (name) POP'
        )
        self.assertEqual(machine.data, [7, 5, 6, 5, 5, 6])

    def test_stacks_lists_every_stack_that_exists_in_order_of_name(self):
        machine = self.run_both(
            "1 (zz-b) PUSH 2 (zz-a) PUSH 3 (zz-c) PUSH (zz-c) CLEAR () LEXICON "
            '(apply text "zz-" startswith) filter'
        )
        self.assertEqual(machine.data, [[[Word("zz-a")], [Word("zz-b")], [Word("zz-c")]]],
                         "an emptied stack still exists")
        machine = self.run_both(
            "1 (zz-a) PUSH 1 (zz-aa) PUSH 1 (zz-_) PUSH 1 (zz-B) PUSH () LEXICON "
            '(apply text "zz-" startswith) filter'
        )
        self.assertEqual(
            machine.data, [[[Word("zz-B")], [Word("zz-_")], [Word("zz-a")], [Word("zz-aa")]]],
            "by code point: capitals, then _, then a shorter name before a longer one",
        )

    def test_stacks_includes_the_primitives_and_agrees_in_both_runtimes(self):
        # run_both compares the whole list, so the runtimes must agree on every name that exists
        machine = self.run_both("() LEXICON", library=False)
        names = [unit[0].name for unit in machine.data[0]]
        self.assertGreater(len(names), 55)
        self.assertIn("PUSH", names)
        self.assertIn("DIAGNOSTICS", names)
        self.assertEqual(names, sorted(names))
        machine = self.run_both("() LEXICON len ((PUSH)) () LEXICON in")
        self.assertEqual(machine.data[1], 1)

    def test_stacks_on_a_named_stack_leaves_the_list_there_and_lists_the_stack_selected(self):
        machine = self.run_both(
            '7 1 (zz-q) PUSH (zz-box) LEXICON (zz-box) POP (apply text "zz-" startswith) filter'
        )
        self.assertEqual(machine.data, [7, [[Word("zz-box")], [Word("zz-q")]]],
                         "selecting a stack makes it exist")

    def test_stacks_gives_selectors_that_other_primitives_accept(self):
        machine = self.run_both(
            "1 (zz-x) PUSH 2 (zz-y) PUSH 3 (other) PUSH () LEXICON "
            '(apply text "zz-" startswith) filter (apply CLEAR) foreach (zz-x) DEPTH (zz-y) DEPTH (other) DEPTH'
        )
        self.assertEqual(machine.data, [0, 0, 1])

    def test_delete_ends_the_existence_of_a_stack_that_clear_only_empties(self):
        machine = self.run_both(
            "10 (zz-x) PUSH (zz-x) EXISTS (zz-x) CLEAR (zz-x) EXISTS (zz-x) DEPTH "
            "(zz-x) DELETE (zz-x) EXISTS (zz-x) DEPTH"
        )
        self.assertEqual(machine.data, [1, 1, 0, 0, 0])

    def test_delete_of_a_stack_that_does_not_exist_changes_nothing(self):
        machine = self.run_both("(zz-never) DELETE (zz-never) EXISTS (zz-never) DELETE")
        self.assertEqual(machine.data, [0])

    def test_a_deleted_stack_can_be_pushed_to_again_and_is_not_listed_while_gone(self):
        machine = self.run_both(
            '1 (zz-a) PUSH 2 (zz-b) PUSH (zz-a) DELETE () LEXICON (apply text "zz-" startswith) filter '
            "3 (zz-a) PUSH (zz-a) EXISTS (zz-a) DEPTH"
        )
        self.assertEqual(machine.data, [[[Word("zz-b")]], 1, 1])

    def test_delete_refuses_the_default_stack_locked_stacks_and_primitives(self):
        for source, selector in (
            ("()", []),
            ("(PUSH)", [Word("PUSH")]),
            ("(ADD)", [Word("ADD")]),
            ("(zz-locked)", [Word("zz-locked")]),
        ):
            with self.subTest(selector=source):
                machine = self.run_both(
                    f"1 (zz-locked) PUSH (zz-locked) LOCK ({source} DELETE) () catch {source} EXISTS"
                )
                error = machine.data[0]
                self.assertEqual(error[:3], [[Word("Permission-Error")], [Word("DELETE")], [selector]])
                self.assertEqual(machine.data[1], 1, "it still exists")

    def test_a_word_that_uses_a_deleted_stack_fails_until_the_stack_is_defined_again(self):
        machine = self.run_both(
            "(zz-v 1 +) (zz-use) PUSH 5 (zz-v) PUSH zz-use (zz-v) DELETE (zz-use) () catch "
            "8 (zz-v) PUSH zz-use"
        )
        self.assertEqual(machine.data[0], 6)
        self.assertEqual(machine.data[1][:2], [[Word("Existence-Error")], [Word("WORD")]])
        self.assertEqual(machine.data[2], 9)

    def test_locked_reports_primitives_and_stacks_locked_by_the_program(self):
        machine = self.run_both(
            "(ADD) LOCKED (PUSH) LOCKED (zz-l) LOCKED () LOCKED 1 (zz-l) PUSH (zz-l) LOCKED "
            "(zz-l) LOCK (zz-l) LOCKED (zz-l) UNLOCK (zz-l) LOCKED (zz-never) LOCKED (zz-never) EXISTS"
        )
        self.assertEqual(machine.data, [1, 1, 0, 0, 0, 1, 0, 0, 0])

    def test_the_default_stack_cannot_be_locked_and_unlocking_it_changes_nothing(self):
        machine = self.run_both("(() LOCK) () catch () UNLOCK () LOCKED 1 2 +")
        error, locked, total = machine.data
        self.assertEqual(error[:3], [[Word("Permission-Error")], [Word("LOCK")], [[]]])
        self.assertEqual((locked, total), (0, 3))

    def test_deleting_an_unlocked_primitive_stack_keeps_the_primitive(self):
        machine = self.run_both(
            "(ADD) UNLOCK 5 (ADD) PUSH (ADD) DELETE (ADD) EXISTS (ADD) DEPTH 1 2 () ADD "
            "() LEXICON (apply text \"ADD\" =) filter len"
        )
        self.assertEqual(machine.data, [1, 0, 3, 1])

    def test_locked_is_what_delete_refuses(self):
        machine = self.run_both(
            "1 (zz-a) PUSH 1 (zz-b) PUSH (zz-b) LOCK () LEXICON "
            '(apply text "zz-" startswith) filter (apply LOCKED 0 =) filter (apply DELETE) foreach '
            "(zz-a) EXISTS (zz-b) EXISTS"
        )
        self.assertEqual(machine.data, [0, 1])

    def test_the_kernel_stacks_exist_in_the_same_way_in_both_runtimes(self):
        machine = self.run_both(
            "(drop) EXISTS (ifte) EXISTS (EXCEPTION) EXISTS (DIAGNOSTICS) EXISTS (ADD) EXISTS (stdin) EXISTS",
            library=False,
        )
        self.assertEqual(machine.data, [0, 0, 0, 1, 1, 0])

    def test_names_with_comment_delimiters_are_rejected(self):
        machine = self.run_both('("a;b" word) () catch')
        self.assertEqual(machine.data[0], from_str("a;b"))
        self.assertEqual(machine.data[1][:2], [[Word("Representation-Error")], [Word("WORD")]])

    def test_invalid_host_constructed_word_is_not_a_selector(self):
        machine = Machine()
        for name in ("", "a;b", "2", "a b"):
            ref = [Word(name)]
            with self.subTest(name=name), self.assertRaises(BoError) as error:
                machine._ref(ref, create=True)
            self.assertEqual(error.exception.kind, "Representation-Error")
            self.assertNotIn(canon(ref), machine.stacks)


if __name__ == "__main__":
    unittest.main()
