# Status and limitations

Bo is an experimental programming language with a draft specification. It
is suitable for exploration, learning, language-design experiments and
personal programs. It is not currently positioned as a stable
general-purpose language or as a production dependency.

## Compatibility contract

The project uses semantic versioning. While the major version remains zero:

- a minor release may change syntax, semantics, stack effects or library names;
- a patch release is intended for fixes and optimizations;
- old programs are not guaranteed to run unchanged across minor releases.

The [changelog](../CHANGELOG.md) records breaking changes. A future 1.0 would
be a separate decision requiring a stable documented language contract; it is
not implied by this public release.

## What is implemented

Bo currently includes:

- a Python reference implementation and a native C runtime;
- a shared test corpus and Python/C differential testing;
- a standard library implemented in Bo;
- a WebAssembly runtime and interactive debugger, and breakpoints with stepping at the
  native prompt ([debugging](debugging.md));
- the static browser playground and practice puzzles;
- a Jupyter kernel and JupyterLab syntax highlighting;
- a VS Code extension;
- Playground+, a separate local application for agent-written puzzles.

The generated documentation and editor data, native runtime, Python
implementation, WebAssembly runtime, playground and Playground+ all have test
coverage. Tests passing on one revision do not imply that the language has a
stable public API.

## Runtime relationship

The Python implementation serves as the readable reference implementation.
The C runtime is the native execution target and is also compiled to
WebAssembly for browser use. All three use the same source language and
standard library; the Python/C differential suite checks representative and
regression behavior.

The C runtime interprets compiled operation sequences. It has no machine-code
JIT or ahead-of-time backend. Some operations have guarded specializations,
but performance remains secondary to observable semantics and dynamic
redefinition.

## Current limitations

### Language and library

- Public words share one namespace; only private words (`__name`, owned by the file that writes them) are hidden, and there is no module or package system.
- Names, definitions and execution are dynamically resolved.
- Numeric values are IEEE-754 doubles; NaNs and infinities are not produced by
  arithmetic.
- `PARALLEL` uses isolated OS processes in native execution. Setup, library
  loading and data transfer can outweigh the work for small jobs.
- Some large-language conveniences are intentionally absent: for example,
  general filesystem, asynchronous-task and GPU APIs are not part of the
  language contract.

### Error handling and diagnostics

- Source diagnostics track the innermost source location. Nested includes do
  not yet expose a full include stack.

These are also collected in [open questions](open-questions.md).

### Performance

Bo is an experimental execution model, not a performance claim. The current
benchmarks are smoke tests and workload samples, not portable comparative
measurements. See [benchmarks](benchmarks.md) before drawing conclusions from
a timing.

### Browser and editor surfaces

- The WebAssembly, playground, VS Code extension and Jupyter integration are
  part of the project but remain subject to the 0.x compatibility policy.
- The published site is a static playground. Share links contain program text
  in the URL fragment; it is not sent to the page's server.
- Playground+ is local-only and requires separate Node, WebAssembly and,
  optionally, Ollama setup. It is not part of the static playground's runtime
  or deployment.

## Open versus future work

[Open questions](open-questions.md) lists semantic decisions that may require
feedback. [Planned updates](planned-updates.md) lists possible implementation
work and is explicitly not a commitment or release schedule.

Reports should distinguish reproducible bugs and documentation errors from
proposals for new language features. Neither an item in the roadmap nor a
technical possibility is a promise that it will be implemented before 1.0.

