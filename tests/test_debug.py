"""Debugging: a BREAKPOINT pauses a line of the C runtime's prompt, and what is typed there runs at
the pause point. `bo --debug` makes the prompt do this when its input is not a terminal."""

import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from python.bo.machine import Machine
from python.bo.values import Word

ROOT = Path(__file__).resolve().parent.parent
C_BIN = ROOT / "c" / "bo"
STD = '"include/std.bo" require'


def pause(name, stack, step):
    """What the prompt prints when a program pauses."""
    return f"paused{f' in {name}' if name else ''}\n  stack: {stack}\n  step: {step}\n"


def python_machine():
    machine = Machine()
    with contextlib.redirect_stderr(io.StringIO()):
        assert machine.include_file("include/core.bo") and machine.include_file("include/std.bo")
    return machine


@unittest.skipUnless(C_BIN.exists(), "the C runtime is not built")
class PausedPrompt(unittest.TestCase):
    def session(self, *lines, flags=("--debug",), generic=False):
        env = os.environ.copy()
        env.pop("BO_NO_OP_OPTIMIZATIONS", None)
        if generic:
            env["BO_NO_OP_OPTIMIZATIONS"] = "1"
        result = subprocess.run([str(C_BIN), *flags], input="\n".join((STD, *lines)) + "\n",
                                cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
        return result.stdout, result.stderr

    def both(self, *lines):
        """The same session with and without specialized operations, which must not differ."""
        specialized = self.session(*lines)
        self.assertEqual(self.session(*lines, generic=True), specialized)
        return specialized

    def test_a_breakpoint_pauses_and_the_prompt_runs_at_the_pause_point(self):
        out, err = self.both("(1 @ +) (succ_debug) PUSH", "2 succ_debug", "ps", "10 +", "step", "ps")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("succ_debug", "2 1", "+") + "  1: 2\n  0: 1\n  0: 13\n")

    def test_step_goes_into_user_words_and_next_runs_them(self):
        program = ("(1 +) (succ) PUSH", "(@ succ succ) (twice) PUSH", "0 twice")
        out, err = self.both(*program, "step", "step", "step")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("twice", "0", "succ") + pause("succ", "0", "1")
                         + pause("succ", "0 1", "+") + pause("twice", "1", "succ"))
        out, err = self.both(*program, "next", "next", "ps")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("twice", "0", "succ") + pause("twice", "1", "succ") + "  0: 2\n")

    def test_step_stops_before_literals_and_words_of_the_users_code_only(self):
        out, err = self.both("(1 +) (succ) PUSH", "(@ 5 dup + succ) (f) PUSH", "f", "step", "step", "step")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("f", "(empty)", "5") + pause("f", "5", "dup")
                         + pause("f", "5 5", "+") + pause("f", "10", "succ"))

    def test_continue_runs_to_the_next_breakpoint_or_the_end_and_stop_drops_the_program(self):
        program = ("(1 @ 2 @ 3) (f) PUSH", "f")
        out, err = self.both(*program, "continue", "ps", "continue", "ps")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("f", "1", "2") + pause("f", "1 2", "3")
                         + "  1: 1\n  0: 2\n  2: 1\n  1: 2\n  0: 3\n")
        out, err = self.both(*program, "stop", "ps")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("f", "1", "2") + "  0: 1\n")

    def test_the_commands_raise_debug_error_when_nothing_is_paused(self):
        _, err = self.both("step", "next", "continue", "stop", "(1 2) (3) catch")
        self.assertEqual(err.splitlines(), [f"Uncaught Exception -- stdin:1 Debug-Error ({name}) ()"
                                            for name in ("STEP", "NEXT", "CONTINUE", "STOP")])

    def test_an_error_at_the_prompt_is_not_caught_by_the_paused_program(self):
        out, err = self.both("(@ 1) (drop 99) catch", "1 0 /", "continue", "ps")
        self.assertIn("Domain-Error (DIV)", err)
        self.assertEqual(out, pause(None, "(empty)", "1") + "  2: 1\n  1: 0\n  0: 1\n")

    def test_where_lists_the_programs_being_run(self):
        out, err = self.both("(1 @ +) (s) PUSH", "(0 s 5) (outer) PUSH", "outer", "where", "step", "where")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("s", "0 1", "+") + "s: (1 @) | (+)\nouter: (0 s) | (5)\n"
                         + pause("outer", "1", "5") + "outer: (0 s) | (5)\n")

    def test_an_exception_handler_that_is_a_breakpoint_pauses_where_an_error_happened(self):
        out, err = self.both("(1 0 /) (bad) PUSH", "(@) (EXCEPTION) PUSH", "7 bad 5", "continue",
                             "(EXCEPTION) POP drop", "ps")
        error = "((Domain-Error) (DIV) (1 0) (115 116 100 105 110) 1)"
        self.assertEqual(err, "")
        self.assertTrue(out.startswith(pause(None, f"7 1 0 {error}", "5")), out)
        self.assertTrue(out.endswith(f"  4: 7\n  3: 1\n  2: 0\n  1: {error}\n  0: 5\n"), out)

    def test_break_on_error_pauses_at_the_error_and_continue_reports_it(self):
        out, err = self.both("(1 0 /) (bad) PUSH", "break-on-error", "7 bad 5", "continue", "break-off-error",
                             "(EXCEPTION) DEPTH")
        error = "((Domain-Error) (DIV) (1 0) (115 116 100 105 110) 1)"
        self.assertEqual(out, "error: Domain-Error DIV\n" + pause(None, f"7 1 0 {error}", "rethrow"))
        self.assertIn("Uncaught Exception -- stdin:1 Domain-Error (DIV) (1 0)", err)
        out, _ = self.both("break-on-error", "(1 0 /) (drop 3) catch", "break-off-error", "ps")
        self.assertEqual(out, "  2: 1\n  1: 0\n  0: 3\n", "a caught error does not pause")

    def test_a_conditional_breakpoint_pauses_only_when_its_condition_holds(self):
        out, err = self.both("(dup 2 > @if drop) (f) PUSH", "1 f", "2 f", "3 f")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("f", "3", "drop"))

    def test_end_of_input_leaves_a_paused_program_alone(self):
        out, err = self.both("(@ 1) (f) PUSH", "f")
        self.assertEqual(err, "")
        self.assertEqual(out, pause("f", "(empty)", "1"))

    def test_without_the_option_a_breakpoint_does_nothing_on_piped_input(self):
        out, err = self.session("(1 @ +) (s) PUSH", "2 s", "ps", flags=())
        self.assertEqual((out, err), ("  0: 3\n", ""))

    def test_a_breakpoint_in_a_script_or_an_included_file_does_nothing(self):
        result = subprocess.run([str(C_BIN), "-e", f"{STD} (1 @ 2) apply ps"], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual((result.stdout, result.stderr), ("  1: 1\n  0: 2\n", ""))

    def test_a_syntax_error_in_a_line_is_reported_and_nothing_pauses(self):
        out, err = self.session("1 )", "2 ps")
        self.assertEqual(out, "  0: 2\n")
        self.assertIn("Syntax-Error", err)


@unittest.skipUnless(C_BIN.exists(), "the C runtime is not built")
class DebuggedFile(unittest.TestCase):
    """`bo --debug FILE` stops before the first item of the file; `continue` runs to the next `@`."""

    PROGRAM = (f"{STD}\n(1 +) (succ) PUSH\n(2 *) (__double) PUSH\n(__double succ) (f) PUSH\n"
               "5 f\n@\n10 *\n\"done\" emits nl\n")

    def run_bo(self, *arguments, text="", generic=False, files=None):
        env = os.environ.copy()
        env.pop("BO_NO_OP_OPTIMIZATIONS", None)
        if generic:
            env["BO_NO_OP_OPTIMIZATIONS"] = "1"
        with tempfile.TemporaryDirectory() as directory:
            for name, content in (files or {"program.bo": self.PROGRAM}).items():
                (Path(directory) / name).write_text(content, encoding="utf-8")
            arguments = [str(Path(directory) / a) if a.endswith(".bo") else a for a in arguments]
            result = subprocess.run([str(C_BIN), *arguments], input=text, cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=30)
            result.stdout = result.stdout.replace(directory, "DIR")
            result.stderr = result.stderr.replace(directory, "DIR")
        return result

    def both(self, *arguments, **options):
        results = [self.run_bo(*arguments, generic=generic, **options) for generic in (False, True)]
        self.assertEqual([(r.stdout, r.stderr, r.returncode) for r in results[1:]],
                         [(results[0].stdout, results[0].stderr, results[0].returncode)])
        return results[0]

    def test_it_stops_before_the_first_item_and_continue_runs_to_the_breakpoint(self):
        result = self.both("--debug", "program.bo", text="step\nstep\nps\ncontinue\nps\ncontinue\n")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        first = "paused\n  stack: (empty)\n  step: (105 110 99 108 117 100 101 47 115 116 100 46 98 111)\n"
        self.assertEqual(result.stdout, first + pause(None, "(105 110 99 108 117 100 101 47 115 116 100 46 98 111)", "require")
                         + pause(None, "(empty)", "(1 +)") + pause(None, "11", "10") + "  0: 11\ndone\n")

    def test_next_goes_on_to_the_following_line_after_a_call_that_ends_a_line(self):
        files = {"n.bo": "(1 +) (succ) PUSH\n5 succ\n7\n"}
        result = self.both("--debug", "n.bo", files=files, text="next\n" * 6)
        steps = [line.split("step: ")[1] for line in result.stdout.splitlines() if "step:" in line]
        self.assertEqual(steps, ["(1 +)", "(succ)", "5", "succ", "7"])

    def test_private_words_of_the_file_work_and_exit_status_is_kept(self):
        files = {"p.bo": f"{STD}\n(2 *) (__dbl) PUSH\n(__dbl __dbl) (quad) PUSH\n5 quad emit nl\n3 exit\n"}
        result = self.both("--debug", "p.bo", files=files, text="continue\n")
        self.assertEqual((result.returncode, result.stdout.splitlines()[-1]), (3, "20"))

    def test_an_error_reports_the_same_and_gives_status_1(self):
        files = {"e.bo": f"{STD}\n(1 0 /) (bad) PUSH\nbad\n"}
        debugged = self.both("--debug", "e.bo", files=files, text="continue\n")
        plain = self.both("e.bo", files=files)
        self.assertEqual((debugged.returncode, plain.returncode), (1, 1))
        self.assertIn("Domain-Error (DIV)", debugged.stderr)
        self.assertEqual(debugged.stderr.replace("(end of input: continuing)\n", ""), plain.stderr)

    def test_the_end_of_the_input_continues_the_program(self):
        result = self.both("--debug", "program.bo")
        self.assertEqual(result.returncode, 0)
        self.assertTrue(result.stdout.endswith("  step: 10\ndone\n"), result.stdout)
        self.assertEqual(result.stderr.count("(end of input: continuing)"), 2)

    def test_only_the_first_program_stops_at_its_start(self):
        files = {"a.bo": f"{STD} 1 emit nl\n"}
        result = self.both("--debug", "-e", f"{STD} 7 emit nl", "a.bo", files=files, text="continue\n")
        self.assertEqual(result.stdout.count("paused"), 1)
        self.assertEqual(result.stdout.splitlines()[-2:], ["7", "1"])

    def test_a_file_that_cannot_be_read_is_reported(self):
        result = self.run_bo("--debug", "missing.bo")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Cannot read", result.stderr)


class DebuggingInPython(unittest.TestCase):
    def test_python_has_no_prompt_to_pause_so_a_breakpoint_does_nothing(self):
        machine = python_machine()
        self.assertTrue(machine.execute("1 @ 2 (3) () BREAKPOINT"))
        self.assertEqual(machine.data, [1, 2, [3]])

    def test_the_commands_raise_debug_error(self):
        machine = python_machine()
        for name in ("STEP", "NEXT", "CONTINUE", "STOP"):
            with self.subTest(name=name):
                self.assertTrue(machine.execute(f"(() {name}) () catch"))
                error = machine.data.pop()
                self.assertEqual(error[:3], [[Word("Debug-Error")], [Word(name)], []])

    def test_backtrace_lists_the_programs_with_their_names_and_positions(self):
        machine = python_machine()
        self.assertTrue(machine.execute("(1 backtrace 2) (inner) PUSH (inner 3) (outer) PUSH outer"))
        first, frames, *rest = machine.data
        self.assertEqual((first, rest), (1, [2, 3]))
        wrapper, inner, outer = frames
        self.assertEqual(wrapper, [[Word("backtrace")], [[], Word("BACKTRACE")], 2])
        self.assertEqual(inner, [[Word("inner")], [1, Word("backtrace"), 2], 2])
        self.assertEqual(outer, [[Word("outer")], [Word("inner"), 3], 1])

    def test_watch_writes_the_text_and_the_top_items_to_standard_error_and_changes_nothing(self):
        machine = python_machine()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertTrue(machine.execute('7 8 9 "after" 2 watch "none" 0 watch "all" 10 watch'))
        self.assertEqual(machine.data, [7, 8, 9])
        self.assertEqual((out.getvalue(), err.getvalue()), ("", "after: (8 9)\nnone\nall: (7 8 9)\n"))

    def run_machine(self, code):
        machine = python_machine()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            machine.execute(code)
        return machine, out.getvalue(), err.getvalue()

    def test_trace_writes_entry_and_exit_lines_indented_by_the_nesting_of_traced_words(self):
        machine, out, err = self.run_machine(
            "(1 +) (succ) PUSH (succ succ) (twice) PUSH (twice) 2 trace (succ) 0 trace 10 20 twice")
        self.assertEqual(machine.data, [10, 22])
        self.assertEqual(out, "")
        self.assertEqual(err, "> twice (10 20)\n  > succ\n  < succ\n  > succ\n  < succ\n< twice (10 22)\n")

    def test_untrace_restores_the_word_and_tracing_again_replaces_the_old_trace(self):
        machine, _, err = self.run_machine(
            "(1 +) (succ) PUSH (succ) 1 trace (succ) 1 trace 1 succ (succ) untrace 2 succ (succ) untrace "
            "(succ) DEPTH")
        self.assertEqual(machine.data, [2, 3, 1])
        self.assertEqual(err, "> succ (1)\n< succ (2)\n")

    def test_a_traced_word_that_fails_does_not_confuse_the_indent_afterwards(self):
        machine, _, err = self.run_machine(
            "(1 0 /) (bad) PUSH (1 +) (succ) PUSH (bad) 0 trace (succ) 0 trace (bad) (drop) catch 7 succ")
        self.assertEqual(err, "> bad\n> succ\n< succ\n")

    def test_watch_leaves_standard_output_where_it_was_even_after_an_error(self):
        machine = python_machine()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.execute('("x" (a) watch) () catch drop (stdout) DEPTH (stdout) LOCKED stdout'))
        self.assertEqual(machine.data[-3:], [1, 1, 1])


if __name__ == "__main__":
    unittest.main()
