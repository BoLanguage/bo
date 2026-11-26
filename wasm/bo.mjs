// Browser/Node loader for the WebAssembly build of the Bo C runtime (`make -C c wasm`).
import createBoModule from "./build/bo-core.mjs";

/**
 * Creates an isolated Bo machine.
 * @param {object} [options]
 * @param {(text: string, stream: "stdout"|"stderr") => void} [options.onOutput] receives output
 *   line by line (and any partial line when a call returns).
 * @param {string} [options.autoload] module to load at start, after "include/core.bo" which it needs:
 *   "include/std.bo" (default), "include/core.bo" alone, or "" for the kernel primitives only.
 * @param {string} [options.input] text served on standard input (EOF once consumed).
 */
export async function createBo({ onOutput = () => {}, autoload = "include/std.bo", input = "" } = {}) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let stdin = encoder.encode(input);
    let stdinPos = 0;
    const pending = { stdout: [], stderr: [] };

    const flush = (stream) => {
        const bytes = pending[stream];
        if (!bytes.length) return;
        pending[stream] = [];
        onOutput(decoder.decode(new Uint8Array(bytes)), stream);
    };
    const sink = (stream) => (byte) => {
        if (byte === null) return flush(stream);
        pending[stream].push(byte & 255);
        if (byte === 10) flush(stream);
    };

    const Module = await createBoModule({
        noInitialRun: true,
        preRun: [(m) => m.FS.init(() => (stdinPos < stdin.length ? stdin[stdinPos++] : null),
                                  sink("stdout"), sink("stderr"))],
    });
    // ccall copies string arguments onto the small wasm stack, which long programs overflow.
    const invoke = (name, returns, types, args) => {
        const allocated = [];
        const values = args.map((arg, i) => {
            if (types[i] !== "string" || arg === null) return arg;
            const pointer = Module.stringToNewUTF8(arg);
            allocated.push(pointer);
            return pointer;
        });
        try {
            return Module.ccall(name, returns, types.map((t) => (t === "string" ? "number" : t)), values);
        } finally {
            allocated.forEach((pointer) => Module._free(pointer));
            flush("stdout");
            flush("stderr");
        }
    };
    const call = (name, types, args) => invoke(name, "number", types, args);

    if (!call("bo_init", ["string"], [autoload])) throw new Error(`cannot load ${autoload}`);
    // What is loaded now is "library"; the visualizer shows only later stacks by default.
    Module.ccall("bo_mark_baseline", null, [], []);
    const json = (name, types, args) => JSON.parse(invoke(name, "string", types, args));
    const STATES = ["idle", "ready", "paused", "done", "error", "exit"];
    // "words": every word call; "lines": the first word of each top-level line;
    // "user": lines plus calls of user-defined words (library and kernel words run through).
    // "free": nothing counts, so a program only pauses at a BREAKPOINT (`@`).
    // "over": words like "words", but the calls they make run without stopping.
    const MODES = { words: 0, lines: 1, user: 2, free: 3, over: 6 };

    return {
        version: Module.ccall("bo_version", "string", [], []),
        /** Runs top-level code; false if an uncaught error was reported. */
        eval: (code) => !!call("bo_eval", ["string"], [code]),
        /** Includes a file from the virtual file system; false on error. */
        include: (path) => !!call("bo_include", ["string"], [path]),
        /** Status requested by `exit` during the last call, or null. A program that exits stops the
         *  current evaluation only; the machine stays usable. */
        exitCode: () => {
            const code = Module.ccall("bo_exit_code", "number", [], []);
            return code < 0 ? null : code;
        },
        /** Empties the default stack and the program's stacks; library stacks the program changed
         *  get their library definitions back. */
        clearStacks: () => Module.ccall("bo_clear_stacks", null, [], []),
        /** Treats everything defined so far as library (call after including your own prelude). */
        markBaseline: () => Module.ccall("bo_mark_baseline", null, [], []),
        /**
         * Stepping debugger. `load` prepares a program without running it; `step(n)` lets n words
         * run and pauses before the next (`step(0)` only reaches the first word). Nested runs such
         * as INCLUDE and PARALLEL count as one word. Returns the status:
         * "idle" | "ready" | "paused" | "done" | "error" | "exit". `step(n, mode)` counts steps
         * as words, lines or user words (see MODES). A program also pauses at a BREAKPOINT (`@`):
         * `state().breakpoint` then tells it from a step. `load(code, {fast: true})` keeps the
         * optimized operations until the program is stepped, so that `step(0, "free")` runs it at
         * full speed up to a breakpoint, as the prompt of the native runtime does; with
         * `{scratch: true}` (a prompt line) the status afterwards is the previous program's. While a program
         * is paused, `eval` runs at the pause point, and the words step, next, continue and stop
         * typed there only record what to do: `resume()` does it and returns the new status (null
         * if nothing was asked for).
         */
        debug: {
            load: (code, { fast = false, scratch = false } = {}) => (fast || scratch)
                ? !!call("bo_debug_load_fast", ["string", "number"], [code, scratch ? 1 : 0])
                : !!call("bo_debug_load", ["string"], [code]),
            resume: () => {
                const state = call("bo_debug_resume", [], []);
                return state < 0 ? null : STATES[state];
            },
            step: (n = 1, mode = "words") => STATES[call("bo_debug_step", ["number", "number"], [n, MODES[mode]])],
            /** Runs up to `limit` words; "paused" means the limit was reached. */
            run: (limit = 1e6) => STATES[call("bo_debug_step", ["number", "number"], [limit, 0])],
            abort: () => call("bo_debug_abort", [], []),
        },
        /**
         * Visualizer state: status, current line, the word about to run, the control stack, and
         * the default stack plus the user's stacks (origin "user" or "shadows" for a changed
         * library stack). Library, kernel and empty stacks are only counted in `counts`.
         */
        state: ({ maxItems = 200, maxChars = 120 } = {}) =>
            json("bo_state_json", ["number", "number"], [maxItems, maxChars]),
        /** Lists stacks (name, origin, depth) whose name contains `filter`; reveals library on demand. */
        stacks: (filter = "", { includeEmpty = false } = {}) =>
            json("bo_stacks_json", ["string", "number"], [filter, includeEmpty ? 1 : 0]),
        /** One stack by word name ("" is the default stack) with its top items, or null. */
        stack: (name = "", { maxItems = 200, maxChars = 400 } = {}) =>
            json("bo_stack_json", ["string", "number", "number"], [name, maxItems, maxChars]),
        /** Creates or replaces a file in the virtual file system (relative paths are under "/"). */
        writeFile: (path, text) => {
            const dir = path.split("/").slice(0, -1).join("/");
            if (dir) Module.FS.mkdirTree(dir);
            Module.FS.writeFile(path, text);
        },
        /** Replaces the standard input text. */
        setInput: (text) => {
            stdin = encoder.encode(text);
            stdinPos = 0;
        },
    };
}
