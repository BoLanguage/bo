"""Command line and REPL."""

import os
import sys

from .lower import LoweringError
from .machine import Machine


def _make_reader(machine):
    return input


def _version():
    try:
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "VERSION")
        with open(path) as f:
            number, date = f.read().split()[:2]
        return number, date
    except (OSError, ValueError):
        return "unknown", "unknown"


def repl(machine):
    number, date = _version()
    print(f"BoLang | Version {number} ({date}) | python reference")
    read = _make_reader(machine)
    line_no = 1
    while True:
        buffer, prompt = "", "| "
        while True:
            try:
                buffer += read(prompt) + "\n"
            except EOFError:
                return
            except KeyboardInterrupt:
                buffer = ""
                break
            try:
                machine._lower(buffer)
            except LoweringError as error:
                if error.incomplete:
                    prompt = "  "
                    continue
            break
        if not buffer.strip():
            continue
        try:
            machine.execute(buffer, "stdin", line_no)
        except SystemExit as signal:
            return signal.code
        line_no += buffer.count("\n")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--version"]:
        print("BoLang %s (%s)" % _version())
        return 0
    paths = []
    bare = False
    no_private = False
    for argument in argv:
        if argument == "--no-private":
            no_private = True
        elif argument == "--bare":
            bare = True
        elif argument.startswith("--") and len(argument) > 2:
            print("Unknown option %r (expected --bare, --no-private or --version)" % argument,
                  file=sys.stderr)
            return 2
        else:
            paths.append(argument)
    machine = Machine()
    if no_private:
        machine.private_words = False
    if not bare and not machine.include_file(machine.home / "include" / "core.bo"):
        return 1
    if not paths:
        return repl(machine) or 0
    ok = True
    for path in paths:
        try:
            ok = machine.include_file(path) and ok
        except SystemExit as signal:
            return signal.code
    return 0 if ok else 1
