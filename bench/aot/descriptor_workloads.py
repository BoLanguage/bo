"""Compare direct descriptors on Collatz and runtime quotation manipulation."""
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
from bench.aot.descriptors import FLAGS

CASES = {
    "collatz": (
        "(0 swap (dup 1 >) (dup 2 mod 0 = () (2 //) (3 * 1 +) ifte swap 1 + swap) "
        "loop drop) (collatz) PUSH",
        "0 2 (dup 3001 <) (dup collatz rot + swap 1 +) loop drop",
        "215063",
    ),
    "construct": (
        "((1 +) unconsl consl apply) (RUN-QUOTE) PUSH",
        "0 (dup 100000 <) (RUN-QUOTE) loop",
        "100000",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        parser.error("this experiment requires Linux x86-64")
    env = os.environ.copy()
    for key in FLAGS:
        env.pop(key, None)
    modes = ("descriptor", "linear", "reference", "native")
    samples = {(case, mode): [] for case in CASES for mode in modes}
    with tempfile.TemporaryDirectory() as directory:
        binaries = {}
        for case, (source, program, expected) in CASES.items():
            for mode in ("descriptor", "linear"):
                binary = Path(directory) / f"{case}-{mode}"
                build_translated(binary, source, linear=(mode == "linear"))
                binaries[case, mode] = binary
                preflight = env.copy()
                preflight["BO_AOT_STATS"] = "1"
                result = subprocess.run([binary, "aot", program], cwd=ROOT, env=preflight,
                                        capture_output=True, text=True, timeout=120)
                if result.returncode or result.stdout.strip() != expected or not result.stderr.startswith("BO_AOT_STATS "):
                    raise RuntimeError(f"{case}/{mode} preflight: {result.stdout!r} {result.stderr!r}")
                stats = {key: int(value) for key, value in
                         (part.split("=") for part in result.stderr.split()[1:])}
                if not stats["operations"] or not stats["fallbacks"]:
                    raise RuntimeError(f"{case}/{mode}: expected generated execution and fallback: {result.stderr!r}")
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                _, program, expected = CASES[case]
                binary = binaries[case, "linear" if mode == "linear" else "descriptor"]
                implementation = "aot" if mode in ("descriptor", "linear") else mode
                start = time.perf_counter()
                result = subprocess.run([binary, implementation, program], cwd=ROOT, env=env,
                                        capture_output=True, text=True, timeout=120)
                elapsed = time.perf_counter() - start
                if result.returncode or result.stderr or result.stdout.strip() != expected:
                    raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                samples[case, mode].append(elapsed)
    for (case, mode), times in samples.items():
        print(f"{case:10s} {mode:10s} median={statistics.median(times):.4f}s result={CASES[case][2]}")


if __name__ == "__main__":
    main()
