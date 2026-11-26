#!/usr/bin/env python3
"""Prepare a release: bump VERSION and CHANGELOG.md, regenerate, check, test, commit and tag.

    make release VERSION=0.8.6 [SUMMARY="short title"] [DATE=YYYY-MM-DD]
                 [SKIP_TESTS=1] [ALLOW_DIRTY=1]

The steps, which stop at the first failure:

1. the version is a new X.Y.Z above the current one, its tag does not exist, and the worktree is
   clean (ALLOW_DIRTY=1 lets the release commit also carry the uncommitted changes);
2. the "## Unreleased" heading of CHANGELOG.md becomes "## X.Y.Z (DATE)" and VERSION is updated;
3. `make generate` copies the version into the npm packages, then `make check` and, unless
   SKIP_TESTS=1, `make test` run (suites without their build skip themselves);
4. one commit "Release X.Y.Z[: SUMMARY]" and the lightweight tag vX.Y.Z.

If a step fails, VERSION and CHANGELOG.md are put back and the files are regenerated, so nothing
is left half-released. Nothing is pushed: the last line printed is the command to do it.
"""

import argparse
import datetime
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = ROOT / "VERSION"
CHANGELOG = ROOT / "CHANGELOG.md"
NUMBER = re.compile(r"\d+\.\d+\.\d+")
UNRELEASED = re.compile(r"^## Unreleased[ \t]*$", re.MULTILINE)


class Stop(Exception):
    pass


def git(*args, check=True):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    if check and result.returncode:
        raise Stop(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def make(*targets):
    # A VERSION=x.y.z given to this make must not reach the sub-makes, where it would override
    # the version they read from the VERSION file.
    env = {k: v for k, v in os.environ.items() if k not in ("MAKEFLAGS", "MFLAGS", "MAKELEVEL")}
    print(f"\n$ make {' '.join(targets)}", flush=True)
    if subprocess.run(["make", *targets], cwd=ROOT, env=env).returncode:
        raise Stop(f"make {' '.join(targets)} failed")


def as_tuple(number):
    return tuple(int(part) for part in number.split("."))


def check_preconditions(number, allow_dirty):
    if not NUMBER.fullmatch(number):
        raise Stop(f"{number!r} is not a version number like 0.8.6")
    current = VERSION_FILE.read_text(encoding="utf-8").split()[0]
    if as_tuple(number) <= as_tuple(current):
        raise Stop(f"{number} is not above the current version {current}")
    if git("tag", "--list", f"v{number}"):
        raise Stop(f"the tag v{number} already exists")
    if git("symbolic-ref", "--short", "-q", "HEAD", check=False) == "":
        raise Stop("HEAD is detached: check out a branch first")
    if git("status", "--porcelain") and not allow_dirty:
        raise Stop("the worktree is not clean; commit first, or use ALLOW_DIRTY=1 to include "
                   "the changes in the release commit")


def changelog_with_release(number, date):
    text = CHANGELOG.read_text(encoding="utf-8")
    match = UNRELEASED.search(text)
    if match is None:
        raise Stop('CHANGELOG.md has no "## Unreleased" section: describe the changes first')
    following = re.search(r"^## ", text[match.end():], re.MULTILINE)
    body = text[match.end():match.end() + following.start()] if following else text[match.end():]
    if not body.strip():
        raise Stop('the "## Unreleased" section of CHANGELOG.md is empty')
    return text[:match.start()] + f"## {number} ({date})" + text[match.end():]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("version", help="the new version, X.Y.Z")
    parser.add_argument("--date", default=datetime.date.today().isoformat())
    parser.add_argument("--summary", default="", help="short title added to the commit subject")
    parser.add_argument("--skip-tests", action="store_true", help="run `make check` only")
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        parser.error("the date must be YYYY-MM-DD")

    number = args.version
    saved = {path: path.read_text(encoding="utf-8") for path in (VERSION_FILE, CHANGELOG)}
    started = False
    try:
        check_preconditions(number, args.allow_dirty)
        started = True
        CHANGELOG.write_text(changelog_with_release(number, args.date), encoding="utf-8")
        VERSION_FILE.write_text(f"{number} {args.date}\n", encoding="utf-8")
        make("generate")
        make("check")
        if not args.skip_tests:
            make("test")
        subject = f"Release {number}" + (f": {args.summary}" if args.summary else "")
        git("add", "-A")
        git("commit", "-q", "-m", subject)
        git("tag", f"v{number}")
    except Stop as stop:
        if started:
            for path, text in saved.items():
                path.write_text(text, encoding="utf-8")
            try:
                make("generate")
            except Stop:
                pass
        print(f"\nrelease stopped: {stop}", file=sys.stderr)
        if started:
            print("VERSION and CHANGELOG.md are back as they were.", file=sys.stderr)
        return 1
    print(f"\nReleased {number}: commit {git('rev-parse', '--short', 'HEAD')} and tag v{number}."
          f"\nTo publish: git push origin HEAD v{number}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
