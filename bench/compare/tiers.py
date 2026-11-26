"""Archived native-JIT tier comparison; requires the restored experimental runtime."""

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
from bench.compare.jit import CASES, FLAGS

MODES = {"interpreter": "BO_NO_JIT", "compiled-ops": "BO_NO_NATIVE", "native": None}
PRELUDE = '"include/std.bo" () INCLUDE '


def workloads(iterations, collatz_limit, pipeline_size):
    cases = {"startup-bare": ("1 2 () ADD", ""),
             "startup-std": (PRELUDE + "1 2 + emit nl", "3\n")}
    for name in ("calls", "quotation", "branches", "rebind"):
        setup, body = CASES[name]
        for duration, count in (("short", 20), ("long", iterations)):
            source = (f"{PRELUDE}{setup} 0 (dup {count} <) ({body}) "
                      "loop emit nl")
            cases[f"{name}-{duration}"] = (source, f"{count}\n")
    collatz = (ROOT / "bench/compare/collatz.bo").read_text(encoding="utf-8")
    collatz = collatz.replace('"../../include/std.bo"', '"include/std.bo"')
    collatz = collatz.replace("30001", str(collatz_limit + 1))
    total = 0
    for value in range(2, collatz_limit + 1):
        while value > 1:
            value = value // 2 if value % 2 == 0 else 3 * value + 1
            total += 1
    cases["collatz"] = (collatz, f"{total}\n")
    pipeline = (ROOT / "bench/compare/pipeline.bo").read_text(encoding="utf-8")
    pipeline = pipeline.replace('"../../include/std.bo"', '"include/std.bo"')
    pipeline = pipeline.replace("200001", str(pipeline_size + 1))
    n = pipeline_size // 2
    expected = 4 * n * (n + 1) * (2 * n + 1) // 6
    cases["pipeline"] = (pipeline, f"{expected}\n")
    return cases


def environment(mode, *, stats=False):
    env = os.environ.copy()
    for key in (*FLAGS, "BO_JIT_STATS"):
        env.pop(key, None)
    if MODES[mode]:
        env[MODES[mode]] = "1"
    if stats:
        env["BO_JIT_STATS"] = "1"
    return env


def run_checked(command, env, expected, label, *, stats=False):
    result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    lines = result.stderr.splitlines()
    valid_stderr = (not lines if not stats else
                    len(lines) >= 4 and all(line.startswith("BO_JIT_STATS ") for line in lines))
    if result.returncode or result.stdout != expected or not valid_stderr:
        raise RuntimeError(f"{label}: exit={result.returncode} stdout={result.stdout!r} "
                           f"stderr={result.stderr!r}")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "c/bo")
    parser.add_argument("--repeat", type=int, default=7)
    parser.add_argument("--iterations", type=int, default=300_000)
    parser.add_argument("--collatz-limit", type=int, default=3000)
    parser.add_argument("--pipeline-size", type=int, default=10_000)
    parser.add_argument("--memory", action="store_true", help="collect peak RSS using /usr/bin/time")
    parser.add_argument("--diagnostics", action="store_true", help="run separate instrumented preflights")
    args = parser.parse_args()
    if min(args.repeat, args.iterations, args.collatz_limit, args.pipeline_size) < 1:
        parser.error("repeat, iterations and workload sizes must be positive")
    if not (ROOT / "c/native.c").is_file():
        parser.error("archived benchmark requires the restored native-JIT runtime; snapshot EXECUTION_EXPERIMENTS.md")
    if args.memory and not Path("/usr/bin/time").is_file():
        parser.error("--memory requires /usr/bin/time")
    binary = args.binary.resolve()
    cases = workloads(args.iterations, args.collatz_limit, args.pipeline_size)
    samples = {(name, mode): [] for name in cases for mode in MODES}
    memory = {}
    with tempfile.TemporaryDirectory() as directory:
        dump = Path(directory) / "stack"
        for mode in MODES:
            run_checked([binary, "--dump", dump, "-e", cases["startup-bare"][0]],
                        environment(mode), "", f"startup-bare/{mode}/preflight")
            if dump.read_text() != "3\n":
                raise RuntimeError(f"startup-bare/{mode}: incorrect stack {dump.read_text()!r}")
            caught = PRELUDE + "(1 0 /) (drop 9) () CATCH emit nl"
            run_checked([binary, "-e", caught], environment(mode), "9\n", f"caught-error/{mode}")
            missing = PRELUDE + "(missing) () APPLY"
            error = subprocess.run([binary, "-e", missing], cwd=ROOT, env=environment(mode),
                                   capture_output=True, text=True, timeout=180)
            expected_error = "Uncaught Exception -- stdin:1 Existence-Error (WORD) ((missing))\n"
            if (error.returncode, error.stdout, error.stderr) != (1, "", expected_error):
                raise RuntimeError(f"uncaught-error/{mode}: exit={error.returncode} "
                                   f"stdout={error.stdout!r} stderr={error.stderr!r}")
        if args.diagnostics:
            for name in ("calls-long", "branches-long", "rebind-long", "collatz", "pipeline"):
                source, expected = cases[name]
                result = run_checked([binary, "-e", source], environment("native", stats=True),
                                     expected, f"{name}/diagnostics", stats=True)
                print(f"{name} diagnostics\n" + result.stderr.rstrip(), flush=True)
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for name, mode in order:
                source, expected = cases[name]
                start = time.perf_counter()
                run_checked([binary, "-e", source], environment(mode), expected, f"{name}/{mode}")
                samples[name, mode].append(time.perf_counter() - start)
        if args.memory:
            for name, mode in samples:
                source, expected = cases[name]
                rss_file = Path(directory) / "rss"
                run_checked(["/usr/bin/time", "-f", "%M", "-o", rss_file, binary, "-e", source],
                            environment(mode), expected, f"{name}/{mode}/memory")
                memory[name, mode] = int(rss_file.read_text().strip())
    for (name, mode), times in samples.items():
        rss = f" peak_rss_kib={memory[name, mode]}" if args.memory else ""
        print(f"{name:18s} {mode:12s} median={statistics.median(times):.6f}s "
              f"min={min(times):.6f}s max={max(times):.6f}s{rss}")


if __name__ == "__main__":
    main()
