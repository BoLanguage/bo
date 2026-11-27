import contextlib
import io
import unittest

from python.bo.machine import Machine
from python.bo.values import Op, from_str


def run(code):
    machine = Machine()
    with contextlib.redirect_stderr(io.StringIO()):
        assert machine.include_file("include/core.bo") and machine.include_file("include/std.bo")
        assert machine.execute(code)
    return machine.data


class CallAndDiagnostics(unittest.TestCase):
    def test_call_order_and_results(self):
        self.assertEqual(run("(1) (2) (999) (3) call"), [1, 2, 3])
        self.assertEqual(run("(1) (S) PUSH (2) (S) PUSH (3) (S) PUSH "
                             "(4) (S) PUSH (S) CALL"), [1, 2, 4])

    def test_body_failure_runs_cleanup_before_catcher(self):
        data = run("() (MISSING) (42) (17) call (DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(data[0], 17)
        error = data[1]
        self.assertEqual(error[:3], [[Op("Existence-Error")], [Op("EXECUTE")],
                                     [[Op("MISSING")]]])
        self.assertEqual(data[2], 42)
        self.assertEqual(data[3], [error])

    def test_setup_failure_skips_body_cleanup_and_catcher(self):
        data = run("((MISSING) (1) (2) (3) call) () catch (DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0][0], [Op("Existence-Error")])
        self.assertEqual(data[1], [data[0]])

    def test_invalid_call_operand_is_restored_and_recorded(self):
        data = run("(() 7 () () call) () catch (DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(data[:4], [[], 7, [], []])
        self.assertEqual(data[4][:3], [[Op("Type-Error")], [Op("CALL")], [7]])
        self.assertEqual(data[5], [data[4]])

    def test_cleanup_failure_after_success_propagates(self):
        data = run("(() (5) (99) (MISSING) call) () catch (DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(data[0], 5)
        self.assertEqual(data[1][2], [[Op("MISSING")]])
        self.assertEqual(data[2], [data[1]])

    def test_cleanup_failure_wins_and_both_errors_are_recorded(self):
        data = run("(() (MISSING) (99) (OTHER-MISSING) call) () catch "
                   "(DIAGNOSTICS) SNAPSHOT")
        error, history = data
        self.assertEqual(error[2], [[Op("OTHER-MISSING")]])
        self.assertEqual([entry[2] for entry in history],
                         [[[Op("MISSING")]], [[Op("OTHER-MISSING")]]])
        self.assertEqual(error, history[1])

    def test_rethrow_preserves_original_once_and_consumes_operand(self):
        data = run("((MISSING) (rethrow) catch) () catch (DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0][1:3], [[Op("EXECUTE")], [[Op("MISSING")]]])
        self.assertEqual(data[1], [data[0]])

    def test_rethrow_preserves_original_source_and_line(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.include_file("include/std.bo"))
            self.assertTrue(machine.execute("(MISSING) () catch", "original.bo", 12))
            original = machine.data[-1]
            self.assertTrue(machine.execute("(rethrow) () catch", "other.bo", 99))
        self.assertEqual(machine.data, [original])
        self.assertEqual(original[3:], [from_str("original.bo"), 12])

    def test_rethrow_after_clearing_does_not_add_an_entry(self):
        data = run("(MISSING) () catch (DIAGNOSTICS) UNLOCK (DIAGNOSTICS) CLEAR "
                   "(DIAGNOSTICS) LOCK (rethrow) () catch (DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(data[0][2], [[Op("MISSING")]])
        self.assertEqual(data[1], [])

    def test_uncaught_rethrow_reports_original_source(self):
        machine = Machine()
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.include_file("include/std.bo"))
            self.assertTrue(machine.execute("(MISSING) () catch", "original.bo", 12))
            self.assertFalse(machine.execute("rethrow", "other.bo", 99))
        self.assertIn("original.bo:12 Existence-Error (EXECUTE)", errors.getvalue())

    def test_rethrow_rejects_malformed_error_and_restores_operand(self):
        for value in ("7", "()", '(("A") (2) () () 1)', '("A" "B" () () 1.5)',
                      '("A" "B" () (55296) 1)', '("Type-Error" (DIV) () () 1)',
                      '((Type-Error) "DIV" () () 1)', '((7) (DIV) () () 1)'):
            with self.subTest(value=value):
                data = run(f"({value} rethrow) () catch (DIAGNOSTICS) SNAPSHOT")
                self.assertEqual(data[-2][0], [Op("Type-Error")])
                self.assertEqual(data[-2][1], [Op("RETHROW")])
                self.assertEqual(data[-1], [data[-2]])
                self.assertEqual(data[-2][2], [data[0]])

    def test_throw_takes_an_op_unit_as_the_error_kind(self):
        data = run("((7) (Disk-Full) throw) () catch")
        self.assertEqual(data[-1][:3], [[Op("Disk-Full")], [Op("THROW")], [7]])
        for kind in ('"Disk-Full"', "(1)", "(A B)", "()", "7"):
            with self.subTest(kind=kind):
                data = run(f"((7) {kind} throw) () catch")
                self.assertEqual(data[-1][:2], [[Op("Type-Error")], [Op("THROW")]])

    def test_nested_calls_and_rethrow_keep_history(self):
        data = run("(() (() (MISSING) (rethrow) (1) call) (rethrow) (2) call) "
                   "() catch (DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(data[:2], [1, 2])
        self.assertEqual(data[2][2], [[Op("MISSING")]])
        self.assertEqual(data[3], [data[2]])

    def test_catcher_failure_occurs_after_cleanup(self):
        data = run("(() (MISSING) (OTHER-MISSING) (17) call) () catch "
                   "(DIAGNOSTICS) SNAPSHOT")
        self.assertEqual(data[0], 17)
        self.assertEqual(data[1][2], [[Op("MISSING")]])
        self.assertEqual(data[2][2], [[Op("OTHER-MISSING")]])
        self.assertEqual(data[3], [data[1], data[2]])

    def test_diagnostics_locked_by_default_and_user_managed(self):
        data = run("(MISSING) () catch drop (DIAGNOSTICS) DEPTH "
                   "(DIAGNOSTICS) UNLOCK (DIAGNOSTICS) CLEAR "
                   "(DIAGNOSTICS) DEPTH (DIAGNOSTICS) LOCK")
        self.assertEqual(data, [1, 0])
        data = run("(42 (DIAGNOSTICS) PUSH) () catch (DIAGNOSTICS) TOP")
        self.assertEqual(data[2][0], [Op("Permission-Error")])
        self.assertEqual(data[2], data[3])

if __name__ == "__main__":
    unittest.main()
