// The operations of one Bo machine as seen by a UI, independent of where it runs: in a Web
// Worker (client.mjs), or directly in Node (tests). Every method is async and takes and
// returns only JSON-compatible values, so a UI framework can wrap it without changes.
import { createBo } from "../wasm/bo.mjs";

/**
 * @param {(text: string, stream: "stdout"|"stderr") => void} onOutput
 */
export function createSession(onOutput) {
    let bo = null;
    let files = {};
    let input = "";

    const need = () => {
        if (!bo) throw new Error("the machine is not initialized");
        return bo;
    };

    return {
        /** (Re)creates a fresh machine; `files` are written to its virtual file system. */
        async init({ files: newFiles = files, input: newInput = input, autoload = "include/std.bo" } = {}) {
            files = newFiles;
            input = newInput;
            bo = await createBo({ onOutput, autoload, input });
            for (const [path, text] of Object.entries(files)) bo.writeFile(path, text);
            return { version: bo.version };
        },
        async eval(code) {
            return need().eval(code);
        },
        async setInput(text) {
            input = text;
            if (bo) bo.setInput(text);
        },
        async clearStacks() {
            need().clearStacks();
        },
        async markBaseline() {
            need().markBaseline();
        },
        /** `options` are `fast` and `scratch` (see debug.load in wasm/bo.mjs). */
        async debugLoad(code, options = {}) {
            return need().debug.load(code, options);
        },
        /** Resolves to the status after running `n` steps in `mode`. */
        async debugStep(n = 1, mode = "ops") {
            return need().debug.step(n, mode);
        },
        async debugRun(limit) {
            return need().debug.run(limit);
        },
        /** Carries out a step, next, continue or stop typed while a program is paused: the status, or null. */
        async debugResume() {
            return need().debug.resume();
        },
        async debugAbort() {
            need().debug.abort();
        },
        async state(options) {
            return need().state(options);
        },
        async stacks(filter, options) {
            return need().stacks(filter, options);
        },
        async stack(name, options) {
            return need().stack(name, options);
        },
    };
}

export const SESSION_METHODS = [
    "init", "eval", "setInput", "clearStacks", "markBaseline", "debugLoad", "debugStep", "debugRun", "debugResume", "debugAbort",
    "state", "stacks", "stack",
];
