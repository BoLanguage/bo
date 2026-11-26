# Execution experiments: working notes

This is an internal working record.

Current benchmark commands are documented in
[`doc/benchmarks.md`](../doc/benchmarks.md); historical results in this file
describe archived runtime snapshots.

## Archive status

The native machine-code JIT was implemented and subsequently removed; compiled 
operations
remain the default execution tier. All native-JIT measurements and commands
below are historical and require a restored experimental runtime. The
`bench/compare/jit.py`, `tiers.py`, and `native_heavy.py` runners reject the
current runtime instead of reporting misleading tier comparisons.

The AOT and linked-fragment runtime hooks have been similarly implemented 
and then removed from the active
runtime. Their benchmark sources and tests remain as an inactive research
snapshot. Runtime-dependent tests live in `bench/aot/archive_tests/`, outside
normal test discovery, and retain explicit skip guards. The standalone
translator input test remains active in `tests/test_aot_translated.py`. Those
benchmark runners will not compile against the current runtime as-is.

[`bench/aot/runtime-experiments.patch`](bench/aot/runtime-experiments.patch)
preserves the prior experimental runtime diff against commit `35aed8d`,
including the JIT diagnostics and correctness changes present in those runtime
files at snapshot time. To revisit the experiments, use a separate clean
worktree at that commit, bring the snapshot files into it, and apply the patch
there; remove the archive skip decorators when intentionally running their
tests, for example with `python -m unittest discover bench/aot/archive_tests`.
Do not apply it blindly to the current worktree, where some changes
were intentionally retained. The archived results describe the snapshot, not
the current active build.

The active runtime retains the later selected-stack `IFTE`/`APPLY`
correctness fixes and compiled-operation tier. Native-JIT diagnostics and
machine-code generation are no longer part of the active runtime. The
intrinsic-handler layer was also removed; remaining specializations are part
of operation compilation. The current
`BO_NO_OP_OPTIMIZATIONS` setting disables operation-level optimizations while
still using compiled operations; legacy mode and flag names in the historical
record below refer to the archived experimental runtime.

After removal, five alternating checked runs compared the current default to
compiled operations (`BO_NO_NATIVE=1`) in the restored experimental snapshot.
Whole-process median seconds, snapshot/current: calls 0.2118/0.2098,
branches 0.1900/0.1904, rebinding 0.3310/0.3135, reduced Collatz
0.3535/0.3524, pipeline 0.0867/0.0660. Ranges overlapped in four cases.
The experimental snapshot is not the exact immediately preceding runtime,
and shared-host noise was visible; these measurements are a regression
check, not precise claims of a speedup.

## Interim conclusion

At the time of this assessment, both compiled operations and the native JIT
were kept as the baseline. The experiments did not demonstrate a sufficiently
consistent, representative benefit to justify replacing it with a full AOT
architecture. The existing runtime is the more established and lower-risk
option compared with adding these prototypes; this does not prove its
implementation is intrinsically simple or that AOT cannot be simpler.

Distinguish **compiled operations** from the **native JIT**. Compiled operations
were frequently the fastest reference in these measurements; native JIT was
sometimes slower than compiled operations or the interpreter. It would be
incorrect to conclude that native JIT always wins. A few constrained AOT
experiments did outperform compiled operations, so it would also be incorrect
to say every AOT attempt lost.

## Semantics and measurement constraints

- A Bo word is dynamically resolved through its named stack. Its current top
  can be a quotation, number, or empty, and primitive fallback or an error can
  apply. Redefinitions can happen during execution.
- Quotations are first-class values. Programs can construct, inspect, compare,
  split and reconstruct them; nested quotations are literals until executed.
  A reconstructed quotation has a different object identity even when it is
  structurally equal.
- Correct execution must preserve dynamic lookup, control continuations,
  `catch`, garbage collection and tail-call behavior. Future concurrency is
  a separate unresolved requirement; none of these prototypes is a
  concurrency-ready design.
- Timings below are host-specific whole-process medians, generally including
  startup and `include/std.bo` loading but excluding AOT translation and C
  compilation. Early prototypes included diagnostic counter updates; later
  experiments collect counters only in preflights, though timed paths still
  contain instrumentation conditionals. Different tables, iterations, builds
  and runs are not directly comparable.
- Counter values identify execution paths, not time attribution. A heavily
  executed loop or dispatch path is a hypothesis for a bottleneck, not proof
  of its individual cost. Experimental reference modes may use the same
  enlarged list layout as the candidate rather than the normal binary.

## Experiments and observations

### 1. Baseline C execution and JIT

`python3 bench/compare/jit.py --iterations 1000000 --repeat 3`
compared the interpreter (`BO_NO_JIT`), compiled operations without native code
(`BO_NO_NATIVE`), native JIT and native without intrinsics. On an x86-64 Intel
Xeon Platinum 8173M, representative results in seconds were:

| Workload | Interpreter | Compiled ops | Native JIT |
|---|---:|---:|---:|
| Baseline loop | 0.4940 | 0.4874 | 0.5007 |
| Calls | 0.7206 | 0.7305 | 0.7139 |
| Quotation | 0.5233 | 0.5312 | 0.5723 |
| Rebinding | 1.0496 | 1.0332 | 1.1685 |
| Branch-heavy, separate five-run measurement | 0.8242 | 0.6465 | 0.6834 |

Opt-in native diagnostics found many exits where a callee did not have native
code, and revision/cold exits in rebinding. Counts did not establish the
corresponding time cost. Reducing the native useful-operation threshold from
two to one produced mixed results (seven-run candidate/current ratios
0.993 baseline, 0.953 calls, 0.951 quotation, 1.012 rebind), and was not
adopted. Related work also fixed selected-stack `IFTE` and `APPLY`
correctness issues.

### 2. Small hand-written AOT bridges

- A preassembled `(1 +)` invoked the ordinary runtime for `+`. At five million
  iterations it was slower than the reference in all three compared runtime
  modes; for compiled ops, 0.3282s versus 0.3219s. It ran outside ordinary Bo
  control frames and did not demonstrate general continuation or `catch`
  support.
- An integrated two-quotation bridge associated fixed preassembled bodies with
  the original quotation objects, but still dispatched through the scheduler.
  At 500,000 iterations it measured 0.2321s versus 0.2565s compiled ops for
  calls, and 0.3638s versus 0.3817s for rebinding. This demonstrated a narrow
  dynamic-dispatch possibility, not a general compiler.
- A same-control-segment bridge saved native continuation positions and
  yielded unknown definitions to the normal scheduler, preserving surrounding
  `catch` behavior in tested cases. The later three-level hand-written bridge
  measured 0.3024s versus 0.3948s compiled ops for nested calls, and 0.3747s
  versus 0.4015s for nested calls with dynamic fallback. These included
  counters and used only a few fixed, hand-written bodies; depth limits,
  general tail calls and concurrency were not solved.

Reproduce current variants with `python3 bench/aot/run.py`,
`python3 bench/aot/integrated.py`, and `python3 bench/aot/bridge.py`.

### 3. Restricted generated AOT and the optimistic model

The initial translator returned to the scheduler per operation. At 500,000
iterations, generated-plus-ops versus compiled ops was 0.2969s versus 0.2665s
for calls, 0.3496s versus 0.3300s for nested quotations, and 0.4282s versus
0.4117s for rebinding. This was an early prototype, not an inherent cost of
AOT; the current translator no longer reproduces that version.

A separate hand-written direct-call model avoided much normal loop dispatch
and other work. It measured 0.0291s versus 0.2554s compiled ops for calls, and
0.0731s versus 0.3810s for rebinding. It was **not a theoretical upper
bound**: its loop control was specialized, some dynamic semantics and runtime
work were omitted, and its initial fallback used a separate control segment
that could not preserve an enclosing Bo `catch`. These numbers motivated
further study, not a projected speedup.

The generated direct-call version subsequently kept resumable Bo frames,
allowed direct calls to bound generated quotations, and capped native nesting
at 32. For 500,000 iterations it measured 0.2851s versus 0.2579s compiled ops
for calls, 0.3394s versus 0.3030s for nested quotation, and 0.3490s versus
0.3511s for a direct chain. It supported only literal
`(quotation) (WORD) PUSH` definitions, used runtime helpers, and did not
solve unrestricted native tail recursion or all safepoints.

Reproduce current variants with `python3 bench/aot/model.py` and
`python3 bench/aot/translated.py`. Historical versions and timings differ from
the current generated implementation.

### 4. Direct quotation descriptors

The initial generated implementation linearly scanned compiled blocks. Attaching
an experimental owner and block pointer directly to each list removed that
scan for exact compiled quotation objects. At 200,000 calls, five runs:

| Additional definitions | Descriptor | Linear scan | Compiled ops |
|---|---:|---:|---:|
| 0 | 0.1333s | 0.1567s | 0.1472s |
| 100 | 0.1394s | 0.3427s | 0.1460s |
| 500 | 0.1378s | 0.8053s | 0.1465s |

The scaling result isolates an avoidable lookup problem in that design; it is
not a general application speedup. Ordinary Bo values remain necessary and
the experiment adds two pointers to **every** list. Runtime-created quotation
identities have no matching compiled block and fall back.

Commands: `python3 bench/aot/descriptors.py --iterations 200000 --repeat 5`
and `python3 bench/aot/descriptor_workloads.py --repeat 5`.

### 5. More representative AOT coverage

Generated nested quotations were enabled on more control paths. With a
restructured `AOT-PROGRAM` and seven uninstrumented timing runs:

| Workload | Generated + ops | Compiled ops | Native JIT |
|---|---:|---:|---:|
| Reduced Collatz, 2 through 3000 | 0.3858s | 0.3793s | 0.4800s |
| Branches | 0.0996s | 0.0863s | 0.0969s |
| Rebinding | 0.0875s | 0.0966s | 0.1072s |
| Construct and apply | 0.1234s | 0.1347s | 0.1362s |

Preflight counted generated Collatz conditions and even/odd branches, but
**zero entries** into the original inner and outer loop-body blocks. The
library `loop` builds new recursive quotations, so exact-object AOT
associations do not carry over. The results are mixed, and do not represent a
complete standalone AOT program or show that loop machinery dominates elapsed
time.

Command: `python3 -m bench.aot.programs --repeat 7`.

### 6. Linkable per-element execution templates

`BO_LINKED_EXPERIMENT` copied execution records alongside list elements. A
record invokes a shared C-compiled literal or dynamic-word template; ordinary
quotation contents remain available. No special `loop` implementation or
machine-code patching was added. The Collatz preflight traced 215,063
executions of a **copied** `mod` operation in the constructed inner body.

Seven-run medians: reduced Collatz 0.4673s linked versus 0.3923s compiled
ops; construct-once 0.0850s versus 0.0732s; construct-fresh 0.1514s versus
0.1310s; branches 0.1313s versus 0.0909s. This establishes that copied
execution metadata can be used, not that it is faster. The per-element
indirect calls and scheduler/dynamic-dispatch work remain.

On that host the experimental list header was 64 bytes versus 56 normally;
an execution array added a 16-byte header and 24 bytes per element, excluding
allocator overhead. One-shot peak RSS is influenced by allocation and GC and
is not a per-object comparison.

Command: `python3 -m bench.aot.linked --repeat 7 --memory`.

### 7. Reusable complete fragments

`BO_LINKED_FRAGMENTS` generates C-compiled straight-line templates for
word/literal shapes found in the supplied source. Copied records retain
quotation origin and position. A complete contiguous reassembly can run the
shared fragment; partial spans fall back to per-element execution. Word calls
remain dynamic; no loop-specific rule or executable-memory patching is used.
The prototype still calls a helper per element and yields to the scheduler for
many dynamic calls. It scans generated shapes during preparation and is not
a general runtime compiler.

Seven-run medians from the same experimental binary and layout:

| Workload | Fragments | Per-element linked | Compiled ops |
|---|---:|---:|---:|
| Pre-existing quotation | 0.1374s | 0.1091s | 0.0795s |
| Construct once | 0.1301s | 0.1029s | 0.0871s |
| Construct each iteration | 0.1989s | 0.1709s | 0.1353s |
| Reduced Collatz | 0.6540s | 0.5108s | 0.4367s |
| Branches | 0.1780s | 0.1450s | 0.1012s |
| Rebinding | 0.1717s | 0.1356s | 0.1120s |

The preflight counted 215,063 entries to a copied multi-element fragment
containing the inner-body `mod`. Whole-Collatz scheduler visits were
15,628,939 both for fragments and per-element linked, versus 15,395,877 for
compiled ops. This implementation proved whole-fragment reuse but neither
reduced those visits nor improved these timings. Its 48-byte per-element
records, retained origins and allocation have memory costs. This does not
prove that a different fragment ABI or more direct dynamic calls cannot work.

Command: `python3 -m bench.aot.fragment_bench --repeat 7 --memory`.
The first three workloads include an extra `0 +` in the loop body to make
the traced fragment multi-element; don't compare them directly with section 6.

## Validation and open questions

The latest fragment work passed 62 focused linked/AOT/runtime tests, the
normal `make -C c` build, and `python3 -m tests.diff_c` (39 snippets, zero
mismatches). Tests include redefinitions, reconstructed and partial
quotations, continuations, errors and forced GC. These tests are evidence for
the covered cases, not a proof of complete semantics. Prototype-specific runtime flags are now archived rather than active.

Useful next questions, if the investigation resumes:

1. Profile time, allocations and scheduler transitions before choosing a new
   target; verify the actual workload cost rather than assuming loop dispatch.
2. Examine whether generic, more direct dynamic calls or fewer continuations
   can help without changing observable semantics; contrast against both
   compiled ops and native JIT. Avoid guards and special `loop` behavior unless
   the user explicitly revisits that design constraint.
3. Measure native tail recursion, long-running safepoints, list/code metadata
   retention, and concurrency requirements before recommending an architecture.
4. Preserve same-segment error handling and dynamic redefinition in every
   candidate. Do not equate copied structural equality with quotation identity.

No experiment establishes a general theoretical performance ceiling or proves
that fully implemented AOT cannot be worthwhile. The present evidence favors
keeping the existing execution architecture rather than undertaking that
investment now.

## Execution-tier comparison (initial assessment)

The active runtime was measured after removing AOT and linked runtime hooks,
while keeping the correctness fixes and opt-in JIT diagnostics. Reproduce with:

```text
make -C c
python3 bench/compare/tiers.py --repeat 7 --iterations 300000 \
  --collatz-limit 3000 --pipeline-size 10000 --memory --diagnostics
```

The runner checks bare-startup stack contents, caught and uncaught errors, and
the exact output of every timed workload. It runs seven alternating-order
whole-process samples, reporting minimum, median and maximum. Diagnostics and
one peak-RSS measurement per workload and mode are separate runs. `BO_NO_JIT`
disables the runtime's optimization choices, but still uses the `Code`
operation infrastructure; it is not a separate AST interpreter. `BO_NO_NATIVE`
keeps compiled-operation optimizations but disables native compilation.
Native is the normal default on supported platforms. Each std workload includes
library loading and JIT compilation; timing counters are disabled. The runner
uses the restored ordinary executable, not an experimental enlarged list layout.

On Linux x86-64, Intel Xeon Platinum 8173M, representative results:

| Long workload | No JIT | Compiled ops | Native JIT |
|---|---:|---:|---:|
| Calls | 0.2251s | 0.2228s | 0.2496s |
| Quotation | 0.1687s | 0.1742s | 0.1835s |
| Branches | 0.2568s | 0.2086s | 0.2056s |
| Rebinding | 0.3378s | 0.3308s | 0.3829s |
| Collatz 2..3000 | 0.3699s | 0.3725s | 0.4586s |
| Range/map/filter/fold, 1..10000 | 0.0784s | 0.0704s | 0.0881s |

The `long` microbenchmarks use 300,000 iterations. Some seven-sample ranges
overlap: for example branch compiled ops 0.1936-0.2170s and native
0.2017-0.2322s; pipeline compiled ops 0.0689-0.0883s and native
0.0769-0.0982s. Thus do not interpret a small median difference as certain.
Short (20-iteration) and startup measurements were especially noisy: bare
startup minima/maxima were approximately 0.0028-0.0076s across modes. They
cannot establish a reliable startup or compilation-cost difference from this
run alone.

Single whole-process peak-RSS measurements for Collatz were 13,488 KiB no JIT,
12,588 KiB compiled ops and 25,128 KiB native; pipeline was 17,040, 17,064 and
17,052 KiB respectively. These include startup, allocation, GC and code
memory; they are not isolated JIT allocations and one sample is insufficient
for a general memory estimate.

In separate native-instrumented runs, Collatz made 4,758 compilation attempts,
3,004 successes and 4,234,237 native entries, with 4,216,323 entries reported
as `not_native` exits. Branches recorded 299,950 native-to-native calls but
2,399,922 `not_native` exits. Counts explain executed paths, not time spent.
Native code generation is Linux x86-64 specific, manages executable mappings,
guards and continuation reconstruction, and relies on process-global native
exit/pending state in `c/machine.c`; future concurrent execution would need
to address that state independently of whether the native backend is kept.
The backend is 691 lines in this snapshot, not an estimate of all related
maintenance costs. Compiled-operation specialization also has guards, epoch
and redefinition handling; it is not a free or independent interpreter.

The C word-value suite exercises the explicit no-JIT, compiled-ops and native
modes, including forced GC and error behavior. The examples, CLI, numeric,
selected-stack and word-execution suites also passed in three environment runs
(68 tests each); several tests explicitly set their own mode and thus not
every test in each run is exclusive to that environment. The comparison
runner's error preflights and benchmark outputs passed in each mode.

**Interim decision:** keep compiled operations for now: the branch workload
shows a meaningful observed benefit relative to the no-JIT mode, though more
workloads would strengthen the decision. Native JIT did not demonstrate a
convincing net advantage on this sample and was notably slower on Collatz and
rebinding; its platform-specific machinery and the Collatz RSS observation
weigh against it. Do not remove it yet: this is one shared host and a small
workload set, startup differences are unresolved, and native-friendly sustained
arithmetic workloads deserve an explicit fair test. Next, measure at least one
long, genuinely native-heavy workload and compilation amortization, verify its
native completion rate separately, and repeat on a quieter or second host if
available. Then compare a removal build to the existing code, including
semantic and maintenance impact, before proposing deletion.

### 9. Native-heavy and amortization experiment

`python3 bench/compare/native_heavy.py --repeat 7 --long-count 100000` built
the C harness with the normal `-O2` flags and compared all three modes.
The harness uses the CLI's word-value initialization and loads `std.bo`.
It creates and roots one quotation, then calls `machine_run` in a C loop,
resetting and checking the data stack every iteration. Its execution timer
includes the loop, checks, operation compilation and native compilation, but
excludes process startup, standard-library loading and quotation construction.
Separate process timings include those costs; C compilation is excluded.

The branch quotation contains 100 constant-condition literal `IFTE` sites,
each producing one value. The arithmetic quotation starts at zero and performs
100 calls to `+`. Neither is a general application workload. Timings below
are seven-run medians from alternating mode order on the same Xeon Platinum
8173M; instrumented preflights were not timed.

| Case and iterations | No JIT execution | Compiled ops execution | Native execution |
|---|---:|---:|---:|
| Branches, 50 | 0.001062s | 0.000280s | 0.000429s |
| Branches, 100 | — | 0.000417s | 0.000481s |
| Branches, 500 | — | 0.001239s | 0.000958s |
| Branches, 1,000 | — | 0.001775s | 0.001082s |
| Branches, 100,000 | 0.680586s | 0.114503s | 0.050742s |
| Arithmetic, 100,000 | 0.518448s | 0.523935s | 0.720461s |

At 100,000 iterations, branch execution ranges were 0.112017–0.118983s
for compiled ops and 0.041557–0.051875s for native. Native was about 2.26x
faster than compiled ops in this favorable isolated case. Arithmetic native
was about 37.5% slower; its native range was 0.711989–0.729093s versus
0.510690–0.531843s for compiled ops.

At 49 branch entries the diagnostic reported no compilation; at 50 it
reported one compilation and one completed native entry. The 100,000-entry
preflight recorded one successful compilation, 99,951 native entries and
99,951 completions with no exits. The 500- and 1,000-entry medians favor
native, but their ranges overlap substantially; shared-host noise and
different process startup conditions prevent a precise crossover or isolated
compilation-cost estimate. The arithmetic preflight recorded 9,999,951 native
entries and the same number of `not_native` call exits at `+`, with no native
completions. This is not a native-heavy arithmetic workload: in the current
word-value execution path those calls do not become inline native arithmetic.

The additional end-to-end Bo program repeatedly calls a 100-branch word and
drops its 100 outputs in the library `loop`; its 10,000-iteration
whole-process medians were 0.139599s no JIT, 0.083190s compiled ops and
0.091838s native. Compiled/native ranges overlap (0.065478–0.085261s and
0.080835–0.100668s). Its preflight counted 9,950 native-to-native calls,
but also 1,059,919 call exits, including 999,952 at `drop`. These counters
do not establish time attribution. This case is deliberately branch-heavy and
its stack cleanup is substantial, not a representative application.

**Updated assessment:** native compilation can pay off substantially when a
large fixed quotation completes in native code; it is not inherently useless.
However, the gain did not translate into a clear end-to-end win for this
Bo-driven case, and the intended sustained arithmetic case exposed a frequent
exit path instead. Together with the preceding representative measurements,
the data still favors compiled ops as the default performance baseline; it
does not yet demonstrate that native JIT's complexity earns its cost for real
programs. A precise amortization threshold and broader performance claim
remain unresolved. Keep the current behavior unchanged until the user chooses
whether to remove the backend, retain it as an optional experiment, or pursue
representative workloads that can sustain native execution.
