"""Compare a mechanically shaped direct-call assembly model with Bo."""

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
from bench.aot.run import build_model

CASES = {"calls": 1, "rebind": 3, "dynamic": 3}
MODES = {
    "model": ("model", None),
    "interpreter": ("reference", "BO_NO_JIT"),
    "compiled-ops": ("reference", None),
    "native-jit": ("native", None),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=500_000)
    parser.add_argument("--repeat", type=int, default=7)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 10_000_000 or args.repeat < 1:
        parser.error("--iterations must be between 1 and 10000000 and --repeat must be positive")
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        parser.error("this experiment requires Linux x86-64")
    samples = {(case, mode): [] for case in CASES for mode in MODES}
    with tempfile.TemporaryDirectory() as directory:
        binary = Path(directory) / "model"
        build_model(binary)
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS"):
            env.pop(key, None)
        env["BO_AOT_MODEL_STATS"] = "1"
        for case, factor in CASES.items():
            result = subprocess.run([binary, "model", case, "17"], cwd=ROOT, env=env,
                                    capture_output=True, text=True, timeout=30)
            fallbacks = 17 if case == "dynamic" else 0
            if (result.returncode, result.stdout.strip(), result.stderr.strip()) != (
                    0, str(17 * factor), f"BO_AOT_MODEL_STATS fallbacks={fallbacks}"):
                raise RuntimeError(f"{case} preflight: exit={result.returncode}, "
                                   f"stdout={result.stdout!r}, stderr={result.stderr!r}")
        for repeat in range(args.repeat):
            order = list(samples)
            if repeat % 2:
                order.reverse()
            for case, mode in order:
                implementation, flag = MODES[mode]
                env = os.environ.copy()
                for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                            "BO_AOT_MODEL_STATS"):
                    env.pop(key, None)
                if flag:
                    env[flag] = "1"
                start = time.perf_counter()
                result = subprocess.run([binary, implementation, case, str(args.iterations)],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
                elapsed = time.perf_counter() - start
                expected = str(args.iterations * CASES[case])
                if result.returncode or result.stderr or result.stdout.strip() != expected:
                    raise RuntimeError(f"{case}/{mode}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                samples[case, mode].append(elapsed)
    for (case, mode), times in samples.items():
        print(f"{case:8s} {mode:13s} median={statistics.median(times):.4f}s "
              f"result={args.iterations * CASES[case]}")


if __name__ == "__main__":
    main()
