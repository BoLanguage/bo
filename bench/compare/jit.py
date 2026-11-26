"""Archived native-JIT comparison; requires the restored experimental runtime."""

import argparse
import os
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLAGS = ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS")
MODES = {
    "interpreter": "BO_NO_JIT",
    "jit": "BO_NO_NATIVE",
    "native": None,
    "no-intrinsics": "BO_NO_INTRINSICS",
}
CASES = {
    "baseline": ("", "1 +"),
    "calls": ("(1 +) (STEP) PUSH (STEP STEP) (TWICE) PUSH", "TWICE 1 -"),
    "quotation": ("", "(1 +) apply"),
    "branches": (
        "((1) (11) (22) () IFTE (1) (33) (44) () IFTE) (BRANCHES) PUSH",
        "BRANCHES drop drop 1 +",
    ),
    "rebind": (
        "(1) (VALUE) PUSH (VALUE 0 +) (CALL-VALUE) PUSH",
        "CALL-VALUE (2) (VALUE) PUSH CALL-VALUE (VALUE) POP drop 10 * + 20 - +",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "c/bo")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--iterations", type=int, default=100_000)
    parser.add_argument("--mode", action="append", choices=MODES)
    parser.add_argument("--case", action="append", choices=CASES)
    parser.add_argument("--stats", action="store_true",
                        help="report opt-in native exit counters (timings are instrumented)")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    if args.iterations < 1:
        parser.error("--iterations must be positive")
    if not (ROOT / "c/native.c").is_file():
        parser.error("archived benchmark requires the restored native-JIT runtime; snapshot EXECUTION_EXPERIMENTS.md")

    binary = args.binary.resolve()
    modes = args.mode or list(MODES)
    cases = args.case or list(CASES)
    timings = {(case, mode): [] for case in cases for mode in modes}
    reports = {}
    for repeat in range(args.repeat):
        order = list(timings)
        if repeat % 2:
            order.reverse()
        for case, mode in order:
            setup, body = CASES[case]
            source = (f'"include/std.bo" () INCLUDE {setup} '
                      f'0 (dup {args.iterations} <) ({body}) loop emit nl')
            env = os.environ.copy()
            for flag in FLAGS:
                env.pop(flag, None)
            env.pop("BO_JIT_STATS", None)
            if args.stats:
                env["BO_JIT_STATS"] = "1"
            if MODES[mode]:
                env[MODES[mode]] = "1"
            start = time.perf_counter()
            result = subprocess.run([binary, "-e", source], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=120)
            elapsed = time.perf_counter() - start
            lines = result.stderr.splitlines()
            valid_stats = (not lines if not args.stats else
                           len(lines) >= 3 and all(line.startswith("BO_JIT_STATS ") for line in lines))
            if result.returncode or not valid_stats or result.stdout.strip() != str(args.iterations):
                raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                                   f"stdout={result.stdout!r}, stderr={result.stderr!r}")
            timings[case, mode].append(elapsed)
            if args.stats:
                reports[case, mode] = lines
    for (case, mode), samples in timings.items():
        print(f"{case:10s} {mode:13s} median={statistics.median(samples):.4f}s "
              f"result={args.iterations}")
        if args.stats:
            print("\n".join(f"  {line}" for line in reports[case, mode]))


if __name__ == "__main__":
    main()
