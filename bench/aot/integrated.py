"""Compare a dynamically dispatched assembled STEP in a Bo-driven loop."""

import argparse
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from run import ROOT, build_integrated

CASES = {
    "calls": lambda n: f"0 (dup {n} <) (STEP) loop",
    "rebind": lambda n: (
        f"0 (dup {n * 3} <) "
        "(STEP (() ADD 1 () ADD) (+) PUSH STEP (+) POP drop) loop"
    ),
}
MODES = {
    "aot-interpreter": ("aot", "BO_NO_JIT"),
    "reference-interpreter": ("reference", "BO_NO_JIT"),
    "aot-ops": ("aot", None),
    "reference-ops": ("reference", None),
    "reference-native": ("native", None),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=100_000)
    parser.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 10_000_000:
        parser.error("--iterations must be between 1 and 10000000")
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        parser.error("this experiment requires Linux x86-64")

    samples = {(case, mode): [] for case in CASES for mode in MODES}
    with tempfile.TemporaryDirectory() as directory:
        binary = Path(directory) / "integrated"
        build_integrated(binary)
        for case in CASES:
            for mode in ("aot-interpreter", "aot-ops"):
                implementation, flag = MODES[mode]
                env = os.environ.copy()
                for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS",
                            "BO_JIT_STATS", "BO_AOT_COLLECT"):
                    env.pop(key, None)
                env["BO_AOT_STATS"] = "1"
                if flag:
                    env[flag] = "1"
                result = subprocess.run([binary, implementation, CASES[case](60)],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
                expected = 180 if case == "rebind" else 60
                entries = 120 if case == "rebind" else 60
                if (result.returncode, result.stdout.strip(), result.stderr.strip()) != (
                        0, str(expected), f"BO_AOT_STATS step_entries={entries} plus_entries=60"):
                    raise RuntimeError(f"{case}/{mode} AOT preflight: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                implementation, flag = MODES[mode]
                env = os.environ.copy()
                for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS",
                            "BO_JIT_STATS", "BO_AOT_STATS", "BO_AOT_COLLECT"):
                    env.pop(key, None)
                if flag:
                    env[flag] = "1"
                start = time.perf_counter()
                result = subprocess.run([binary, implementation, CASES[case](args.iterations)],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
                elapsed = time.perf_counter() - start
                expected = args.iterations * (3 if case == "rebind" else 1)
                if result.returncode or result.stderr or result.stdout.strip() != str(expected):
                    raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                samples[case, mode].append(elapsed)
    for (case, mode), times in samples.items():
        print(f"{case:8s} {mode:22s} median={statistics.median(times):.4f}s "
              f"result={args.iterations * (3 if case == 'rebind' else 1)}")


if __name__ == "__main__":
    main()
