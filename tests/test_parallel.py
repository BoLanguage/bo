import contextlib
import io
import unittest

from python.bo.machine import Machine, WORD_DIAGNOSTICS_KEY
from python.bo.values import Word, canon, from_str


class ParallelTests(unittest.TestCase):
    def run_bo(self, code):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            result = machine.execute(
                '"include/core.bo" () INCLUDE "include/std.bo" () INCLUDE ' + code
            )
        self.assertTrue(result)
        return machine

    def test_parallel_runs_callbacks_and_preserves_input_order(self):
        machine = self.run_bo(
            "(1 2 3) (2 *) parallel "
            "(1 2) (dup dup) parallel "
            "(1 2) (drop) parallel "
            "() (dup) parallel"
        )
        self.assertEqual(
            machine.data,
            [[[2], [4], [6]], [[1, 1, 1], [2, 2, 2]], [[], []], []],
        )

    def test_nested_and_named_stack_parallel_calls(self):
        machine = self.run_bo(
            "(1 2) ((3 4) (2 *) parallel) parallel "
            "(1 2) (WORK) PUSH (2 *) (WORK) PUSH "
            "(WORK) PARALLEL (WORK) SNAPSHOT"
        )
        self.assertEqual(
            machine.data,
            [
                [[1, [[6], [8]]], [2, [[6], [8]]]],
                [[[2], [4]]],
            ],
        )

    def test_worker_stacks_are_isolated_and_not_merged(self):
        machine = self.run_bo(
            "(1 2) (1 (WORK) PUSH (WORK) DEPTH) parallel "
            "(WORK) SNAPSHOT"
        )
        self.assertEqual(machine.data, [[[1, 1], [2, 1]], []])

    def test_worker_error_is_rethrown_and_recorded_once(self):
        machine = self.run_bo(
            "((1 0) (1 swap /) parallel) () catch"
        )
        error = machine.data[0]
        self.assertEqual(error[:2], [[Word("Domain-Error")], [Word("DIV")]])
        self.assertEqual(machine.stacks[WORD_DIAGNOSTICS_KEY], [error])

    def test_worker_exit_becomes_parallel_error(self):
        machine = self.run_bo("((1) (0 exit) parallel) () catch")
        self.assertEqual(
            machine.data[0][:2],
            [[Word("Evaluation-Error")], [Word("PARALLEL")]],
        )

    def test_invalid_operands_raise_parallel_type_error(self):
        machine = self.run_bo("(42 (dup) () PARALLEL) () catch")
        self.assertEqual(machine.data[-1][:2], [
            [Word("Type-Error")], [Word("PARALLEL")]
        ])

    def test_control_parallel_is_an_unlocked_default_adapter(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.execute(
                '"include/core.bo" () INCLUDE'
            ))
        key = canon([Word("parallel")])
        self.assertEqual(machine.stacks[key], [[[], Word("PARALLEL")]])
        self.assertNotIn(key, machine.locked)


if __name__ == "__main__":
    unittest.main()
