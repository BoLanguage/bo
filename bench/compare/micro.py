"""Time current-runtime unit creation and quotation execution in a hot loop."""

import argparse
import os
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = {
    "baseline": "1 +",
    "unit": "0 unit drop 1 +",
    "apply-unit": "0 unit apply drop 1 +",
    "apply-literal": "(0) apply drop 1 +",
    "apply-work": "(0 1 +) apply drop 1 +",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "c/bo")
    parser.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    binary = args.binary.resolve()
    env = os.environ.copy()
    for key in ("BO_NO_OP_OPTIMIZATIONS",):
        env.pop(key, None)
    timings = {name: [] for name in CASES}
    for repeat in range(args.repeat):
        order = list(CASES)
        if repeat % 2:
            order.reverse()
        for name in order:
            source = f"0 (dup 1000000 <) ({CASES[name]}) loop emit nl"
            start = time.perf_counter()
            result = subprocess.run([binary, "-e", source], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=120)
            elapsed = time.perf_counter() - start
            if result.returncode or result.stderr or result.stdout.strip() != "1000000":
                raise RuntimeError(f"{name}: exit={result.returncode}, "
                                   f"stdout={result.stdout!r}, stderr={result.stderr!r}")
            timings[name].append(elapsed)
    for name, samples in timings.items():
        print(f"{name:13s} median={statistics.median(samples):.4f}s result=1000000")


if __name__ == "__main__":
    main()
