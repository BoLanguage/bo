// Differential test: PARALLEL under WebAssembly (in-process workers) against the native
// fork-based C runtime. Usage: node wasm/test_parallel.mjs   (after `make -C c` and `make -C c wasm`)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBo } from "./bo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const native = join(root, "c", "bo");
if (!existsSync(native)) {
    console.error("c/bo is not built");
    process.exit(2);
}

const cases = {
    order: "(1 2 3) (2 *) parallel (1 2) (dup dup) parallel (1 2) (drop) parallel () (dup) parallel ps",
    nested: "(1 2) ((3 4) (2 *) parallel) parallel ps",
    "named selector": "(1 2) (WORK) PUSH (2 *) (WORK) PUSH (WORK) PARALLEL (WORK) SNAPSHOT ps",
    "private stacks": "(1 2) (1 (WORK) PUSH (WORK) DEPTH) parallel (WORK) SNAPSHOT ps",
    "private redefinition": "(1 +) (inc) PUSH (5 6) ((9 +) (inc) PUSH 0 inc) parallel 1 inc ps",
    "private lock": "(1) (K) PUSH (2) ((K) LOCK 0) parallel (K) UNLOCK 3 (K) PUSH (K) SNAPSHOT ps",
    "private clear": "1 2 3 (A) PUSH (1 2) ((A) CLEAR (A) DEPTH) parallel (A) DEPTH ps",
    "default stack kept": "7 8 (1 2 3) (10 *) parallel ps",
    "worker error": "((1 0) (1 swap /) parallel) () catch ps (DIAGNOSTICS) DEPTH ps",
    "worker error uncaught": "(1 0) (1 swap /) parallel 99 ps",
    "worker exit": "((1) (0 exit) parallel) () catch ps",
    "bad operands": "(42 (dup) () PARALLEL) () catch ps",
    "worker new stacks": "(1 2) (5 (FRESH) PUSH 0) parallel (FRESH) DEPTH ps",
    "repeated": "(1 2 3) (dup *) parallel (4 5) ((dup *) parallel) parallel (1 2 3) (dup *) parallel ps",
    "gc pressure": "(1 2 3) (L) PUSH (7 8) ((1 2) (L) PUSH 20 (dup 0 >) (1 1000000 : drop 1 -) loop (L) SNAPSHOT) parallel (L) SNAPSHOT ps",
    "many items": "(1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20) (dup *) parallel ps",
    "array chunks": "((1 2 3 4 5 6 7 8) (8)) array 3 chunk (T) PUSH (T) SNAPSHOT ps",
};

const run = async (code) => {
    const nat = spawnSync(native, ["-e", `"include/std.bo" require ${code}`], { encoding: "utf8", timeout: 60000 });
    let stdout = "";
    let stderr = "";
    const bo = await createBo({
        onOutput: (text, stream) => (stream === "stdout" ? (stdout += text) : (stderr += text)),
    });
    bo.eval(code);
    return { nat, wasm: { stdout, stderr } };
};

// Not compared: workers' buffered stdout is lost by the native runtime when it is not a terminal
// (children end with _exit), while the WebAssembly runtime shows it.
let failed = 0;
for (const [name, code] of Object.entries(cases)) {
    const { nat, wasm } = await run(code);
    const same = nat.stdout === wasm.stdout && nat.stderr === wasm.stderr;
    if (!same) failed++;
    console.log(`${same ? "ok  " : "DIFF"} ${name}`);
    if (!same) console.log(`  native: ${JSON.stringify([nat.stdout, nat.stderr])}\n  wasm:   ${JSON.stringify([wasm.stdout, wasm.stderr])}`);
}
process.exit(failed ? 1 : 0);
