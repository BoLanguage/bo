# Changelog

Versions follow [Semantic Versioning](https://semver.org/). While the major 
number is 0 the language is unstable: a minor bump may change the language, 
a patch bump only fixes or optimizes. The current version lives in the 
`VERSION` file (`NUMBER DATE`), which the C build and the Python REPL read 
for their banner and `--version`.

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
