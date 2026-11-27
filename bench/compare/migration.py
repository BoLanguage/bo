"""Compare a release from before op values with the current runtime and list pipeline stages."""

import argparse
import os
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
include = '"include/std.bo" require '
range = "1 200000 : "
LEGACY = ("(dup *) map ", "(2 mod 0 =) FILTER ", "0 (+) foldl ")
CURRENT = ("(apply dup * unit) map ", "(apply 2 mod 0 =) FILTER ",
           "0 (apply +) foldl ")


def sources(stages, unit):
    endpoint = "apply " if unit else ""
    check_ends = (f"dup unconsl nip {endpoint}emit 32 emitc "
                  f"unconsr nip {endpoint}emit nl")
    return {
        "range": (include + range + check_ends, "1 200000"),
        "map": (include + range + stages[0] + check_ends, "1 40000000000"),
        "filter": (include + range + "".join(stages[:2]) + check_ends,
                   "4 40000000000"),
        "fold": (include + range + "".join(stages) + "emit nl",
                 "1333353333400000"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-root", required=True, type=Path,
                        help="clean pre-migration checkout with c/bo built")
    parser.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    roots = (args.legacy_root.resolve(), ROOT)
    programs = []
    for root, stages, unit in zip(roots, (LEGACY, CURRENT), (False, True)):
        workloads = {}
        for name, expected in (("loop", "12499997500000"), ("fib", "2178309"),
                               ("collatz", "2864311")):
            path = root / "bench" / "compare" / f"{name}.bo"
            workloads[name] = (path.read_text(encoding="utf-8"), expected)
        workloads.update(sources(stages, unit))
        programs.append(workloads)
    env = os.environ.copy()
    for key in ("BO_NO_OP_OPTIMIZATIONS",):
        env.pop(key, None)
    for name in programs[0]:
        timings = [[], []]
        for repeat in range(args.repeat):
            for index in ((0, 1) if repeat % 2 == 0 else (1, 0)):
                source, expected = programs[index][name]
                start = time.perf_counter()
                result = subprocess.run(
                    [roots[index] / "c/bo", "-e", source], cwd=roots[index], env=env,
                    capture_output=True, text=True, timeout=120,
                )
                elapsed = time.perf_counter() - start
                if result.returncode or result.stderr or result.stdout.strip() != expected:
                    raise RuntimeError(f"{roots[index]} {name}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                timings[index].append(elapsed)
        print(f"{name:8s} legacy={statistics.median(timings[0]):.4f}s "
              f"current={statistics.median(timings[1]):.4f}s "
              f"result={programs[0][name][1]}")


if __name__ == "__main__":
    main()
