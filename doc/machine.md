# The machine

Bo has a Python reference implementation in `python/bo/` and a native C
runtime in `c/`. Both runtimes implement the same language behavior. A machine
begins with the kernel primitives only; the command-line programs (`c/bo` and
`python -m python.bo`) then load the default-stack wrappers of `include/core.bo`
unless `--bare` is given, whereas an embedded machine (`Machine()`, `machine_init`,
the WebAssembly module) stays bare until the host loads it. A program can load the
aggregate standard library with `include/std.bo`, or focused modules under
`include/` (these need `core.bo`).

## Values and stacks

The source is tokenized and lowered to numbers, lists, and first-class ops
before execution. Parentheses form nested list values, strings lower to lists
of Unicode code points, and each top-level form retains its source line for
error reporting. An op identifies a named stack. When the op runs, the
runtime executes the current top value if it is a list, pushes it if it is a
number, or invokes a kernel primitive if the stack is empty and that name is
native. This keeps user definitions, redefinitions, and primitive dispatch
within one lookup model.

The data stack and named stacks hold the same kinds of values. Lists are
immutable, and ops remain distinct values from lists of character codes.
Named-stack contents are dynamically resolved, so definitions can be changed
while programs are running without freezing an op to an earlier definition.
Native stacks are protected by default; a definition can shadow a native
primitive only after its stack is explicitly unlocked. See
[the language reference](language.md) for the observable semantics.

## Top-level execution

The command-line runtimes lower source forms and execute them in order.
`INCLUDE` uses the same lowering and execution path for a file while
tracking the current source and line. The standard library and user programs
are therefore ordinary Bo definitions rather than special runtime modules.

Execution uses explicit frames for running lists and control operations.
`APPLY` schedules a list as a program; conditional branches, `catch`,
and `call` use frames to resume or unwind execution. This model lets
definitions call themselves without turning every call into a host-language
recursive call. Errors preserve their Bo shape and are offered to the nearest
handler before reaching the top-level error handler.

## Execution

The Python machine maintains data and named stacks plus an explicit control
stack. It executes lists as programs, handles tail calls without unbounded
control-stack growth, and implements errors as Bo error lists dispatched to
`catch` or `EXCEPTION`.

The C runtime represents values with tagged NaN-boxed values, stores
immutable lists and op identities in managed memory, and uses a mark-sweep
collector. Lists may have cached compiled operation sequences. These sequences
are interpreted by the C execution loop; the runtime does not generate
machine code and has no JIT or AOT backend.

The operation compiler can specialize recognized default-stack wrappers and
literal control-flow patterns. Specialized code remains subject to Bo's
dynamic definitions: if a relevant definition changes, stale code checks its
guards and falls back to ordinary op dispatch. Set
`BO_NO_OP_OPTIMIZATIONS=1` to disable these specializations while retaining
compiled operation sequences.

A `REC` or `rec` that is the last operation of a lambda's own program, with that
lambda's frame directly below, runs as a jump back to the start of the program,
which is how the recursive local helpers iterate. Anywhere else it is an
ordinary call.

A literal `(c) (b) loop` (the default-stack wrapper of `LOOP`, with both programs
written as list literals next to it) compiles to `c`, a branch out of the loop,
`b` and a jump back, with no frame and no setup per loop. Programs that are
computed at run time use the `LOOP` primitive, which keeps one loop frame and
runs the same way.

## Validation

`tests/test_examples.py` runs examples against both command-line runtimes.
`tests/test_c_op_values.py` covers op identity, collection, execution,
and redefinition in the C runtime. `make -C c test` also runs the
Python–C differential tests.

For current benchmark commands and their scope, see [benchmarks](benchmarks.md).

