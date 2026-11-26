# Benchmarks

Benchmark results depend on the machine, build, and workload; they are not
language guarantees. The current C runtime executes compiled Bo operations,
not generated machine code. See [the machine overview](machine.md) for the
execution model.

## Standard-library microbenchmarks

Run the Python reference microbenchmarks from the repository root:

```sh
.venv/bin/python -m bench.bench
```

They time a small set of standard-library workloads after loading
`include/std.bo`. These are smoke-level timing samples, not a statistically
rigorous performance suite.

## Array parallel workloads

The array benchmark compares explicit rank-one array work partitioned with
`CHUNK`, `PARALLEL`, and `CONCAT` against sequential
results. It includes elementwise broadcast, scalar reductions, dot products,
and configurable local pipelines. The runner checks each result against its
sequential counterpart before timing. Timings include process startup, library
loading, input construction, worker startup, and result aggregation.

Build the C runtime and run the workloads from the repository root:

```sh
make -C c
python3 -m bench.array_parallel
```

Select workloads and their parameters with `--workloads`, `--sizes`,
`--chunks`, and `--depths`; for example:

```sh
python3 -m bench.array_parallel \
    --workloads sum-pipeline dot-pipeline \
    --sizes 2000000 --chunks 24 48 --depths 1 4 16 64
```

Parallel execution uses separate OS processes, so setup and data transfer can
outweigh the work for small inputs. Compare multiple runs on an otherwise idle
machine, and treat small differences cautiously.

## Archived runtime experiments

Historical investigations of retired C execution modes and compiler changes
are kept in [`bench/EXECUTION_EXPERIMENTS.md`](../bench/EXECUTION_EXPERIMENTS.md).
Those results and commands describe archived snapshots, not the current
runtime.

