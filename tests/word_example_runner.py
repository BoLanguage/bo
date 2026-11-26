"""Internal runner for examples with explicit library includes."""

import sys

from python.bo.machine import Machine


def main():
    machine = Machine()
    core = machine.home / "include" / "core.bo"
    return 0 if machine.include_file(core) and machine.include_file(sys.argv[1]) else 1


if __name__ == "__main__":
    sys.exit(main())
