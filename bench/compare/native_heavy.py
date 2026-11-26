"""Archived native-completion experiment; requires the restored experimental runtime."""

import argparse
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from bench.compare.tiers import MODES, environment, run_checked

SOURCES = ("machine.c", "heap.c", "units.c", "words.c", "lower.c", "native.c", "lineedit.c")


def build(binary):
    command = ["cc", "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11", "-I", ROOT / "c",
               ROOT / "bench/compare/native_heavy.c",
               *(ROOT / "c" / source for source in SOURCES), "-lm", "-o", binary]
    subprocess.run(command, cwd=ROOT, check=True)


def counts(stderr):
    result = {}
    for line in stderr.splitlines()[:4]:
        for field in line.split()[1:]:
            if "=" not in field:
                continue
            key, value = field.split("=")
            result[key] = int(value)
    return result


def timed_run(binary, case, n, mode):
    start = time.perf_counter()
    result = subprocess.run([binary, case, str(n), "--time"], cwd=ROOT, env=environment(mode),
                            capture_output=True, text=True, timeout=180)
    elapsed = time.perf_counter() - start
    lines = result.stdout.splitlines()
    if result.returncode or result.stderr or len(lines) != 2 or lines[0] != "100":
        raise RuntimeError(f"{case}/{n}/{mode}: exit={result.returncode} "
                           f"stdout={result.stdout!r} stderr={result.stderr!r}")
    try:
        execution = float(lines[1])
    except ValueError as error:
        raise RuntimeError(f"{case}/{n}/{mode}: invalid execution time {lines[1]!r}") from error
    if not 0 <= execution <= elapsed:
        raise RuntimeError(f"{case}/{n}/{mode}: invalid execution time {execution}")
    return elapsed, execution


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "c/bo")
    parser.add_argument("--repeat", type=int, default=7)
    parser.add_argument("--long-count", type=int, default=100_000)
    args = parser.parse_args()
    if args.repeat < 1 or args.long_count < 100:
        parser.error("--repeat must be positive and --long-count must be at least 100")
    if not (ROOT / "c/native.c").is_file():
        parser.error("archived benchmark requires the restored native-JIT runtime; snapshot EXECUTION_EXPERIMENTS.md")
    iterations = sorted({1, 49, 50, 51, 100, 200, 500, 1000, 2000, 5000, 10_000,
                         args.long_count})
    samples = {(case, n, mode): [] for case in ("branches", "arithmetic")
               for n in iterations for mode in MODES}
    bo_count = min(args.long_count, 10_000)
    bo_source = ('"include/std.bo" () INCLUDE ('
                 + "(1) (1) (0) () IFTE " * 100
                 + ") (BRANCHES) PUSH 0 (dup " + str(bo_count) + " <) (BRANCHES "
                 + "drop " * 100 + "1 +) loop emit nl")
    bo_command = [args.binary.resolve(), "-e", bo_source]
    bo_samples = {mode: [] for mode in MODES}
    with tempfile.TemporaryDirectory() as directory:
        binary = Path(directory) / "native-heavy"
        build(binary)
        for case, n in (("branches", 49), ("branches", 50),
                        ("branches", args.long_count), ("arithmetic", args.long_count)):
            result = run_checked([binary, case, str(n)], environment("native", stats=True),
                                 "100\n", f"{case}/{n}/diagnostics", stats=True)
            print(f"{case}/{n} diagnostics\n{result.stderr.rstrip()}", flush=True)
            if (case == "branches" and n == args.long_count and sys.platform == "linux"
                    and platform.machine() == "x86_64"):
                stats = counts(result.stderr)
                if stats["compiled"] < 1 or stats["completed"] < n - 49 or stats["call_exit"]:
                    raise RuntimeError("branch workload did not complete as expected in native code")
        result = run_checked(bo_command, environment("native", stats=True), f"{bo_count}\n",
                             "bo-branches/diagnostics", stats=True)
        print(f"bo-branches/{bo_count} diagnostics\n{result.stderr.rstrip()}", flush=True)
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, n, mode in order:
                samples[case, n, mode].append(timed_run(binary, case, n, mode))
            modes = list(MODES)
            if repeat % 2:
                modes.reverse()
            for mode in modes:
                start = time.perf_counter()
                run_checked(bo_command, environment(mode), f"{bo_count}\n", f"bo-branches/{mode}")
                bo_samples[mode].append(time.perf_counter() - start)
    for (case, n, mode), times in samples.items():
        whole, execution = zip(*times)
        print(f"{case:10s} {n:7d} {mode:12s} "
              f"whole_median={statistics.median(whole):.6f}s "
              f"execution_median={statistics.median(execution):.6f}s "
              f"execution_min={min(execution):.6f}s execution_max={max(execution):.6f}s")
    for mode, times in bo_samples.items():
        print(f"bo-branches {bo_count:7d} {mode:12s} whole_median={statistics.median(times):.6f}s "
              f"whole_min={min(times):.6f}s whole_max={max(times):.6f}s")


if __name__ == "__main__":
    main()
