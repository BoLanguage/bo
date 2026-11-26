"""Compare generated reusable fragments, linked operations, and compiled operations."""

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
from bench.aot.linked import CASES as LINKED_CASES, FLAGS, checked
from bench.aot.run import build_linked

CASES = dict(LINKED_CASES)
for name in ("preexisting", "constructed-once"):
    source, expected, trace = CASES[name]
    CASES[name] = (source.replace("(Q) loop", "(Q 0 +) loop"), expected, trace)
source, expected, trace = CASES["constructed-fresh"]
CASES["constructed-fresh"] = (source.replace("() APPLY) loop", "() APPLY 0 +) loop"),
                              expected, trace)
MODES = ("fragments", "linked", "reference")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=5)
    parser.add_argument("--memory", action="store_true", help="measure peak RSS with GNU time")
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
        binaries = {}
        for case, (source, expected, trace) in CASES.items():
            binary = Path(directory) / case
            build_linked(binary, [source])
            binaries[case] = binary
            preflight = env.copy()
            preflight.update(BO_LINKED_STATS="1", BO_LINKED_TRACE=trace)
            result = checked([binary, "fragments", source], preflight, expected, case,
                             "preflight", preflight=True)
            lines = result.stderr.splitlines()
            if len(lines) != 2 or not lines[0].startswith("BO_LINKED_STATS ") or \
                    not lines[1].startswith("BO_FRAGMENT_STATS "):
                raise RuntimeError(f"{case}: unexpected preflight output: {result.stderr!r}")
            counts = {key: int(value) for key, value in (part.split("=") for part in lines[1].split()[1:])}
            if not counts["trace"] or not counts["operations"] or not counts["yields"]:
                raise RuntimeError(f"{case}: no copied body fragment execution: {result.stderr!r}")
            print(f"{case:18s} {lines[0]}\n{'':18s} {lines[1]}", flush=True)
            for mode in ("linked", "reference"):
                comparison = checked([binary, mode, source], preflight, expected, case,
                                     f"{mode}-preflight", preflight=True)
                comparison_lines = comparison.stderr.splitlines()
                if len(comparison_lines) != 2 or not comparison_lines[0].startswith("BO_LINKED_STATS "):
                    raise RuntimeError(f"{case}/{mode}: unexpected preflight: {comparison.stderr!r}")
                stats = {key: int(value) for key, value in
                         (part.split("=") for part in comparison_lines[0].split()[1:])}
                print(f"{'':18s} {mode}-scheduler={stats['scheduler']}", flush=True)
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                source, expected, _ = CASES[case]
                start = time.perf_counter()
                checked([binaries[case], mode, source], env, expected, case, mode)
                samples[case, mode].append(time.perf_counter() - start)
        if args.memory:
            for case, mode in samples:
                source, expected, _ = CASES[case]
                rss_file = Path(directory) / "rss"
                checked([time_tool, "-f", "%M", "-o", rss_file, binaries[case], mode, source],
                        env, expected, case, mode)
                memory[case, mode] = int(rss_file.read_text().strip())
    for (case, mode), times in samples.items():
        rss = f" peak_rss={memory[case, mode]}KiB" if args.memory else ""
        print(f"{case:18s} {mode:10s} median={statistics.median(times):.4f}s{rss}")


if __name__ == "__main__":
    main()
