"""Measure sequential and PARALLEL rank-one array workloads in the C runtime.

Run from the repository root after `make -C c`:
    python3 -m bench.array_parallel

The measurements are whole-process timings. They include standard-library
loading, input array construction, worker startup, and result aggregation;
each parallel configuration is first checked for exact equality with its
sequential workload.
"""

import argparse
import os
import platform
import statistics
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BINARY = ROOT / "c" / "bo"
WORKLOADS = (
    "broadcast", "sum", "sum-pipeline", "dot", "dot-pipeline",
    "prod", "min", "max", "any-early", "any-late", "all-early", "all-late",
)


def source(size, chunks=None, verify=False, workload="broadcast", depth=None):
    array = f"1 {size} : ({size}) array"
    if workload == "broadcast":
        sequential = f"{array} 2 (*) ."
        parallel = f"{array} {chunks} chunk (2 (*) .) parallel concat"
    elif workload == "sum":
        sequential = f"{array} () (+) .."
        parallel = (
            f"{array} {chunks} chunk (() (+) ..) parallel "
            "(apply apply unit) map 0 (apply +) foldl"
        )
    elif workload == "sum-pipeline":
        if depth is None or depth < 1:
            raise ValueError("sum-pipeline requires a positive depth")
        pipeline = " ".join(("1 (+) .",) * depth)
        sequential = f"{array} {pipeline} () (+) .."
        parallel = (
            f"{array} {chunks} chunk ({pipeline} () (+) ..) parallel "
            "(apply apply unit) map 0 (apply +) foldl"
        )
    elif workload == "dot":
        unit_tensor = f"{array} 0 (*) . 1 (+) ."
        sequential = f"{unit_tensor} {unit_tensor} dot"
        parallel = (
            f"{unit_tensor} {unit_tensor} {chunks} chunk swap {chunks} chunk "
            "swap zip (unconsl apply swap unconsl apply swap drop dot) parallel "
            "(apply apply unit) map 0 (apply +) foldl"
        )
    elif workload == "dot-pipeline":
        if depth is None or depth < 1:
            raise ValueError("dot-pipeline requires a positive depth")
        pipeline = " ".join(("1 (+) .",) * depth)
        unit_tensor = f"{array} 0 (*) . 1 (+) ."
        sequential = f"{unit_tensor} {unit_tensor} {pipeline} dot"
        parallel = (
            f"{unit_tensor} {unit_tensor} {chunks} chunk swap {chunks} chunk "
            f"swap zip (unconsl apply swap unconsl apply swap drop {pipeline} dot) "
            "parallel (apply apply unit) map 0 (apply +) foldl"
        )
    elif workload == "prod":
        unit_tensor = f"{array} 0 (*) . 1 (+) ."
        sequential = f"{unit_tensor} () (*) .."
        parallel = (
            f"{unit_tensor} {chunks} chunk (() (*) ..) parallel "
            "(apply apply unit) map 1 (apply *) foldl"
        )
    elif workload in ("min", "max"):
        reduction = f"({workload}) .."
        sequential = f"{array} () {reduction}"
        parallel = (
            f"{array} {chunks} chunk (() {reduction}) parallel "
            f"(apply apply unit) map unconsl apply (apply {workload}) foldl"
        )
    elif workload.startswith(("any-", "all-")):
        zero_tensor = f"{array} 0 (*) ."
        unit_tensor = f"{zero_tensor} 1 (+) ."
        reduction, position = workload.split("-")
        index = 0 if position == "early" else size - 1
        if reduction == "any":
            input_tensor = f"{zero_tensor} ({index}) 1 <-"
            identity, combine = 0, "max"
        else:
            input_tensor = f"{unit_tensor} ({index}) 0 <-"
            identity, combine = 1, "min"
        sequential = f"{input_tensor} () {reduction}"
        parallel = (
            f"{input_tensor} {chunks} chunk (() {reduction}) parallel "
            f"(apply apply unit) map {identity} (apply {combine}) foldl"
        )
    else:
        raise ValueError(f"unknown workload: {workload}")

    if chunks is None:
        body = f"{sequential} drop"
    elif verify:
        body = f"{sequential} {parallel} = emit"
    else:
        body = f"{parallel} drop"
    return '"include/std.bo" () INCLUDE ' + body


def run(binary, program):
    started = time.perf_counter()
    result = subprocess.run(
        [str(binary), "-e", program],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    elapsed = time.perf_counter() - started
    if result.returncode or result.stderr:
        raise RuntimeError(
            f"benchmark run failed ({result.returncode}): {result.stderr.strip()}"
        )
    return elapsed, result.stdout


def validate(binary, size, chunks, workload, depth):
    _, output = run(
        binary, source(size, chunks, verify=True, workload=workload, depth=depth)
    )
    if output != "1":
        raise RuntimeError(
            f"parallel {workload} result differed from sequential result "
            f"for size={size}, chunks={chunks}: {output!r}"
        )


def samples(binary, sequential, size, chunks, count, workload, depth):
    programs = (
        source(size, workload=workload, depth=depth),
        source(size, chunks, workload=workload, depth=depth),
    )
    values = [[], []]
    for _ in range(count):
        for index in (sequential, 1 - sequential):
            elapsed, output = run(binary, programs[index])
            if output:
                raise RuntimeError(f"timed benchmark unexpectedly wrote output: {output!r}")
            values[index].append(elapsed)
    return values


def describe(values):
    return (
        f"{statistics.median(values) * 1_000:8.1f} ms "
        f"({min(values) * 1_000:.1f}-{max(values) * 1_000:.1f})"
    )


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--sizes", type=int, nargs="+", default=[100_000, 1_000_000])
    parser.add_argument("--chunks", type=int, nargs="+", default=[1, 2, 4])
    parser.add_argument("--workloads", choices=WORKLOADS, nargs="+", default=WORKLOADS)
    parser.add_argument(
        "--depths", type=int, nargs="+", default=[1, 4, 16],
        help="elementwise additions per chunk for the sum-pipeline workload",
    )
    parser.add_argument("--runs", type=int, default=7)
    args = parser.parse_args(argv)

    if not args.binary.is_file():
        parser.error(f"C runtime is not built: {args.binary}; run `make -C c` first")
    if (args.runs < 1 or any(size < 1 for size in args.sizes)
            or any(chunk < 1 for chunk in args.chunks)
            or any(depth < 1 for depth in args.depths)):
        parser.error("--runs, --sizes, --chunks, and --depths must be positive")
    if any(workload in ("min", "max") and chunk > size
           for workload in args.workloads for chunk in args.chunks for size in args.sizes):
        parser.error("--chunks cannot exceed --sizes for min or max")

    print(f"runtime: {args.binary}")
    print(f"host: {platform.platform()} | CPUs visible: {os.cpu_count() or 'unknown'}")
    print("whole-process timings; median (min-max), alternating sequential and parallel runs")
    for workload in args.workloads:
        depths = args.depths if workload.endswith("-pipeline") else [None]
        for depth in depths:
            label = workload if depth is None else f"{workload} depth {depth}"
            for size in args.sizes:
                print(f"\nrank-one array {label} length {size}:")
                for chunks in args.chunks:
                    validate(args.binary, size, chunks, workload, depth)
                    samples(args.binary, 0, size, chunks, 1, workload, depth)
                    sequential, parallel = samples(
                        args.binary, 0, size, chunks, args.runs, workload, depth
                    )
                    speedup = statistics.median(sequential) / statistics.median(parallel)
                    print(
                        f"  chunks={chunks:<4d} sequential {describe(sequential)} | "
                        f"parallel {describe(parallel)} | speedup {speedup:.2f}x"
                    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
