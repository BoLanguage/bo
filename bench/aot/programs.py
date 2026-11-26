"""Compare generated program bodies and nested quotations with ordinary Bo."""
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
from bench.aot.descriptors import FLAGS
from bench.aot.run import build_translated

CASES = {
    "collatz": (
        "(0 swap (dup 1 >) (dup 2 mod 0 = () (2 //) (3 * 1 +) ifte swap 1 + swap) "
        "loop drop) (collatz) PUSH "
        "(0 2 (dup 3001 <) (dup collatz rot + swap 1 +) loop drop) (AOT-PROGRAM) PUSH",
        "215063",
    ),
    "branches": (
        "((1) (11) (22) () IFTE (1) (33) (44) () IFTE) (BRANCHES) PUSH "
        "(0 (dup 100000 <) (BRANCHES drop drop 1 +) loop) (AOT-PROGRAM) PUSH",
        "100000",
    ),
    "rebind": (
        "(1 +) (STEP) PUSH "
        "(0 (dup 300000 <) "
        "(STEP (() ADD 1 () ADD) (+) PUSH STEP (+) POP drop) loop) (AOT-PROGRAM) PUSH",
        "300000",
    ),
    "construct": (
        "((1 +) unconsl consl apply) (RUN-QUOTE) PUSH "
        "(0 (dup 100000 <) (RUN-QUOTE) loop) (AOT-PROGRAM) PUSH",
        "100000",
    ),
}
BLOCKS = {
    "collatz": {"collatz": 0, "inner-condition": 1, "inner-body": 2,
                "even-branch": 4, "odd-branch": 5, "main": 6,
                "outer-condition": 7, "outer-body": 8},
    "branches": {"branches": 0, "first-condition": 1, "first-then": 2,
                 "second-condition": 5, "second-then": 6,
                 "main": 9, "loop-condition": 10, "loop-body": 11},
    "rebind": {"step": 0, "main": 1, "loop-condition": 2, "loop-body": 3},
    "construct": {"run-quote": 0, "original-quote": 1, "main": 2,
                  "loop-condition": 3, "loop-body": 4},
}
REQUIRED = {
    "collatz": ("collatz", "inner-condition", "main", "outer-condition"),
    "branches": ("branches", "first-condition", "first-then", "second-condition",
                 "second-then", "main", "loop-condition"),
    "rebind": ("step", "main", "loop-condition"),
    "construct": ("run-quote", "main", "loop-condition"),
}
MODES = ("aot", "reference", "native")


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
    samples = {(case, mode): [] for case in CASES for mode in MODES}
    with tempfile.TemporaryDirectory() as directory:
        binaries = {}
        for case, (source, expected) in CASES.items():
            binary = Path(directory) / case
            build_translated(binary, source)
            binaries[case] = binary
            preflight = env.copy()
            preflight["BO_AOT_STATS"] = "1"
            preflight["BO_AOT_BLOCK_STATS"] = "1"
            result = subprocess.run([binary, "aot", "AOT-PROGRAM"],
                                    cwd=ROOT, env=preflight, capture_output=True, text=True, timeout=120)
            if result.returncode or result.stdout.strip() != expected or not result.stderr.startswith("BO_AOT_STATS "):
                raise RuntimeError(f"{case} preflight: {result.stdout!r} {result.stderr!r}")
            lines = result.stderr.splitlines()
            counters = {key: int(value) for key, value in
                        (part.split("=") for part in lines[0].split()[1:])}
            entries = {}
            for line in lines[1:]:
                prefix, index, count = line.split()
                if prefix != "BO_AOT_BLOCK":
                    raise RuntimeError(f"{case}: unexpected preflight output: {line!r}")
                entries[int(index.split("=")[1])] = int(count.split("=")[1])
            if counters["operations"] < 1000 or counters["nested"] < 100:
                raise RuntimeError(f"{case}: expected generated nested execution: {result.stderr!r}")
            coverage = {label: entries[index] for label, index in BLOCKS[case].items()}
            if any(not coverage[label] for label in REQUIRED[case]):
                raise RuntimeError(f"{case}: missing required block coverage: {coverage!r}")
            print(f"{case:10s} preflight {lines[0]}")
            print("  blocks " + " ".join(f"{label}={count}" for label, count in coverage.items()))
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                _, expected = CASES[case]
                start = time.perf_counter()
                result = subprocess.run([binaries[case], mode, "AOT-PROGRAM"],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
                elapsed = time.perf_counter() - start
                if result.returncode or result.stderr or result.stdout.strip() != expected:
                    raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                samples[case, mode].append(elapsed)
    for (case, mode), times in samples.items():
        print(f"{case:10s} {mode:10s} median={statistics.median(times):.4f}s result={CASES[case][1]}")


if __name__ == "__main__":
    main()
