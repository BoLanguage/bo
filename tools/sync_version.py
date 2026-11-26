#!/usr/bin/env python3
"""Copy the version in the VERSION file into the npm packages that carry one.

VERSION is the single source of truth (see README, "Version"). The VS Code extension and the
JupyterLab extension each have a package.json and package-lock.json with their own version
field; this keeps them equal to VERSION without reformatting the files.
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = ROOT / "VERSION"
PACKAGES = ("vscode", "jupyterlab")

# The package's own "version" is the first two-space-indented one in package.json. In
# package-lock.json it is that same top-level field plus the one of the root package, "".
TOP_LEVEL = re.compile(r'(\n  "version": ")[^"]*(")')
LOCK_ROOT = re.compile(r'(\n    "": \{[^}]*?\n      "version": ")[^"]*(")')


def version():
    return VERSION_FILE.read_text(encoding="utf-8").split()[0]


def updated(path, number):
    text = path.read_text(encoding="utf-8")
    patterns = (TOP_LEVEL,) if path.name == "package.json" else (TOP_LEVEL, LOCK_ROOT)
    for pattern in patterns:
        text, count = pattern.subn(lambda match: match.group(1) + number + match.group(2), text, 1)
        if count != 1:
            raise ValueError(f"cannot find the version field in {path.relative_to(ROOT)}")
    return text


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="fail if a package version differs from VERSION")
    args = parser.parse_args(argv)
    number = version()
    stale = []
    for package in PACKAGES:
        for name in ("package.json", "package-lock.json"):
            path = ROOT / package / name
            if not path.exists():
                continue
            text = updated(path, number)
            if text != path.read_text(encoding="utf-8"):
                stale.append(path)
                if not args.check:
                    path.write_text(text, encoding="utf-8")
    if args.check and stale:
        names = ", ".join(str(path.relative_to(ROOT)) for path in stale)
        print(f"{names} do not match VERSION {number}; run tools/sync_version.py", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
