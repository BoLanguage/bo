"""Compare generated quotations against the existing runtime."""

import argparse
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from bench.aot.run import build_translated

DEFINITIONS = ("(1 +) (STEP) PUSH (() ADD) (+) PUSH ((2 +) () APPLY 3 +) (NEST) PUSH "
               "(STEP 10 +) (WRAP) PUSH (WRAP 100 +) (DEEP) PUSH")
CASES = {
    "calls": (lambda n: f"0 (dup {n} <) (STEP) loop", 1),
    "nested": (lambda n: f"0 (dup {n * 5} <) (NEST) loop", 5),
    "rebind": (lambda n: f"0 (dup {n * 3} <) "
               "(STEP (() ADD 1 () ADD) (+) PUSH STEP (+) POP drop) loop", 3),
    "direct-chain": (lambda n: f"0 (dup {n * 111} <) (DEEP) loop", 111),
    "dynamic-chain": (lambda n: f"(() ADD) unconsl consl (+) PUSH "
                      f"0 (dup {n * 111} <) (DEEP) loop", 111),
}
MODES = {
    "aot-interpreter": ("aot", True),
    "reference-interpreter": ("reference", True),
    "aot-ops": ("aot", False),
    "reference-ops": ("reference", False),
    "reference-native": ("native", False),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=100_000)
    parser.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 10_000_000 or args.repeat < 1:
        parser.error("--iterations must be between 1 and 10000000 and --repeat must be positive")
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        parser.error("this experiment requires Linux x86-64")

    def run(binary, case, mode, count, stats=False):
        source, factor = CASES[case]
        implementation, no_jit = MODES[mode]
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                    "BO_AOT_STATS", "BO_AOT_BLOCK_STATS", "BO_AOT_COLLECT", "BO_AOT_GC_EACH"):
            env.pop(key, None)
        if no_jit:
            env["BO_NO_JIT"] = "1"
        if stats:
            env["BO_AOT_STATS"] = "1"
        start = time.perf_counter()
        result = subprocess.run([binary, implementation, source(count)], cwd=ROOT, env=env,
                                capture_output=True, text=True, timeout=120)
        elapsed = time.perf_counter() - start
        if result.returncode or result.stdout.strip() != str(count * factor):
            raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                               f"stdout={result.stdout!r}, stderr={result.stderr!r}")
        if stats:
            prefix = "BO_AOT_STATS operations="
            if not result.stderr.startswith(prefix) or int(result.stderr[len(prefix):].split()[0]) <= 0:
                raise RuntimeError(f"{case}/{mode}: generated code did not run: {result.stderr!r}")
            counters = {key: int(value) for key, value in
                        (part.split("=") for part in result.stderr.split()[1:])}
            if case in ("direct-chain", "dynamic-chain") and counters["direct"] < count * 2:
                raise RuntimeError(f"{case}/{mode}: expected nested direct calls: {result.stderr!r}")
            if case == "dynamic-chain" and counters["fallbacks"] < count * 3:
                raise RuntimeError(f"{case}/{mode}: expected dynamic fallback: {result.stderr!r}")
        elif result.stderr:
            raise RuntimeError(f"{case}/{mode}: unexpected stderr: {result.stderr!r}")
        return elapsed

    samples = {(case, mode): [] for case in CASES for mode in MODES}
    with tempfile.TemporaryDirectory() as directory:
        binary = Path(directory) / "translated"
        build_translated(binary, DEFINITIONS)
        for case in CASES:
            for mode in ("aot-interpreter", "aot-ops"):
                run(binary, case, mode, 60, stats=True)
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                samples[case, mode].append(run(binary, case, mode, args.iterations))
    for (case, mode), times in samples.items():
        print(f"{case:8s} {mode:22s} median={statistics.median(times):.4f}s "
              f"result={args.iterations * CASES[case][1]}")


if __name__ == "__main__":
    main()
