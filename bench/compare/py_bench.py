import sys, time
import numpy as np

def loop():
    s = 0; i = 0
    while i < 5000000:
        s += i; i += 1
    return s

def fib(n): return n if n < 2 else fib(n - 1) + fib(n - 2)

def collatz():
    t = 0
    for n in range(2, 30001):
        while n > 1:
            n = n // 2 if n % 2 == 0 else 3 * n + 1
            t += 1
    return t

def pipeline():
    return sum(x for x in (y * y for y in range(1, 200001)) if x % 2 == 0)

def pipeline_np():
    a = np.arange(1, 200001, dtype=np.int64) ** 2
    return int(a[a % 2 == 0].sum())

def loop_np():
    return int(np.arange(5000000, dtype=np.int64).sum())

CASES = {"loop": loop, "fib": lambda: fib(32), "collatz": collatz,
         "pipeline": pipeline, "pipeline_numpy": pipeline_np, "loop_numpy": loop_np}
for name, f in CASES.items():
    best = 1e9
    for _ in range(3):
        t = time.perf_counter(); r = f(); best = min(best, time.perf_counter() - t)
    print(f"{name} {best:.4f} {r}")
