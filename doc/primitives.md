# Primitives


In stack effects, the top is on the right. `D` is the default stack, `s` is
the consumed stack selector, and `S` is the stack selected by `s`. Thus
`D: (s --), S: (A B -- C)` means an ordinary primitive removes the selector
from the default stack and replaces the operands on the selected stack. Every
primitive consumes a selector; stack operations show both stack roles
explicitly. If `s` is `()`, `S` is the default stack and the roles alias.
The Stack column identifies the stack role used by each primitive: `D` is the
default stack, `S` is the stack named by `s`, and `D`<->`S` indicates a
cross-stack operation.

Kernel primitives are ops with plain uppercase names made of letters and digits (`ADD`,
`DROP`, `IFTE`); the section headings below only group them by topic. Their
default-stack wrappers are installed by `include/core.bo` as ordinary
definitions: lowercase for spelled names (`drop`, `parallel`), and a symbol alone
for primitives that have one (`+` for `ADD`, `=` for `EQUAL`, `.` for
`BROADCAST`). A symbol has no uppercase form, so it cannot be confused with its
primitive and no spelled twin such as `add` exists.
Primitives are locked: they cannot be redefined, and a named stack cannot share
a primitive's name. The inventory below is generated from
`include/primitives.json`; wrappers and derived ops are listed in the
[library reference](library.md).

#### Array

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `ARRAY` | primitive | `D: (s --), S: (F Q -- T)` | `S` (named `s`) | On `S`, validate flat numeric data `F` and shape `Q` and construct array `T`. |
| `BROADCAST` | primitive | `D: (s --), S: (A B U -- C)` | `S` (named `s`) | On `S`, apply the binary op held by unit `U` to every pair of elements of numbers or arrays `A` and `B`, aligning shapes from the right. The op runs with the pair on top and must leave exactly one number. |
| `CHUNK` | primitive | `D: (s --), S: (T n -- C)` | `S` (named `s`) | On `S`, split rank-one array `T` into `n` ordered rank-one array chunks. |
| `CONCAT` | primitive | `D: (s --), S: (C -- T)` | `S` (named `s`) | On `S`, concatenate an ordered list of rank-one array chunks. |
| `DOT` | primitive | `D: (s --), S: (A B -- x)` | `S` (named `s`) | On `S`, return the dot product of rank-one arrays `A` and `B`. |
| `FETCH` | primitive | `D: (s --), S: (T I -- x)` | `S` (named `s`) | On `S`, return the zero-based element at index list `I` of array `T`. |
| `MATMUL` | primitive | `D: (s --), S: (A B -- T)` | `S` (named `s`) | On `S`, multiply rank-two arrays `A` and `B`. |
| `MEAN` | primitive | `D: (s --), S: (T axis-or-() -- x-or-T')` | `S` (named `s`) | On `S`, compute the arithmetic mean globally or along one axis. |
| `MEDIAN` | primitive | `D: (s --), S: (T axis-or-() -- x-or-T')` | `S` (named `s`) | On `S`, compute the median globally or along one axis. |
| `OUTER` | primitive | `D: (s --), S: (A B -- T)` | `S` (named `s`) | On `S`, return the rank-two outer product of rank-one arrays `A` and `B`. |
| `RANK` | primitive | `D: (s --), S: (T -- n)` | `S` (named `s`) | On `S`, return the rank of array `T`. |
| `REDUCE` | primitive | `D: (s --), S: (T axis-or-() U -- x-or-T')` | `S` (named `s`) | On `S`, fold array `T` over all axes or along one zero-based axis with the binary op held by unit `U`, from left to right starting at each slice's first element. Each step runs `U` with the accumulator and the next element on top; it must leave exactly one number. An empty slice raises `Domain-Error`. |
| `RESHAPE` | primitive | `D: (s --), S: (T Q -- T')` | `S` (named `s`) | On `S`, return `T` with shape `Q`; the element count must not change. |
| `SHAPE` | primitive | `D: (s --), S: (T -- Q)` | `S` (named `s`) | On `S`, return the shape list of array `T`. |
| `STORE` | primitive | `D: (s --), S: (T I x -- T')` | `S` (named `s`) | On `S`, return `T` with `x` at zero-based index `I`; `T` remains unchanged. |
| `TRANSPOSE` | primitive | `D: (s --), S: (T -- T')` | `S` (named `s`) | On `S`, transpose rank-two array `T`. |

#### Control

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `ABORT` | primitive | `D: (s --), S: ( -- )` | `D` (default) | Abandon the current top-level run. |
| `APPLY` | primitive | `D: (s --), S: (L -- ...)` | `S` (named `s`) | On `S`, execute the elements of list `L` in order. |
| `CALL` | primitive | `D: (s --), S: (SETUP BODY CATCHER CLEANUP -- ...)` | `S` (named `s`) | On `S`, run `SETUP` and `BODY`, then `CLEANUP`; after a body error, run `CATCHER` after cleanup. |
| `EXIT` | primitive | `D: (s --), S: (C -- )` | `S` (named `s`) | On `S`, terminate with integer exit status `C` from 0 through 255. |
| `IFTE` | primitive | `D: (s --), S: (I T E -- ...)` | `S` (named `s`) | On `S`, execute `I`, then execute `T` if its result is positive or `E` otherwise. |
| `LAMBDA` | primitive | `D: (P s --), S: ( -- )` | `D` (default) | Run the program `P` in a frame labelled by `s`. The selector is a *virtual* stack selector, a unit containing an op or `()`: it works as a label that is only compared, and no stack is ever created or touched. Inside `P`, `REC` with the same selector runs `P` again. The frame is dropped when `P` ends or an error unwinds it. |
| `LOOP` | primitive | `D: (s --), S: (C B -- ...)` | `S` (named `s`) | Take `C` and `B` from `S` and repeat: execute `C`, and if its result is positive execute `B` and start again, otherwise stop. The programs run like those of `IFTE`, and the loop leaves no frame that `REC` could find, so a `rec` inside `B` belongs to the enclosing `LAMBDA`. A loop runs in constant control-stack space. |
| `PARALLEL` | primitive | `D: (s --), S: (L Q -- R)` | `S` (named `s`) | On `S`, run quotation `Q` for each item of `L` in isolated workers and collect their final stacks in input order. |
| `REC` | primitive | `D: (s --), S: ( -- )` | `D` (default) | Run again the program of the innermost running `LAMBDA` whose label is `s`, as a tail call when nothing follows. The selector is a *virtual* stack selector, like that of `LAMBDA`: a label that creates no stack. Without such a frame `REC` raises `Existence-Error`. Recursive file-local ops lower to a labelled `LAMBDA`, so a callback of another recursive op never reaches the wrong frame; `()` is the anonymous label of `lambda` and `rec`. |

#### Debug

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `BACKTRACE` | primitive | `D: (s --), S: ( -- L)` | `S` (named `s`) | On `S`, push the list `L` of the programs being run, innermost first. Each is a list `(NAME PROGRAM INDEX)`: `NAME` is a unit with the op whose call started it (`()` if none did), `PROGRAM` is the list it runs and `INDEX` the number of its elements that have already run. |
| `BREAKPOINT` | primitive | `D: (s --), S: ( -- )` | `D` (default) | Pause the program here and return to the prompt, which then runs at this point until `STEP`, `NEXT`, `CONTINUE` or `STOP`. It does nothing where the program cannot be paused: in a script or an included file, in a nested run such as `PARALLEL`, and in hosts without a prompt. |
| `CONTINUE` | primitive | `D: (s --), S: ( -- )` | `D` (default) | Resume the paused program until the next `BREAKPOINT` or its end. Raises `Debug-Error` if no program is paused. |
| `NEXT` | primitive | `D: (s --), S: ( -- )` | `D` (default) | Resume the paused program and pause again before the next op at the same depth or shallower, running the definitions it calls without pausing. Raises `Debug-Error` if no program is paused. |
| `STEP` | primitive | `D: (s --), S: ( -- )` | `D` (default) | Resume the paused program and pause again before the next op it calls, also inside the definitions it calls. Raises `Debug-Error` if no program is paused. |
| `STOP` | primitive | `D: (s --), S: ( -- )` | `D` (default) | Drop the paused program without running the rest of it, keeping the stacks. Raises `Debug-Error` if no program is paused. |

#### Error

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `CATCH` | primitive | `D: (s --), S: (T H -- ...)` | `S` (named `s`) | On `S`, run `T` and, on error, run `H` with the error on top; without an error `H` is not run. |
| `RETHROW` | primitive | `D: (s --), S: (E -- )` | `S` (named `s`) | On `S`, propagate existing error `E` without recording it again. |
| `THROW` | primitive | `D: (s --), S: (L K -- )` | `S` (named `s`) | On `S`, raise an error whose kind is the selector `K` (such as `(Type-Error)`) with data list `L`; any other `K` raises `Type-Error`. |

#### List

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `CONSL` | primitive | `D: (s --), S: (L U -- L')` | `S` (named `s`) | On `S`, prepend the element of unit `U` to list `L`. |
| `CONSR` | primitive | `D: (s --), S: (L U -- L')` | `S` (named `s`) | On `S`, append the element of unit `U` to list `L`. |
| `UNCONSL` | primitive | `D: (s --), S: (L -- L' U)` | `S` (named `s`) | On `S`, remove the first element of a non-empty list into a unit. |
| `UNCONSR` | primitive | `D: (s --), S: (L -- L' U)` | `S` (named `s`) | On `S`, remove the last element of a non-empty list into a unit. |
| `UNIT` | primitive | `D: (s --), S: (X -- U)` | `S` (named `s`) | On `S`, wrap the top value in a one-element list. |

#### Math

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `ADD` | primitive | `D: (s --), S: (A B -- C)` | `S` (named `s`) | On `S`, add `A` and `B`. |
| `DIV` | primitive | `D: (s --), S: (A B -- C)` | `S` (named `s`) | On `S`, divide `A` by `B` using true division. |
| `IDIV` | primitive | `D: (s --), S: (A B -- C)` | `S` (named `s`) | On `S`, floor-divide `A` by `B`. |
| `MUL` | primitive | `D: (s --), S: (A B -- C)` | `S` (named `s`) | On `S`, multiply `A` and `B`. |
| `POW` | primitive | `D: (s --), S: (A B -- C)` | `S` (named `s`) | On `S`, raise `A` to the power `B`. |
| `RANGE` | primitive | `D: (s --), S: (START STEP END -- L)` | `S` (named `s`) | On `S`, generate an inclusive numeric range from `START` to `END` using `STEP`. |
| `RATIO` | primitive | `D: (s --), S: (X -- N DEN)` | `S` (named `s`) | On `S`, return the exact numerator and denominator of number `X`. |
| `SUB` | primitive | `D: (s --), S: (A B -- C)` | `S` (named `s`) | On `S`, subtract `B` from `A`. |

#### Source

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `INCLUDE` | primitive | `D: (s --), S: (P -- )` | `S` (named `s`) | On `S`, lower and execute the source file named by `P`, even if it was already loaded, after taking out what its earlier load left (its private ops, the items it pushed, its locks and the stacks it made; see the language guide). The default-stack op `require` skips files that were loaded. |
| `INCLUDED` | primitive | `D: (s --), S: (P -- 1\|0)` | `S` (named `s`) | On `S`, report whether source file `P` has already been loaded; 0 if its load ended in an error. |
| `PARSE` | primitive | `D: (s --), S: (T -- P)` | `S` (named `s`) | On `S`, read the source code in string `T` and leave the program it denotes as the list `P`, without running it. Invalid source raises `Syntax-Error` with the message and the line within `T`. |

#### Stack

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `CLEAR` | primitive | `D: (s --), S: (... --)` | `S` (named `s`) | On `S`, remove all values. |
| `DELETE` | primitive | `D: (s --), S: (... --)` | `S` (named `s`) | On `S`, remove the stack itself, so that `EXISTS` reports 0 for it and its values are lost; pushing to it again creates it anew. The default stack and locked stacks, which include every primitive, cannot be deleted (`Permission-Error`); deleting an unlocked primitive's stack only discards its definitions, and the primitive remains. `CLEAR` only empties a stack, which then continues to exist. |
| `DEPTH` | primitive | `D: (s -- n), S: (... -- ...)` | `D`<->`S` (cross-stack) | Count the values on `S` and push the count onto `D`. The count is also 0 for an op that has no stack (`EXISTS` tells it apart from an empty one) and for a primitive, whose stack holds no values. |
| `DROP` | primitive | `D: (s --), S: (A -- )` | `S` (named `s`) | On `S`, remove the top value. |
| `EXISTS` | primitive | `D: (s -- 1\|0), S: ( -- )` | `D`<->`S` (cross-stack) | Report whether `S` exists, without creating it. |
| `LEXICON` | primitive | `D: (s --), S: ( -- L)` | `S` (named `s`) | On `S`, push the list `L` of the selectors of every op that has a stack, that is, every one for which `EXISTS` reports 1, primitives and emptied stacks included, ordered by name. Each selector is a unit containing the op, so it can be used as it is. Filter the list in Bo and map `CLEAR` or `DELETE` over what is left. |
| `LOCK` | primitive | `D: (s --), S: ( -- )` | `S` (named `s`) | On `S`, protect against mutation: it then refuses `PUSH`, `POP`, `CLEAR`, `DELETE` and the like. Locking a locked stack changes nothing. The default stack cannot be locked (`Permission-Error`). |
| `LOCKED` | primitive | `D: (s -- 1\|0), S: ( -- )` | `D`<->`S` (cross-stack) | Report whether `S` is locked, as every primitive's stack is and `LOCK` makes any other: it then refuses `PUSH`, `POP`, `DELETE` and the like. The default stack is not locked, and the result is also 0 for an op that has no stack (`EXISTS` reports 0 for it). |
| `PICK` | primitive | `D: (s --), S: (.. An .. A0 n -- .. An .. A0 An)` | `S` (named `s`) | On `S`, copy the zero-based nth value to the top. |
| `POP` | primitive | `D: (s -- A), S: (A --)` | `D`<->`S` (cross-stack) | Remove the top value `A` from `S` and push it onto `D`. |
| `PUSH` | primitive | `D: (A s --), S: ( -- A)` | `D`<->`S` (cross-stack) | Push `A` from `D` onto `S`. |
| `ROLL` | primitive | `D: (s --), S: (.. An .. A0 n -- .. A0 An)` | `S` (named `s`) | On `S`, move the zero-based nth value to the top. |
| `SNAPSHOT` | primitive | `D: (s -- L), S: (... -- ...)` | `D`<->`S` (cross-stack) | Copy the contents of `S` as a list onto `D`. |
| `TOP` | primitive | `D: (s -- A), S: (A -- A)` | `D`<->`S` (cross-stack) | Copy the top value `A` from `S` onto `D`. |
| `UNLOCK` | primitive | `D: (s --), S: ( -- )` | `S` (named `s`) | On `S`, remove mutation protection. Unlocking a stack that is not locked, such as the default stack, changes nothing. Unlocking a primitive's stack lets a definition shadow the primitive. |

#### Stream

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `CLOSE` | primitive | `D: (s --), S: (H -- )` | `S` (named `s`) | On `S`, close stream `H`. |
| `OPEN` | primitive | `D: (s --), S: (P M -- H)` | `S` (named `s`) | On `S`, open file `P` with mode `M` and return its handle `H`. |
| `READ` | primitive | `D: (s --), S: (H -- c)` | `S` (named `s`) | On `S`, read the next character code from stream `H`, or return -1 at end of file. |
| `WRITE` | primitive | `D: (s --), S: (c H -- )` | `S` (named `s`) | On `S`, write character code `c` to stream `H`. |

#### Value

| Name | Type | Effect | Stack | Description |
|---|---|---|---|---|
| `EQUAL` | primitive | `D: (s --), S: (A B -- 1\|0)` | `S` (named `s`) | On `S`, compare values structurally. |
| `NAME` | primitive | `D: (s --), S: (K -- N)` | `S` (named `s`) | On `S`, convert the selector `K` to the name `N` of its op, a string; the default-stack selector `()` gives the empty string `()`. |
| `SELECTOR` | primitive | `D: (s --), S: (N -- K)` | `S` (named `s`) | On `S`, convert the string `N`, a valid op name, to the selector `K` of that op; the empty string `()` gives the default-stack selector `()`. |
| `TYPE` | primitive | `D: (s --), S: (X -- K)` | `S` (named `s`) | On `S`, return 0 for a number, 1 for a list, or 2 for an op. |
| `UNITTYPE` | primitive | `D: (s --), S: (U -- K)` | `S` (named `s`) | On `S`, inspect the element type of unit `U`: 0 number, 1 list, or 2 op. |

### Stacks


Including `include/core.bo` installs ordinary, unlocked default-stack
wrappers: for example, `drop` is `(() DROP)`, `+` is `(() ADD)`, and
`parallel` is `(() PARALLEL)`. Wrapper comments and definitions are generated
from `include/primitives.json` by `tools/generate_adapters.py`, which also
validates the metadata against the C native registry; `--check` verifies that
`include/core.bo` is current. Symbols (`+`, `-`, `=`, and so on) are wrappers
defined directly from the kernel primitives, with no spelled twin. It
contains wrappers only; higher-level predicates belong to focused library
modules. `PUSH`, `POP`, `TOP`, and `EXISTS` have no default-stack wrappers
because they transfer values between stacks or inspect arbitrary stack keys.

Every stack selector must be `()` or a unit containing an op; other values
raise `Type-Error`. The selector `()` names the default stack. `() POP` leaves its top value
unchanged, `() TOP` duplicates it, and `() SNAPSHOT` and `() DEPTH` inspect the
stack after consuming the selector. `TOP`, `SNAPSHOT`, and `DEPTH` can inspect
locked named stacks without changing them.
`EXISTS` returns `1` for the default stack and every native or previously
created named stack, including an empty one; it does not create missing stacks.

### Default stack


`PICK` and `ROLL` read the index from the selected stack, not
necessarily the default stack. For example,
`1 (WORK) PUSH (WORK) ROLL` moves the second element of `WORK` to
its top.

### Lists and types


`U` must contain exactly one element; otherwise `Type-Error` is raised. An
empty list for `unconsl`/`unconsr` raises `Stack-Error`. `UNIT` wraps the
top value on selected stack `S`. The `Value` library builds total predicates
such as `isunit` and `isselector` from these primitives.

### Execution and control


`PARALLEL` is the kernel primitive for `parallel`. Each worker starts
with an otherwise empty data stack, with
its input item on top, and runs `q` with a copy of the current named stacks and op
definitions. The result `R` is a list of the workers' final data stacks, so a
one-result callback produces one-element lists inside `R`. Named-stack changes
made by a worker are private and discarded. If multiple workers fail, the
error from the earliest input item is rethrown and recorded once. An empty
input list returns an empty result list. Workers run in separate OS processes;
worker startup makes this most useful for coarse-grained work. A worker that
aborts or exits is reported as `Evaluation-Error` at `PARALLEL`.
External side effects such as stream writes are not isolated and may occur in
any order.

`ifte` plus recursion is sufficient for other control flow (loops, switch, ...).

### Arithmetic

The selected-stack effects of `ADD SUB MUL DIV IDIV POW`
are each `(a b -- c)`, with `a` deeper than `b`; every call also consumes a
selector from the default stack. Thus
`7 2 () SUB` leaves `5` and `(WORK) ADD` operates on `WORK`. The ordinary
wrappers `+ - * / // ^` select the default stack; they remain
overrideable definitions rather than kernel primitives.

- `/` (`DIV`) is true division: `6 2 /` is `3` and `7 2 /` is `3.5`.
- `//` (`IDIV`) is floor division. It exists because digit extraction
  (printing numbers from inside Bo) needs it; `mod` is derived from it.
- `^` (`POW`) is general real exponentiation: `9 0.5 ^` is `3`, not only
  integer exponentiation. Its result must be finite; division by zero,
  `0` to a negative exponent and a negative base with a non-integral exponent
  raise `Domain-Error`, and overflow raises `Evaluation-Error`.

Everything else is derived. Because truth is "greater than 0", subtraction already is a comparison: `b a -` is true exactly when `a < b`. So `<`, `>`, `neg`, `abs`, `max`, `min`, `mod` and so on belong to the library ([library](library.md)). `EQUAL` is a primitive (in the inventory above) because lists need structural comparison.

### Ranges

The ordinary, overrideable `:` and `::` wrappers construct numeric lists:


These follow MATLAB's colon operand order: `1 10 :` gives `(1 2 3 4 5 6 7 8 9 10)`, while `0 2 10 ::` gives `(0 2 4 6 8 10)`. Operands must be finite numbers (otherwise `Domain-Error`). A step pointing away from the endpoint, including a zero step, produces an empty list. Floating-point quotients sufficiently close to an integer are rounded to that integer, and the final value is set to the endpoint; this makes decimal intervals such as `0 0.1 0.3 ::` include `0.3` despite binary floating-point representation. A result with more than `2^32 - 1` elements raises `Resource-Error`, and a non-finite value computed along the way raises `Evaluation-Error`.

`RANGE` has selected-stack effect `(start step end -- L)` and consumes a
selector from the default stack, so `0 2 10 () RANGE` leaves
`(0 2 4 6 8 10)`.
`core.bo` defines the ordinary, unlocked wrappers `::` as `(() RANGE)` and
`:` as `(1 1 () ROLL () RANGE)`, which inserts the unit step before calling
`RANGE`. There is deliberately no `range` op in `core.bo`, so programs may
define their own.

### Arrays

Arrays are rectangular numeric arrays represented by an ordinary
two-element list `((D) (Q))`: flat row-major numeric data `D` followed by a
non-negative integer shape list `Q`. Array operations validate this structure
when invoked; there is no separate runtime array type.


For example, `(1 2 3 4 5 6) (2 3) array` constructs
`((1 2 3 4 5 6) (2 3))`; `(1 2) ->` on it returns `6`. The empty shape `()` represents
a scalar array and requires exactly one data element. Shapes with a zero
dimension are valid and require empty data. Invalid data types or non-integer
dimensions raise `Type-Error`. Negative dimensions, non-finite elements and
out-of-bounds indices raise `Domain-Error`; inconsistent element counts and
rank mismatches raise `Shape-Error`; a size over `2^32 - 1` elements raises
`Resource-Error`.

The selected-stack primitives are `ARRAY`, `SHAPE`, `RANK`, `RESHAPE`,
`FETCH`, `STORE`, `CHUNK`, `CONCAT`, `DOT`, `MEAN`,
`MEDIAN`, `TRANSPOSE`, `OUTER`, `MATMUL`, `BROADCAST`, and `REDUCE`.
Each consumes a selector from the default stack and preserves operands when
it fails. `core.bo` installs the lowercase default-stack wrappers (`array`,
`shape`, ...), with the symbols `->` for `FETCH`, `<-` for `STORE`, `.` for
`BROADCAST` and `..` for `REDUCE`.

`chunk` requires a positive integral `n` and returns exactly `n` chunks,
whose lengths differ by at most one; earlier chunks receive the remainder.
It accepts only rank-one arrays, and may return empty rank-one chunks when
`n` exceeds the array length. `concat` likewise accepts only rank-one arrays. It also accepts the direct
output of `parallel` when every worker leaves exactly one rank-one array,
unwrapping those one-value worker stacks. `() concat` returns the empty
rank-one array `(() (0))`. These operations make explicit work partitioning,
such as `T n chunk (q) parallel concat`, composable without exposing a
mutable array representation.

`REDUCE` folds an array with any binary op, so no reduction primitive is
duplicated for sums, products or extremes. Its selected-stack effect is
`(T axis-or-() U -- x-or-T')`: `U` is a selector holding the op, and `core.bo`
defines the wrapper `..` (`.` applies an op to every pair of elements, `..`
collapses a whole axis), used as `T () (+) ..`. With
`()` it folds all flat data from left to right and returns a plain number.
With a zero-based axis it folds each slice along that axis and returns an
array whose shape removes that axis; for example, a `(2 3)` array reduced
along axis `0` returns shape `(3)`, and along axis `1` shape `(2)`. A rank-one
input reduced along axis `0` produces a rank-zero array. Each slice starts at
its first element, then `REDUCE` pushes the accumulator and the next element
and runs the op, which must leave exactly one number (otherwise
`Stack-Error` or `Type-Error`, as for `BROADCAST`). A slice of one element is
returned without calling the op. There is no seed, so an empty slice (an
empty array, or an axis of length zero) raises `Domain-Error`; a reduction
with no output slices, such as a `(0 3)` array reduced along axis `1`, returns an
empty array without calling the op. Invalid axes raise `Domain-Error` and
oversized output shapes `Resource-Error`; the op's own errors, such as overflow
in `+`, are rethrown unchanged with the stack restored. Like `BROADCAST`, the C
runtime folds natively when the op is an unmodified wrapper of `ADD`, `SUB`,
`MUL`, `DIV`, `IDIV` or `POW`, and runs the op itself if a step would fail.

The usual reductions are plain calls: `T () (+) ..` (sum), `T () (*) ..`
(product), `T () (min) ..` and `T () (max) ..` (extremes), each also with an
axis in place of `()`. The library ops `any` and `all` (in
`include/array.bo`) test whether any or every element is positive, globally or
along one axis, as `(max) .. 0 (>) .` and `(min) .. 0 (>) .`; like every
reduction they raise `Domain-Error` on an empty slice.

`DOT` accepts two equally long rank-one arrays and returns the left-to-right
sum of their elementwise products. The dot product of two empty vectors is
`0`. A rank mismatch or unequal lengths raise `Shape-Error`, and an overflow
raises `Evaluation-Error`.

`MEAN` and `MEDIAN` follow the explicit axis-or-`()` convention
and reject an empty all-axis reduction or empty reduced slice with `Domain-Error`. `MEDIAN` sorts each
reduced slice; for an even number of values it returns the arithmetic average
of the two central values. `transpose` and `matmul` accept rank-two arrays
only; matrix multiplication requires matching inner dimensions. `outer`
accepts rank-one arrays only. Rank mismatches and incompatible matrix
dimensions raise `Shape-Error`, an output over `2^32 - 1` elements raises
`Resource-Error`, and overflow raises `Evaluation-Error`.

### Broadcasting

`BROADCAST` applies any binary operation elementwise to numbers and arrays, so
no arithmetic primitive is duplicated for arrays. Its selected-stack effect is
`(A B U -- C)`: `U` is a selector holding the operation, and `core.bo` defines
the wrapper `.`, used as `A B (+) .`. Shapes are aligned from the right;
dimensions must match, or one must be `1`, in which case that operand is
repeated along the dimension. A number broadcasts over every element. The
result is an array whenever either operand is an array; two numbers apply the
op once and return a plain number.

For every pair of elements, `BROADCAST` pushes the pair on the selected stack
and runs the op, which must leave exactly one number there (so `(+)`, `(max)`,
`(rem)`, `(drop)` and user-defined ops all work); otherwise it raises
`Stack-Error` (wrong number of results) or `Type-Error` (not a number). The
op's own errors are rethrown unchanged, with the stack and operands
restored. The op is looked up when `BROADCAST` runs, so redefining `+`
changes the result.

When the op is currently an unmodified default-stack wrapper of `ADD`, `SUB`,
`MUL`, `DIV`, `IDIV` or `POW` (for example `+`, `-`, `*`, `/`, `//`, `^`), the C
runtime computes the pairs natively instead of running the op. The result is
identical, because the op is run after all if a pair would raise an error.

For example, `(1 2 3 4 5 6) (2 3) array (10 20 30) (1 3) array (+) .`
produces `((11 22 33 14 25 36) (2 3))`, and `2 (*) .` multiplies every
element of an array on the stack by `2`. A zero-sized dimension broadcasts
with a matching or singleton dimension and produces an empty array. Lists
are not broadcast operands; `U` must be the selector of an op. Incompatible
shapes raise `Shape-Error`; operand type errors raise `Type-Error`.
