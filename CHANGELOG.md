# Changelog

Versions follow [Semantic Versioning](https://semver.org/). While the major 
number is 0 the language is unstable: a minor bump may change the language, 
a patch bump only fixes or optimizes. The current version lives in the 
`VERSION` file (`NUMBER DATE`), which the C build and the Python REPL read 
for their banner and `--version`.

## Unreleased

- New module `include/constraint.bo`: constraint programming over finite domains, in plain Bo
  (not loaded by `std.bo`). Variables are ops with integer domains (`problem`, `setdomain`,
  `getdomain`); constraints relate expressions written as quotations (`#=`, `#\=`, `#<`,
  `#<=`, `#>`, `#>=`, `#in`, `alldiff`); `label` and `solutions` search with propagation and
  backtracking; `delay` runs a goal once its variables are bound; `consistent` tells whether a
  constraint was found impossible. Guide: `doc/constraint.md`. New example
  `16-constraints.bo` (map colouring, SEND + MORE = MONEY, the zebra puzzle) and extra
  examples `queens.bo` and `sudoku.bo`.
- New ops:
  - `branch ( b t e -- )` runs `t` or `e` on a truth value already on the stack (Joy's
    `branch`), where `ifte` runs its condition as a program; `when` and `unless` run a
    single program.
  - `pair ( a b -- L )` makes the two-element list `(a b)`.
  - `zipwith ( A B q -- C )` combines corresponding elements of two lists, as `map` does for
    one.
  - `group ( L -- G )` and `groupby ( L q -- G )` split a list into runs of consecutive
    equal elements, or of elements related by `q` (as in Haskell): `(1 1 2 1) group` gives
    `((1 1) (2) (1))`.
  - `circshift ( T n axis -- T' )` rotates an array along one zero-based axis, toward the start
    for a positive `n` as `rotate` does for lists (MATLAB's `circshift` goes the other way).
  - `numstr ( x -- S )` writes a number into a string as `emit` would print it, and
    `strnum ( S -- n )` reads a number literal back (`Domain-Error` for any other string).
  - `try ( .. T H -- .. )` is `catch` with a clean slate: if `T` fails, the default stack is
    put back as it was before `T` (with the values `T` took) and `H` runs with the error on
    top. `catch` still leaves `H` the stack as `T` left it, which is now documented.
- `rle.bo` and `life.bo` use the new ops: run-length encoding is `group` followed by a `map`,
  and the Game of Life works on a rank-two array with `circshift` and broadcasting.
- Fixed: in the Python runtime, `throw` with a private op as its kind (`(__Kind) throw` in a
  file) raised an error whose kind was the plain op of the same name, so the file could not
  catch it by comparing kinds; the C runtime already kept the private op.
- Fixed: `foreach`, `map`, `foldl`, `foldr`, `unfoldl` and `unfoldr` reported a
  value that is not a list as a `Stack-Error` from their own cleanup instead of the `Type-Error`
  it is, leaving part of their private state behind.
- New extra examples: `life.bo` (Conway's Game of Life, after Uiua), `rle.bo` (run-length
  encoding) and `fizzbuzz.bo`.
- `dedup` is now `unique`.
- `incr` moved from `examples/lib.bo` to the standard library (`include/dict.bo`), and
  `examples/lib.bo` is gone: the examples use only the standard library. Its exclusive `range`
  was not kept, as it would read like the inclusive `RANGE` primitive (`::`); the examples
  write ranges with `:` instead (`1 10 :` rather than `1 11 range`).
- `incr` raises `Type-Error` with the key as data when the key's top value is not a number,
  leaving the key as it was (it used to fail inside `ADD`). As documented now, the result
  becomes the key's only value, as with `set`.
- The callbacks of the iterating ops see the caller's stack right below their arguments, as in
  Joy and Factor: `0 (1 2 3) (apply +) foreach` leaves `6`, and
  `10 (1 2 3) (apply over + unit) map` leaves `10 (11 12 13)`. This holds for `foreach`, `map`,
  `filter`, `foldl`, `foldr`, `partition`, `sortby`, `unfoldl` and `unfoldr`, which now keep
  their own state on private stacks and clean it up after an error. `map` and `filter` take the
  top the callback leaves as its result; anything else it changes on the caller's stack stays
  changed. Code that reached values below the element by a fixed depth (such as `4 pick` in a
  `map` callback) must use the plain depth now (`over`).
- `filter` no longer builds a mask, which makes it several times faster. `foreach`, `map` and
  the folds are about 1.6 to 1.75 times slower on the C runtime, and `sort` about 1.3 times
  slower; the Python runtime is barely affected.
- The documented stack effect of `unfoldl` and `unfoldr` is `( L b stop step -- L' )`: they
  have always dropped the final seed.
- `showmatrix` and the extra examples `rule30.bo` and `primes-table.bo` use the caller's stack
  instead of named stacks as variables.
- `tagkey` marks an op in its key encoding with the byte `O` (it was `W`), so the names of
  generated keys that hold ops change.

## 0.2.0 (2026-11-27)

### Language (breaking)

- What Bo used to call a *word* is now an *op* throughout the language, the library and
  the documentation: numbers, lists and ops are the three kinds of values (`type` returns
  0, 1 and 2), and a *selector* is `()` or a unit holding an op.
- `TEXT`/`text` is now `NAME`/`name`, and `WORD`/`word` is now `SELECTOR`/`selector`. Both
  now accept `()`, the default-stack selector, which is also the empty string, so the two
  convert into each other over every selector.
- `isword` is now `isselector`.
- The error location of an op that cannot run is now `(EXECUTE)` instead of `(WORD)`, as in
  `Existence-Error (EXECUTE) ((FOO))`.
- A source name that cannot be an op name is reported as `invalid op name`.
- `tagkey` rejects a `()` tag itself (`Type-Error` raised by `THROW`).

### Standard library

- New module `include/control.bo`: `dip`, `keep`, `bi` and `times`. They keep their state on
  private stacks and clean it up after an error.
- New module `include/string.bo`: `strsplit` (split at a separator string, or at whitespace
  with `()`) and `strjoin`.
- `include/list.bo`: `sum` and `product` (moved from `examples/lib.bo`), `sort`, `sortby`
  (stable merge sort with a comparison), `rotate`, `dedup` and `partition`.
- `include/math.bo`: `sqrt`. `include/io.bo`: `say` and `says` (moved from `examples/lib.bo`).
- `include/array.bo`: `table` (an outer product with any binary op) and `showmatrix`
  (print a rank-two array one row per line).
- Library descriptions say "string" for lists of character codes, instead of "text".

### Examples

- `examples/extra/` holds additional, untested programs. The first ones are after examples
  of Uiua: palindrome, average, X matrix, acrostic, primes by a product table, quadratic
  formula and the Rule 30/90 cellular automata.
- `examples/lib.bo` keeps only `range` and `incr`. `05-wc.bo` counts words in `nwords`,
  so that it does not overwrite another stack.

### Documentation

- `doc/language.md` defines the terminology in one table (kinds and forms of values),
  renames its sections (*Ops as data*, *Private ops*, *Conversion between selectors and
  strings*) and clarifies that `(X) APPLY` consumes the top of `X`.
- All documentation, the READMEs and the playground use the new terms.

### Playground, WebAssembly and Playground+

- The debugger state reports the next op as `next.op` (it was `next.word`), and the step mode
  `"words"` is now `"ops"`.
- Playground+ puzzle specs name the op to define in `op` (it was `word`), and briefs list
  ops in `ops` (it was `words`). The solving metrics count tokens and are named so
  (`meanTokensToSolve`, `tokensTyped`). `playground-plus/tools/migrate-word-to-op.mjs`
  migrates an existing database.
- The language reference that Playground+ returns to agents may now be 15000 characters long
  (it was 14000).

### Internals

- The compiled instructions of the C runtime are `Instr` (kinds `I_*`), freeing the name
  `op` for Bo ops. The op value helpers, the Python `Op` class, `c/names.c`,
  `python/bo/names.py` and the test files follow the new names.

## 0.1.0 (2026-11-26)

- Python reference implementation in `python`.
- Native C runtime in `c`.
- Shared test corpus in `tests` and Python/C differential testing.
- Standard library implemented in Bo (`include`).
- Example programs in Bo (`examples`).
- Jupyter kernel (Python) and JupyterLab syntax highlighting (`jupyterlab`).
- VS Code extension in `vscode`.
- WebAssembly runtime (`wasm`) and interactive debugger, and breakpoints with stepping.
- Static browser playground and practice puzzles (`playground`).
- Playground+, a separate local application for agent-written puzzles (`playground-plus`).
- Documentation in `doc`.
- Python scripts (`tools`) for generation of grammar, default-stack adapters, docs.
- Benchmarks in `bench`. These include previous attempts to implement `JIT` and `AoT`
  (both deprecated because of the overhead underlying Bo's execution model).
- Bo mascot (Bobo) and playground screenshot in `images`.
- Makefile for building (described in `README.md`).
- MIT license. 
