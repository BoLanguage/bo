# Bo WebAssembly runtime

The C runtime built to WebAssembly (with Emscripten), and a JavaScript wrapper for browsers and Node. It is
what the [playground](../playground/README.md) and [Playground+](../doc/playground-plus.md) run Bo on.

```
source ~/emsdk/emsdk_env.sh      # Emscripten, see the top-level README
make -C c wasm                   # builds wasm/build/bo-core.mjs and bo-core.wasm (git-ignored)
```

| File | Role |
|---|---|
| `bo.mjs` | The wrapper: `createBo({onOutput, autoload, input})` makes an isolated machine with `eval`, `include`, `writeFile`, `setInput`, `clearStacks`, the step debugger (`debug.load/step/run/abort`) and state inspection for a visualizer (`state()`, `stacks()`, `stack()`). The comments in the file describe each. |
| `build/` | The Emscripten output (`bo-core.mjs`, `bo-core.wasm`); it embeds `include/`. Not in git. |
| `test_examples.mjs` | The examples under WebAssembly. |
| `test_debugger.mjs` | Stepping, state, baseline classification. |
| `test_parallel.mjs` | `PARALLEL` against the native runtime (needs `c/bo`). |

`make test-wasm` runs the tests (`tests/test_wasm.py` does too, from the Python suite). Without `fork`, WASM
workers run one after another in the same process on saved machine state, and `exit` stops only the current
evaluation (see the top-level README). Private words (`__name`, see the language guide) work as in the other runtimes:
the library's helpers are owned by their files, so they stay out of the stack listings, and stepping
through a library word still shows their names.
