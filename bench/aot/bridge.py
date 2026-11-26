"""Compare direct assembly and same-segment fallback in a Bo-driven loop."""
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
from bench.aot.run import build_bridge

CASES = {
    "direct": ("", "BRIDGE-STEP", 11, 1, 0, 0),
    "fallback": ("(() ADD) unconsl consl (+) PUSH ", "BRIDGE-STEP", 11, 3, 2, 0),
    "nested": ("", "BRIDGE-GRAND", 1111, 1, 0, 2),
    "nested-fallback": ("(() ADD) unconsl consl (+) PUSH ", "BRIDGE-GRAND", 1111, 7, 4, 2),
}
MODES = {
    "bridge": ("bridge", None),
    "reference-ops": ("reference", None),
    "reference-interpreter": ("reference", "BO_NO_JIT"),
}
FLAGS = ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
         "BO_AOT_BRIDGE_STATS", "BO_AOT_BRIDGE_COLLECT", "BO_AOT_BRIDGE_GC_EACH")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=500_000)
    parser.add_argument("--repeat", type=int, default=7)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 10_000_000 or args.repeat < 1:
        parser.error("--iterations must be between 1 and 10000000 and --repeat must be positive")
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        parser.error("this experiment requires Linux x86-64")

    def run(binary, case, mode, count, stats=False):
        implementation, flag = MODES[mode]
        setup, word, factor, entries, fallbacks, direct = CASES[case]
        source = f"{setup}0 (dup {count * factor} <) ({word}) loop"
        env = os.environ.copy()
        for key in FLAGS:
            env.pop(key, None)
        if flag:
            env[flag] = "1"
        if stats:
            env["BO_AOT_BRIDGE_STATS"] = "1"
        start = time.perf_counter()
        result = subprocess.run([binary, implementation, source], cwd=ROOT, env=env,
                                capture_output=True, text=True, timeout=120)
        elapsed = time.perf_counter() - start
        expected_stats = (f"BO_AOT_BRIDGE_STATS entries={count * entries} "
                          f"fallbacks={count * fallbacks} direct_calls={count * direct}\n") if stats else ""
        if (result.returncode, result.stdout.strip(), result.stderr) != (0, str(count * factor), expected_stats):
            raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                               f"stdout={result.stdout!r}, stderr={result.stderr!r}")
        return elapsed

    samples = {(case, mode): [] for case in CASES for mode in MODES}
    with tempfile.TemporaryDirectory() as directory:
        binary = Path(directory) / "bridge"
        build_bridge(binary)
        for case in CASES:
            run(binary, case, "bridge", 60, stats=True)
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                samples[case, mode].append(run(binary, case, mode, args.iterations))
    for (case, mode), times in samples.items():
        print(f"{case:8s} {mode:22s} median={statistics.median(times):.4f}s "
              f"result={args.iterations * CASES[case][2]}")


if __name__ == "__main__":
    main()
