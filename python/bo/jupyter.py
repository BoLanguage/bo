"""Jupyter kernel integration for the Python Bo reference implementation."""

import argparse
import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

from .lower import LoweringError
from .machine import Machine
from .render import render
from .values import to_str


ROOT = Path(__file__).resolve().parents[2]
KERNEL_NAME = "bo"


def kernel_spec(show_stack=True, breakpoints=True):
    """Return a checkout-based kernelspec for the current Python interpreter."""
    argv = [sys.executable, str(ROOT / "python" / "jupyter_kernel.py")]
    if not show_stack:
        argv.append("--BoKernel.show_stack=False")
    if not breakpoints:
        argv.append("--BoKernel.breakpoints=False")
    argv.extend(["-f", "{connection_file}"])
    return {
        "argv": argv,
        "display_name": "Bo",
        "language": "bo",
    }


def install_kernel_spec(user=True, prefix=None, show_stack=True, breakpoints=True):
    """Install the Bo kernelspec for this checkout."""
    from jupyter_client.kernelspec import KernelSpecManager

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)
        (path / "kernel.json").write_text(
            json.dumps(kernel_spec(show_stack, breakpoints), indent=2) + "\n", encoding="utf-8"
        )
        return KernelSpecManager().install_kernel_spec(
            str(path), KERNEL_NAME, user=user, prefix=prefix
        )


def _short(value, limit=60):
    text = render(value)
    return text if len(text) <= limit else text[:limit] + "\u2026"


def breakpoint_report(machine):
    """Where a program is at a breakpoint: the user op running, the stack and the next item."""
    frames = list(machine.program_frames())
    at = next((i for i, (program, index, _) in enumerate(frames) if index < len(program)), None)
    name = None
    for _, _, caller in frames[at:] if at is not None else ():
        # the ops that start with __ are the library's own helpers
        if caller is not None and not caller.name.startswith("__"):
            name = caller.name
            break
    if at is not None:
        program, index, _ = frames[at]
        following = _short(program[index])
    elif machine._next_forms and machine._next_forms[1] < len(machine._next_forms[0]):
        forms, index = machine._next_forms
        following = _short(forms[index][1][0])
    else:
        following = "(end)"
    stack = machine.data
    shown = " ".join(_short(item) for item in stack[-10:]) if stack else "(empty)"
    return (f"breakpoint{f' in {name}' if name else ''}\n"
            f"  stack: {'\u2026 ' if len(stack) > 10 else ''}{shown}\n  next: {following}\n")


def _error_content(error):
    if error is None:
        return "Evaluation-Error", "Bo execution failed without a diagnostic", []
    kind, where, data, source, line = error
    ename = kind[0].name
    message = f"{to_str(source)}:{line}: {ename} ({where[0].name}) {render(data)}"
    return ename, message, [message]


try:
    from ipykernel.kernelbase import Kernel
except ImportError:
    Kernel = None


if Kernel is not None:
    from traitlets import Bool


    class BoKernel(Kernel):
        implementation = "bo"
        implementation_version = "0.5"
        language = "bo"
        language_version = "0.5"
        language_info = {
            "name": language,
            "mimetype": "text/x-bo",
            "file_extension": ".bo",
            "codemirror_mode": "bo",
        }
        banner = "BoLang Jupyter kernel"
        show_stack = Bool(
            True,
            config=True,
            help="Display the default stack after each successful cell execution.",
        )
        breakpoints = Bool(
            True,
            config=True,
            help="Show the stack and the next item where a cell reaches @ (the cell then goes on).",
        )

        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.machine = Machine()
            self.machine.add_include_root(ROOT)
            if not self.machine.include_file(ROOT / "include" / "core.bo"):
                raise RuntimeError("cannot load include/core.bo")
            if self.breakpoints:
                self.machine.breakpoint_hook = lambda machine: print(breakpoint_report(machine), end="")

        def do_execute(self, code, silent, store_history=True, user_expressions=None,
                       allow_stdin=False, **kwargs):
            stdout = io.StringIO()
            stderr = io.StringIO()
            source = f"cell-{self.execution_count}"
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = self.machine.execute_result(code, source)
            if not silent:
                for name, stream in (("stdout", stdout), ("stderr", stderr)):
                    text = stream.getvalue()
                    if text:
                        self.send_response(self.iopub_socket, "stream", {"name": name, "text": text})
            if not result.success:
                ename, evalue, traceback = _error_content(result.error)
                if not silent:
                    self.send_response(
                        self.iopub_socket,
                        "error",
                        {"ename": ename, "evalue": evalue, "traceback": traceback},
                    )
                return {
                    "status": "error",
                    "execution_count": self.execution_count,
                    "ename": ename,
                    "evalue": evalue,
                    "traceback": traceback,
                }
            if not silent and self.show_stack:
                self.send_response(
                    self.iopub_socket,
                    "execute_result",
                    {
                        "execution_count": self.execution_count,
                        "data": {"text/plain": render(result.data)},
                        "metadata": {},
                    },
                )
            return {
                "status": "ok",
                "execution_count": self.execution_count,
                "payload": [],
                "user_expressions": {},
            }

        def do_is_complete(self, code):
            try:
                self.machine._lower(code)
            except LoweringError as error:
                if error.incomplete:
                    return {"status": "incomplete", "indent": "  "}
            return {"status": "complete"}

else:
    class BoKernel:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("ipykernel is required; run `make deps` (or install the `jupyter` extra of pyproject.toml)")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--user", action="store_true")
    parser.add_argument("--prefix")
    parser.add_argument("--no-show-stack", action="store_true")
    parser.add_argument("--no-breakpoints", action="store_true")
    options, remaining = parser.parse_known_args(argv)
    if Kernel is None:
        parser.error("ipykernel is required; run `make deps` (or install the `jupyter` extra of pyproject.toml)")
    if options.install:
        if remaining:
            parser.error("--install does not accept kernel connection arguments")
        if options.user and options.prefix:
            parser.error("--user and --prefix are mutually exclusive")
        path = install_kernel_spec(
            user=options.user or options.prefix is None,
            prefix=options.prefix,
            show_stack=not options.no_show_stack,
            breakpoints=not options.no_breakpoints,
        )
        print(f"installed Bo kernelspec in {path}")
        return 0
    if options.user or options.prefix:
        parser.error("--user and --prefix require --install")
    if options.no_show_stack:
        remaining.append("--BoKernel.show_stack=False")
    if options.no_breakpoints:
        remaining.append("--BoKernel.breakpoints=False")
    from ipykernel.kernelapp import IPKernelApp

    IPKernelApp.launch_instance(argv=remaining, kernel_class=BoKernel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
