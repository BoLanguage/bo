"""Micro benchmarks for the Bo standard library: python -m bench.bench."""
import contextlib
import io
import sys
import time

from python.bo.machine import Machine

CASES = {
    "loop 100k": "0 (dup 100000 <) (1 +) loop drop",
    "fact 20 x 2000": "((dup 0 =) (drop 1) (dup 1 - FACT *) ifte) (FACT) PUSH 2000 (dup 0 >) (20 FACT drop 1 -) loop drop",
    "map/fold 200 x 100": "() 0 (dup 200 =) (1 +) unfoldr (L) PUSH 100 (dup 0 >) ((L) TOP (apply dup * unit) map 0 (apply +) foldl drop 1 -) loop drop",
    "ps 30 elements": "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 ps",
}


def run(code, machine):
    with contextlib.redirect_stdout(io.StringIO()):
        start = time.perf_counter()
        ok = machine.execute(code)
        return time.perf_counter() - start, ok


def main():
    t0 = time.perf_counter()
    base = Machine()
    if not (base.include_file("include/core.bo") and base.include_file("include/std.bo")):
        raise RuntimeError("cannot load standard library")
    print(f"startup (std): {time.perf_counter() - t0:.2f}s")
    for name, code in CASES.items():
        machine = Machine()
        if not (machine.include_file("include/core.bo") and machine.include_file("include/std.bo")):
            raise RuntimeError("cannot load standard library")
        elapsed, ok = run(code, machine)
        print(f"{name:24s} {elapsed:7.2f}s {'ok' if ok else 'FAILED'}")


if __name__ == "__main__":
    main()
