"""Time and check the C workloads: python3 bench/compare/run.py."""

import argparse
import os
import statistics
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
EXPECTED = {
    "loop": "12499997500000",
    "fib": "2178309",
    "collatz": "2864311",
    "collatz-rec": "2864311",
    "pipeline": "1333353333400000",
    "calls": "5000000",
    "rebind": "3000000",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", action="append", type=Path,
                        help="C executable to benchmark; repeat to compare builds")
    parser.add_argument("--repeat", type=int, default=3, help="runs per workload (default: 3)")
    parser.add_argument("--workload", action="append", choices=EXPECTED,
                        help="workload to run; repeat to select multiple (default: all)")
    parser.add_argument("--compare-generic", action="store_true",
                        help="compare optimized operations with BO_NO_OP_OPTIMIZATIONS")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    binaries = [path.resolve() for path in (args.binary or [ROOT / "c/bo"])]

    configs = [(binary, mode) for binary in binaries
               for mode in (("specialized", "generic") if args.compare_generic else (None,))]
    for name in args.workload or EXPECTED:
        expected = EXPECTED[name]
        timings = [[] for _ in configs]
        for repeat in range(args.repeat):
            order = range(len(configs)) if repeat % 2 == 0 else reversed(range(len(configs)))
            for index in order:
                binary, mode = configs[index]
                env = os.environ.copy()
                if mode:
                    env.pop("BO_NO_OP_OPTIMIZATIONS", None)
                    if mode == "generic":
                        env["BO_NO_OP_OPTIMIZATIONS"] = "1"
                start = time.perf_counter()
                result = subprocess.run([binary, HERE / f"{name}.bo"], cwd=ROOT, env=env,
                                        capture_output=True, text=True, timeout=120)
                elapsed = time.perf_counter() - start
                if result.returncode or result.stderr or result.stdout.strip() != expected:
                    raise RuntimeError(f"{binary} {name} {mode or ''}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                timings[index].append(elapsed)
        for (binary, mode), samples in zip(configs, timings):
            print(f"{name:8s} {binary} {mode or ''} median={statistics.median(samples):.4f}s "
                  f"min={min(samples):.4f}s max={max(samples):.4f}s result={expected}")


if __name__ == "__main__":
    main()
