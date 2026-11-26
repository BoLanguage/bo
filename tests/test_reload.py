"""Loading a file again first takes out what its earlier load left (items, locks, stacks)."""

import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from python.bo.machine import Machine
from python.bo.values import Word, to_str
from tests.diff_c import dump

ROOT = Path(__file__).resolve().parent.parent
C_BIN = ROOT / "c" / "bo"


class Reload(unittest.TestCase):
    def run_both(self, code, private_words=True):
        """The data stack after `code`, in the Python runtime and, when built, in C."""
        machine = Machine()
        machine.private_words = private_words
        errors = io.StringIO()
        with contextlib.chdir(ROOT), contextlib.redirect_stderr(errors):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.execute(code), errors.getvalue())
        if C_BIN.exists():
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "stack"
                env = dict(os.environ, **({} if private_words else {"BO_NO_PRIVATE": "1"}))
                result = subprocess.run([str(C_BIN), "--dump", str(path), "-e", code],
                                        cwd=ROOT, env=env, capture_output=True, text=True,
                                        timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(path.read_text(encoding="utf-8").strip(),
                                 " ".join(dump(value) for value in machine.data), code)
        return machine.data

    def test_a_reload_takes_out_the_items_the_file_pushed(self):
        self.assertEqual(self.run_both(
            '"tests/reload_a.bo" include "tests/reload_b.bo" include '
            '"tests/reload_a.bo" include (RELOAD-Y) SNAPSHOT'), [[2, 1]])

    def test_the_edited_file_goes_on_top_and_the_stacks_it_no_longer_makes_go(self):
        data = self.run_both(
            '"tests/reload_a.bo" include "tests/reload_b.bo" include '
            '1 (RELOAD-EDIT) PUSH "tests/reload_a.bo" include '
            '(RELOAD-Y) SNAPSHOT (RELOAD-TMP) EXISTS (RELOAD-EMPTY) EXISTS')
        self.assertEqual(data, [[2, 3], 0, 0])

    def test_what_the_program_pushed_stays_where_it_is(self):
        self.assertEqual(self.run_both(
            '"tests/reload_a.bo" include "tests/reload_b.bo" include 9 (RELOAD-Y) PUSH '
            '1 (RELOAD-EDIT) PUSH "tests/reload_a.bo" include (RELOAD-Y) SNAPSHOT'),
            [[2, 9, 3]])

    def test_a_stack_the_file_did_not_make_is_not_deleted(self):
        self.assertEqual(self.run_both(
            '(RELOAD-EMPTY) CLEAR "tests/reload_a.bo" include 1 (RELOAD-EDIT) PUSH '
            '"tests/reload_a.bo" include (RELOAD-EMPTY) EXISTS'), [1])

    def test_the_locks_of_the_file_are_lifted_and_set_again(self):
        self.assertEqual(self.run_both(
            '"tests/reload_lock.bo" include "tests/reload_lock.bo" include '
            '(RELOAD-L) DEPTH (RELOAD-L) LOCKED'), [1, 1])

    def test_a_failed_reload_puts_the_lock_back(self):
        self.assertEqual(self.run_both(
            '(RELOAD-L) CLEAR "tests/reload_lock.bo" include 1 (RELOAD-FAIL) PUSH '
            '("tests/reload_lock.bo" include) () catch drop '
            '(RELOAD-L) DEPTH (RELOAD-L) LOCKED (RELOAD-L) EXISTS'), [0, 1, 1])

    def test_a_stack_made_by_a_file_that_fails_on_reload_is_gone_not_locked(self):
        self.assertEqual(self.run_both(
            '"tests/reload_lock.bo" include 1 (RELOAD-FAIL) PUSH '
            '("tests/reload_lock.bo" include) () catch drop (RELOAD-L) EXISTS (RELOAD-L) LOCKED '
            '1 (RELOAD-L) PUSH (RELOAD-L) DEPTH'), [0, 0, 1])

    def test_it_works_when_private_words_are_switched_off(self):
        self.assertEqual(self.run_both(
            '"tests/reload_a.bo" include "tests/reload_a.bo" include (RELOAD-Y) DEPTH',
            private_words=False), [1])

    def test_include_refuses_a_file_that_is_being_loaded(self):
        data = self.run_both('("tests/cycle_a.bo" include) () catch')
        error = data[-1]
        self.assertEqual(error[1], [Word("INCLUDE")])
        self.assertEqual(error[0], [Word("Cycle-Error")])
        self.assertEqual(to_str(error[2][0]), "tests/cycle_a.bo")

    def test_require_follows_a_cycle_without_error(self):
        self.assertEqual(self.run_both(
            '"tests/cycle_c.bo" require "tests/cycle_c.bo" included "tests/cycle_d.bo" included'),
            [1, 1])

    def test_the_standard_streams_do_not_pile_up(self):
        self.assertEqual(self.run_both(
            '"include/std.bo" require "include/stream.bo" include "include/stream.bo" include '
            '(stdin) DEPTH (stdout) DEPTH (stderr) DEPTH (stdout) LOCKED'), [1, 1, 1, 1])


if __name__ == "__main__":
    unittest.main()
