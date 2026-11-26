import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

try:
    from python.bo.jupyter import BoKernel, install_kernel_spec, kernel_spec
    from ipykernel.kernelbase import Kernel
except ImportError:
    Kernel = None

from python.bo.machine import Machine
from python.bo.values import Word


@unittest.skipUnless(Kernel is not None, "requires the jupyter extra of pyproject.toml (make deps)")
class JupyterKernelTests(unittest.TestCase):
    def make_kernel(self):
        kernel = BoKernel()
        kernel.execution_count = 1
        messages = []
        kernel.send_response = lambda socket, message_type, content: messages.append((message_type, content))
        return kernel, messages

    def test_kernel_spec_launches_the_current_checkout(self):
        spec = kernel_spec()
        self.assertEqual(
            Path(spec["argv"][1]),
            Path(__file__).resolve().parent.parent / "python" / "jupyter_kernel.py",
        )
        self.assertEqual(spec["language"], "bo")
        self.assertIn("--BoKernel.show_stack=False", kernel_spec(False)["argv"])
        self.assertIn("--BoKernel.breakpoints=False", kernel_spec(breakpoints=False)["argv"])
        self.assertNotIn("--BoKernel.breakpoints=False", spec["argv"])

    def test_kernel_launcher_does_not_depend_on_pythonpath_or_working_directory(self):
        argv = kernel_spec()["argv"][:-2] + ["--help"]
        env = os.environ.copy()
        env.pop("PYTHONPATH", None)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                argv, cwd=directory, env=env, capture_output=True, text=True
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("IPKernelApp", result.stdout)

    def test_kernel_spec_can_be_installed_under_a_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            installed = Path(install_kernel_spec(user=False, prefix=directory))
            self.assertEqual(installed.name, "bo")
            self.assertEqual(json.loads((installed / "kernel.json").read_text()), kernel_spec())

    def test_execute_preserves_machine_state_and_displays_default_stack(self):
        kernel, messages = self.make_kernel()
        with contextlib.redirect_stderr(io.StringIO()):
            first = kernel.do_execute("1 2 +", False)
            second = kernel.do_execute("3 +", False)
        self.assertEqual(first["status"], "ok")
        self.assertEqual(second["status"], "ok")
        self.assertEqual(kernel.machine.data, [6])
        self.assertEqual(messages[-1], (
            "execute_result",
            {"execution_count": 1, "data": {"text/plain": "(6)"}, "metadata": {}},
        ))

    def test_a_breakpoint_shows_where_the_cell_is_and_the_cell_goes_on(self):
        kernel, messages = self.make_kernel()
        kernel.show_stack = False
        with contextlib.redirect_stderr(io.StringIO()):
            kernel.do_execute("(1 +) (succ) PUSH (@ 5 succ 7) (f) PUSH", False)
            result = kernel.do_execute("3 f", False)
            kernel.do_execute("1 @ 2", False)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(messages, [
            ("stream", {"name": "stdout", "text": "breakpoint in f\n  stack: 3\n  next: 5\n"}),
            ("stream", {"name": "stdout", "text": "breakpoint\n  stack: 3 6 7 1\n  next: 2\n"}),
        ])
        self.assertEqual(kernel.machine.data, [3, 6, 7, 1, 2])

    def test_a_conditional_breakpoint_reports_only_when_its_condition_holds(self):
        kernel, messages = self.make_kernel()
        kernel.show_stack = False
        with contextlib.redirect_stderr(io.StringIO()):
            kernel.do_execute('"include/std.bo" require', False)
            kernel.do_execute("7 0 @if 1 @if 8", False)
        self.assertEqual([m[1]["text"] for m in messages if m[0] == "stream"],
                         ["breakpoint\n  stack: 7\n  next: 8\n"])

    def test_breakpoints_can_be_switched_off(self):
        quiet = BoKernel(breakpoints=False)
        quiet.execution_count = 1
        messages = []
        quiet.send_response = lambda socket, kind, content: messages.append((kind, content))
        quiet.show_stack = False
        with contextlib.redirect_stderr(io.StringIO()):
            quiet.do_execute("1 @ 2", False)
        self.assertEqual(messages, [])
        self.assertEqual(quiet.machine.data, [1, 2])

    def test_language_info_identifies_the_bo_editor_mode(self):
        self.assertEqual(BoKernel.language_info["name"], "bo")
        self.assertEqual(BoKernel.language_info["codemirror_mode"], "bo")

    def test_stack_display_can_be_disabled(self):
        kernel, messages = self.make_kernel()
        kernel.show_stack = False
        with contextlib.redirect_stderr(io.StringIO()):
            result = kernel.do_execute("1 2 +", False)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(messages, [])

    def test_execute_publishes_bo_stream_output(self):
        kernel, messages = self.make_kernel()
        with contextlib.redirect_stderr(io.StringIO()):
            result = kernel.do_execute("65 1 write", False)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(messages[0], ("stream", {"name": "stdout", "text": "A"}))

    def test_execute_resolves_checkout_includes_from_any_working_directory(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.chdir(directory):
            kernel, _ = self.make_kernel()
            with contextlib.redirect_stderr(io.StringIO()):
                result = kernel.do_execute('"examples/lib.bo" require', False)
        self.assertEqual(result["status"], "ok")

    def test_execute_reports_bo_errors(self):
        kernel, messages = self.make_kernel()
        with contextlib.redirect_stderr(io.StringIO()):
            result = kernel.do_execute("MISSING", False)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["ename"], "Existence-Error")
        self.assertEqual(messages[-1][0], "error")
        self.assertIn("WORD", messages[-1][1]["evalue"])

    def test_completion_detects_unclosed_lists(self):
        kernel, _ = self.make_kernel()
        self.assertEqual(kernel.do_is_complete("(1"), {"status": "incomplete", "indent": "  "})
        self.assertEqual(kernel.do_is_complete("1 2 +"), {"status": "complete"})


class MachineNotebookTests(unittest.TestCase):
    def test_execution_result_exposes_failed_execution_diagnostic(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            result = machine.execute_result("MISSING", "cell-4")
        self.assertFalse(result.success)
        self.assertEqual(result.data, [])
        self.assertEqual(result.error[1], [Word("WORD")])
        self.assertEqual(result.error[3], [ord(char) for char in "cell-4"])

    def test_stack_snapshot_uses_word_names(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.execute("42 (ANSWER) PUSH"))
        snapshot = machine.stack_snapshot()
        self.assertEqual(snapshot["default"], [])
        self.assertEqual(snapshot["named"], {"ANSWER": [42]})
