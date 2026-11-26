"""Build and compare a preassembled STEP with the ordinary runtime."""

import argparse
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ("machine.c", "heap.c", "units.c", "words.c", "lower.c", "native.c", "lineedit.c")
MODES = {
    "aot-interpreter": ("aot", "BO_NO_JIT"),
    "reference-interpreter": ("reference", "BO_NO_JIT"),
    "aot-ops": ("aot", "BO_NO_NATIVE"),
    "reference-ops": ("reference", "BO_NO_NATIVE"),
    "aot-native": ("aot", None),
    "reference-native": ("reference", None),
}


def build(binary):
    command = [os.environ.get("CC", "cc"), "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
               "-I", str(ROOT / "c"), str(ROOT / "bench/aot/step.c"),
               str(ROOT / "bench/aot/step.S"),
               *(str(ROOT / "c" / source) for source in SOURCES), "-lm", "-o", str(binary)]
    subprocess.run(command, cwd=ROOT, check=True)


def build_integrated(binary):
    command = [os.environ.get("CC", "cc"), "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
               "-DBO_AOT_EXPERIMENT", "-I", str(ROOT / "c"),
               str(ROOT / "bench/aot/integrated.c"), str(ROOT / "bench/aot/integrated.S"),
               *(str(ROOT / "c" / source) for source in SOURCES), "-lm", "-o", str(binary)]
    subprocess.run(command, cwd=ROOT, check=True)


def build_translated(binary, source, linear=False):
    from bench.aot.translate import translate

    asm, harness = translate(source)
    assembly = binary.with_suffix(".S")
    driver = binary.with_suffix(".c")
    assembly.write_text(asm, encoding="utf-8")
    driver.write_text(harness, encoding="utf-8")
    command = [os.environ.get("CC", "cc"), "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
               "-DBO_AOT_TRANSLATED", "-I", str(ROOT / "c"), str(driver), str(assembly),
               *(str(ROOT / "c" / item) for item in SOURCES), "-lm", "-o", str(binary)]
    if linear:
        command.insert(1, "-DBO_AOT_LINEAR")
    subprocess.run(command, cwd=ROOT, check=True)

def build_linked(binary, fragment_sources=None):
    command = [os.environ.get("CC", "cc"), "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
               "-DBO_LINKED_EXPERIMENT", "-I", str(ROOT / "c"),
               str(ROOT / "bench/aot/linked.c"),
               *(str(ROOT / "c" / item) for item in SOURCES), "-lm", "-o", str(binary)]
    if fragment_sources is not None:
        from bench.aot.fragments import generate
        generated = binary.with_suffix(".fragments.c")
        generated.write_text(generate(fragment_sources), encoding="utf-8")
        command.insert(1, "-DBO_LINKED_FRAGMENTS")
        command.insert(-2, str(generated))
    subprocess.run(command, cwd=ROOT, check=True)


def build_model(binary):
    command = [os.environ.get("CC", "cc"), "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
               "-DBO_AOT_MODEL", "-I", str(ROOT / "c"),
               str(ROOT / "bench/aot/model.c"), str(ROOT / "bench/aot/model.S"),
               *(str(ROOT / "c" / item) for item in SOURCES), "-lm", "-o", str(binary)]
    subprocess.run(command, cwd=ROOT, check=True)


def build_bridge(binary):
    command = [os.environ.get("CC", "cc"), "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
               "-DBO_AOT_BRIDGE", "-I", str(ROOT / "c"),
               str(ROOT / "bench/aot/bridge.c"), str(ROOT / "bench/aot/bridge.S"),
               *(str(ROOT / "c" / item) for item in SOURCES), "-lm", "-o", str(binary)]
    subprocess.run(command, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=1_000_000)
    parser.add_argument("--repeat", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 100_000_000:
        parser.error("--iterations must be between 1 and 100000000")
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    if sys.platform != "linux" or platform.machine() != "x86_64":
        parser.error("this experiment requires Linux x86-64")

    samples = {mode: [] for mode in MODES}
    with tempfile.TemporaryDirectory() as directory:
        binary = Path(directory) / "step"
        build(binary)
        for repeat in range(args.repeat):
            order = list(MODES)
            if repeat % 2:
                order.reverse()
            for mode in order:
                implementation, flag = MODES[mode]
                env = os.environ.copy()
                for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS"):
                    env.pop(key, None)
                if flag:
                    env[flag] = "1"
                start = time.perf_counter()
                result = subprocess.run([binary, implementation, "normal", str(args.iterations)],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
                elapsed = time.perf_counter() - start
                if result.returncode or result.stderr or result.stdout.strip() != str(args.iterations):
                    raise RuntimeError(f"{mode}: exit={result.returncode}, "
                                       f"stdout={result.stdout!r}, stderr={result.stderr!r}")
                samples[mode].append(elapsed)
    for mode, times in samples.items():
        print(f"{mode:22s} median={statistics.median(times):.4f}s result={args.iterations}")


if __name__ == "__main__":
    main()
