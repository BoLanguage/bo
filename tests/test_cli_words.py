"""First-class-word behavior through the actual command-line entry points."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
C_BIN = ROOT / "c" / "bo"


class WordCli(unittest.TestCase):
    def commands(self):
        yield "python", [sys.executable, "-m", "python.bo"], None
        if C_BIN.exists():
            for mode, variable in (("generic-ops", "BO_NO_OP_OPTIMIZATIONS"),
                                   ("specialized-ops", None)):
                env = os.environ.copy()
                for key in ("BO_NO_OP_OPTIMIZATIONS",):
                    env.pop(key, None)
                if variable:
                    env[variable] = "1"
                yield mode, [str(C_BIN)], env

    def test_file_execution_and_nested_include(self):
        with tempfile.TemporaryDirectory() as directory:
            nested = Path(directory) / "nested.bo"
            program = Path(directory) / "program.bo"
            nested.write_text('(42) (OP) PUSH\n', encoding="utf-8")
            program.write_text(
                f'"{ROOT / "include" / "std.bo"}" () INCLUDE\n'
                f'"{nested}" () INCLUDE\n'
                '(OP 2) unconsl consl emit nl\n'
                '"OP" word text emits nl\n'
                '(OP) unittype emit nl\n'
                '"OP" word apply emit nl\n'
                '(NO-SUCH-WORD) (unconsl apply text emits nl) catch\n',
                encoding="utf-8",
            )
            for mode, command, env in self.commands():
                with self.subTest(mode=mode):
                    result = subprocess.run(command + [str(program)], cwd=ROOT, env=env,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, "")
                    self.assertEqual(result.stdout, "(OP 2)\nOP\n2\n42\nExistence-Error\n")

    def test_a_file_that_failed_to_load_is_required_again(self):
        with tempfile.TemporaryDirectory() as directory:
            inner = Path(directory) / "inner.bo"
            outer = Path(directory) / "outer.bo"
            inner.write_text('((BROKEN) EXISTS) (NOSUCH) () ifte\n1 (RAN) PUSH\n', encoding="utf-8")
            outer.write_text(f'"{inner}" () INCLUDE\n', encoding="utf-8")
            session = (
                '"include/std.bo" () INCLUDE\n'
                '1 (BROKEN) PUSH\n'
                f'"{outer}" require\n'
                f'"{outer}" included emit "{inner}" included emit (RAN) DEPTH emit nl\n'
                '(BROKEN) DELETE\n'
                f'"{outer}" require\n'
                f'"{outer}" included emit "{inner}" included emit (RAN) DEPTH emit nl\n'
            )
            for mode, command, env in self.commands():
                with self.subTest(mode=mode):
                    result = subprocess.run(command, cwd=ROOT, env=env, input=session,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Existence-Error", result.stderr)
                    self.assertRegex(result.stdout, r"000\s[|\s]*111\s")

    @unittest.skipUnless(C_BIN.exists(), "c/bo is not built")
    def test_c_prompt_does_not_erase_output_without_a_newline(self):
        import pty
        import select
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(ROOT)
            os.execv(str(C_BIN), [str(C_BIN)])

        def read_all():
            data = b""
            while select.select([fd], [], [], 1)[0]:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                data += chunk
            return data

        try:
            read_all()
            os.write(fd, b'"include/std.bo" require\n')
            read_all()
            os.write(fd, b'"hello" emits\n')
            first = read_all()
            os.write(fd, b'"bye" emits nl\n')
            second = read_all()
        finally:
            os.write(fd, b"\x04")
            os.close(fd)
            os.waitpid(pid, 0)
        # the prompt redraw starts with a carriage return and clears the line, so the output
        # must be followed by a line break before the prompt comes back
        self.assertIn(b"hello\r\n\r| ", first)
        self.assertIn(b"bye\r\n\r| ", second)
        self.assertNotIn(b"bye\r\n\r\n", second)

    def test_repl_multiline_input(self):
        for mode, command, env in self.commands():
            with self.subTest(mode=mode):
                result = subprocess.run(command, cwd=ROOT, env=env,
                                        input='"include/std.bo" () INCLUDE\n(1\n2 +) apply emit nl\n',
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertIn("3\n", result.stdout)

    def test_core_is_loaded_by_default_and_bare_skips_it(self):
        with tempfile.TemporaryDirectory() as directory:
            core_program = Path(directory) / "core.bo"
            std_program = Path(directory) / "std.bo"
            core_program.write_text("1 2 +\n", encoding="utf-8")
            std_program.write_text('"include/std.bo" require 1 dup +\n', encoding="utf-8")
            for mode, command, env in self.commands():
                with self.subTest(mode=mode, startup="bare"):
                    result = subprocess.run(command + ["--bare", str(core_program)], cwd=ROOT,
                                            env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn("Existence-Error", result.stderr)
                with self.subTest(mode=mode, startup="default"):
                    result = subprocess.run(command + [str(core_program)], cwd=ROOT, env=env,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                with self.subTest(mode=mode, startup="library from another directory"):
                    elsewhere = dict(env or os.environ, PYTHONPATH=str(ROOT))
                    result = subprocess.run(command + [str(std_program)], cwd=directory,
                                            env=elsewhere, capture_output=True, text=True,
                                            timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_unknown_options_are_rejected(self):
        for mode, command, env in self.commands():
            for option in ("--autoload=std", "--unknown"):
                with self.subTest(mode=mode, option=option):
                    result = subprocess.run(command + [option], cwd=ROOT, env=env,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(option, result.stderr)

    def test_exit_uses_the_requested_status(self):
        for mode, command, env in self.commands():
            with self.subTest(mode=mode):
                result = subprocess.run(command, cwd=ROOT, env=env,
                                        input='"include/std.bo" () INCLUDE\n37 exit\n',
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 37, result.stderr)

    def test_exit_rejects_non_portable_statuses(self):
        for code, error in (("1.5 exit\n", "Type-Error"), ("256 exit\n", "Domain-Error")):
            for mode, command, env in self.commands():
                with self.subTest(code=code.strip(), mode=mode):
                    result = subprocess.run(command, cwd=ROOT, env=env,
                                            input='"include/std.bo" () INCLUDE\n' + code,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0)
                    self.assertIn(error, result.stderr)

    @unittest.skipUnless(C_BIN.exists(), "c/bo is not built")
    def test_c_starts_with_primitives_and_loads_default_adapters(self):
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory) / "stack"
            result = subprocess.run(
                [str(C_BIN), "--bare", "--dump", str(dump), "-e", "1 2 +"],
                cwd=directory, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("Existence-Error", result.stderr)
            result = subprocess.run(
                [str(C_BIN), "--bare", "--dump", str(dump), "-e",
                 f'"{ROOT / "include" / "core.bo"}" () INCLUDE 1 2 + (word) POP'],
                cwd=directory, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(dump.read_text(encoding="utf-8").strip(), "3 (() WORD)")
        result = subprocess.run([str(C_BIN), "-e", '"OP" () WORD () TEXT'],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(
            [str(C_BIN), "-e", '"include/std.bo" () INCLUDE 1 2 +'],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([str(C_BIN), "-e", "dup"], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Existence-Error", result.stderr)

    @unittest.skipUnless(C_BIN.exists(), "c/bo is not built")
    def test_c_expression_dump_contains_word_values(self):
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory) / "stack"
            result = subprocess.run(
                [str(C_BIN), "--dump", str(dump), "-e",
                 '"include/std.bo" () INCLUDE (OP) unittype "OP" word "OP" "@" word'],
                cwd=ROOT, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(dump.read_text(encoding="utf-8").strip(), "2 (OP) (79 80) (@)")


if __name__ == "__main__":
    unittest.main()
