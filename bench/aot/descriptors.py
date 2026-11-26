"""Compare direct quotation descriptors with the previous linear scan."""
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

BASE = "(1 +) (STEP) PUSH (() ADD) (+) PUSH (STEP 10 +) (WRAP) PUSH (WRAP 100 +) (DEEP) PUSH"
FLAGS = ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
         "BO_AOT_STATS", "BO_AOT_BLOCK_STATS", "BO_AOT_COLLECT", "BO_AOT_GC_EACH")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=200_000)
    parser.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 10_000_000 or args.repeat < 1:
        parser.error("--iterations must be between 1 and 10000000 and --repeat must be positive")
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        parser.error("this experiment requires Linux x86-64")
    workload = f"0 (dup {args.iterations * 111} <) (DEEP) loop"
    samples = {(size, mode): [] for size in (0, 100, 500)
               for mode in ("descriptor", "linear", "reference")}
    env = os.environ.copy()
    for key in FLAGS:
        env.pop(key, None)
    with tempfile.TemporaryDirectory() as directory:
        binaries = {}
        for size in (0, 100, 500):
            source = " ".join(f"(1) (UNUSED-{i}) PUSH" for i in range(size)) + " " + BASE
            for mode in ("descriptor", "linear"):
                binary = Path(directory) / f"{size}-{mode}"
                build_translated(binary, source, linear=(mode == "linear"))
                binaries[size, mode] = binary
                preflight_env = env.copy()
                preflight_env["BO_AOT_STATS"] = "1"
                result = subprocess.run([binary, "aot", "0 DEEP"], cwd=ROOT, env=preflight_env,
                                        capture_output=True, text=True, timeout=30)
                if result.returncode or result.stdout.strip() != "111" or "direct=5" not in result.stderr.split():
                    raise RuntimeError(f"{size}/{mode} preflight failed: {result.stdout!r} {result.stderr!r}")
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for size, mode in order:
                binary = binaries[size, "descriptor" if mode == "reference" else mode]
                start = time.perf_counter()
                result = subprocess.run([binary, "reference" if mode == "reference" else "aot", workload],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
                elapsed = time.perf_counter() - start
                if result.returncode or result.stderr or result.stdout.strip() != str(args.iterations * 111):
                    raise RuntimeError(f"{size}/{mode}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                samples[size, mode].append(elapsed)
    for (size, mode), times in samples.items():
        print(f"extra={size:3d} {mode:10s} median={statistics.median(times):.4f}s "
              f"result={args.iterations * 111}")


if __name__ == "__main__":
    main()
