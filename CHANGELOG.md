# Changelog

Versions follow [Semantic Versioning](https://semver.org/). While the major 
number is 0 the language is unstable: a minor bump may change the language, 
a patch bump only fixes or optimizes. The current version lives in the 
`VERSION` file (`NUMBER DATE`), which the C build and the Python REPL read 
for their banner and `--version`.

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
