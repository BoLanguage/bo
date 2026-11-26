"""Compare shared, linkable operation templates with ordinary Bo execution."""

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
from bench.aot.run import build_linked

FLAGS = ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
         "BO_LINKED_STATS", "BO_LINKED_GC_EACH", "BO_LINKED_TRACE")
CASES = {
    "preexisting": ("(1 +) (Q) PUSH 0 (dup 100000 <) (Q) loop", "100000", "Q"),
    "constructed-once": ("(1 +) unconsl consl (Q) PUSH 0 (dup 100000 <) (Q) loop",
                         "100000", "Q"),
    "constructed-fresh": ("0 (dup 100000 <) ((1 +) unconsl consl () APPLY) loop",
                          "100000", "APPLY"),
    "collatz": ("(0 swap (dup 1 >) (dup 2 mod 0 = () (2 //) (3 * 1 +) ifte "
                "swap 1 + swap) loop drop) (collatz) PUSH "
                "0 2 (dup 3001 <) (dup collatz rot + swap 1 +) loop drop", "215063", "mod"),
    "branches": ("((1) (11) (22) () IFTE (1) (33) (44) () IFTE) (BRANCHES) PUSH "
                 "0 (dup 100000 <) (BRANCHES drop drop 1 +) loop", "100000", "BRANCHES"),
    "rebind": ("(1 +) (STEP) PUSH 0 (dup 300000 <) "
               "(STEP (() ADD 1 () ADD) (+) PUSH STEP (+) POP drop) loop", "300000", "STEP"),
}
MODES = ("linked", "reference", "native")


def checked(command, env, expected, case, mode, *, preflight=False):
    result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    if result.returncode or result.stdout.strip() != expected or (result.stderr and not preflight):
        raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                           f"stdout={result.stdout!r}, stderr={result.stderr!r}")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=5)
    parser.add_argument("--memory", action="store_true", help="measure whole-process peak RSS with GNU time")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    time_tool = Path("/usr/bin/time")
    if args.memory and not time_tool.is_file():
        parser.error("--memory requires /usr/bin/time")
    env = os.environ.copy()
    for key in FLAGS:
        env.pop(key, None)
    samples = {(case, mode): [] for case in CASES for mode in MODES}
    memory = {}
    with tempfile.TemporaryDirectory() as directory:
        binary = Path(directory) / "linked"
        build_linked(binary)
        for case, (source, expected, trace) in CASES.items():
            preflight = env.copy()
            preflight.update(BO_LINKED_STATS="1", BO_LINKED_TRACE=trace)
            result = checked([binary, "linked", source], preflight, expected, case, "preflight",
                             preflight=True)
            lines = result.stderr.splitlines()
            if len(lines) != 1 or not lines[0].startswith("BO_LINKED_STATS "):
                raise RuntimeError(f"{case}: unexpected preflight output: {result.stderr!r}")
            counts = {key: int(value) for key, value in (part.split("=") for part in lines[0].split()[1:])}
            if not counts["copies"] or not counts["trace"] or not counts["reused_entries"]:
                raise RuntimeError(f"{case}: no transferred body execution: {result.stderr!r}")
            print(f"{case:18s} {lines[0]}", flush=True)
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                source, expected, _ = CASES[case]
                start = time.perf_counter()
                checked([binary, mode, source], env, expected, case, mode)
                samples[case, mode].append(time.perf_counter() - start)
        if args.memory:
            for case, mode in samples:
                source, expected, _ = CASES[case]
                rss_file = Path(directory) / "rss"
                checked([time_tool, "-f", "%M", "-o", rss_file, binary, mode, source],
                        env, expected, case, mode)
                memory[case, mode] = int(rss_file.read_text().strip())
    for (case, mode), times in samples.items():
        rss = f" peak_rss={memory[case, mode]}KiB" if args.memory else ""
        print(f"{case:18s} {mode:10s} median={statistics.median(times):.4f}s{rss}")


if __name__ == "__main__":
    main()
