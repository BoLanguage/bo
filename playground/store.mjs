// Application state and actions of the playground. It knows nothing about the DOM: a view (plain
// functions today, framework components later) renders `getState()` and calls the actions.
//
// The machine runs behind an async client (client.mjs). Actions are serialized, except `stop`,
// which only raises a flag that a running program checks between chunks of steps.
//
// An optional `onEvent` observer receives one event per user-facing action (see createStore); the
// playground itself does not use it. It is how an application built on the playground records play.

export const RUN_CHUNK = 20000; // words per chunk when running; the page stays responsive between chunks
const MAX_OUTPUT = 2000;
const STATE_OPTIONS = { maxItems: 200, maxChars: 160 };
const DETAIL_OPTIONS = { maxItems: 50, maxChars: 400 };

const ACTIVE = new Set(["ready", "paused"]);

/**
 * @param {(onOutput: Function) => object} createClient builds a client; called again by `kill`
 * @param {{files?: Record<string,string>, input?: string, chunk?: number, onEvent?: Function}} [options]
 *   files for the virtual file system, standard input, the words per chunk when running, and an
 *   optional observer. The observer gets, after each setup, restart, evaluate, step, run, runFast,
 *   reset, clearStacks, abort and kill action: `{type, time, duration, version, before, after, status,
 *   output, error, ...details}`, where `time` is the start in ms since the epoch, `version` is the
 *   Bo runtime's, `before` and `after` are machine states (null before the first machine), and the
 *   details are `code` (the raw text), plus
 *   `ok` for evaluate and `count` and `mode` for step. A failing observer is logged and ignored.
 */
export function createStore(createClient, { files = {}, input = "", chunk = RUN_CHUNK, onEvent = null } = {}) {
    let state = {
        ready: false,
        version: null,
        files,
        input,
        mode: "words", // "words" | "over" | "lines" | "user": what one step is
        status: "idle", // "idle" | "ready" | "paused" | "done" | "error" | "exit"
        machine: null, // the machine's state JSON (see bo.state() in wasm/bo.mjs)
        stacksShown: false, // the stacks are displayed: once something is on them, until a fresh machine or clearStacks
        hiddenStacks: [], // names the UI omits from the stack panel
        hiddenStackPrefixes: [],
        puzzleGoal: null,
        puzzleDescription: null,
        puzzleHints: 0,
        puzzleFreeHints: 0,
        puzzleTitle: null,
        previous: null, // the machine state before the last action, to mark what changed
        output: [], // {stream, text}
        source: "prompt", // what the output and echo belong to: "prompt" | "program"
        echo: "", // the text last evaluated from the prompt
        fastRun: false, // Run starts programs without the stepper (see runFast)
        fast: null, // after a fast run: {ok, line}, the line being the one that failed (0 if unknown)
        pausedAtPrompt: false, // the paused program is a prompt line that reached a breakpoint, not the editor's
        library: { open: false, filter: "", total: 0, stacks: [], details: {} },
        busy: false,
        busySince: 0,
        running: false,
        fastRunning: false,
        error: null,
    };
    const listeners = new Set();
    let stopRequested = false;
    let queue = Promise.resolve();

    const set = (patch) => {
        state = { ...state, ...patch };
        for (const listener of listeners) listener(state);
    };
    const onOutput = (text, stream) => {
        const last = state.output[state.output.length - 1];
        const output =
            last && last.stream === stream && !last.text.endsWith("\n")
                ? [...state.output.slice(0, -1), { stream, text: last.text + text }]
                : [...state.output, { stream, text }];
        set({ output: output.slice(-MAX_OUTPUT) });
    };
    let client = createClient(onOutput);

    /** Runs `task` after the previous action, tracking the busy flag and errors. */
    const enqueue = (task) => {
        const result = queue.then(async () => {
            set({ busy: true, busySince: Date.now(), error: null });
            try {
                return await task();
            } catch (error) {
                set({ error: String(error?.message ?? error) });
            } finally {
                set({ busy: false, running: false });
            }
        });
        queue = result.catch(() => {});
        return result;
    };

    const refreshLibrary = async () => {
        const { total, stacks } = await client.stacks(state.library.filter);
        const details = {};
        for (const name of Object.keys(state.library.details)) {
            const stack = await client.stack(name, DETAIL_OPTIONS);
            if (stack) details[name] = stack;
        }
        set({ library: { ...state.library, total, stacks, details } });
    };

    const refresh = async () => {
        const machine = await client.state(STATE_OPTIONS);
        // the stacks appear when something is on them and stay (empty) until a fresh machine or "Reset everything"
        const content = machine.stacks[0].depth > 0 || machine.stacks.length > 1;
        set({
            previous: state.machine, machine, status: machine.status, stacksShown: state.stacksShown || content,
            pausedAtPrompt: state.pausedAtPrompt && ACTIVE.has(machine.status),
        });
        if (state.library.open) await refreshLibrary();
    };

    const initMachine = async () => {
        const { version } = await client.init({ files: state.files, input: state.input });
        set({ ready: true, version, status: "idle", previous: null, stacksShown: false, pausedAtPrompt: false });
    };

    /** Starts a fresh machine with `code` loaded and paused before its first word. */
    const startProgram = async (code) => {
        await initMachine();
        set({ output: [], source: "program", fast: null });
        if (await client.debugLoad(code)) await client.debugStep(0, state.mode);
        await refresh();
        return ACTIVE.has(state.status);
    };

    /** Runs `task` and reports it to `onEvent`; `info` carries the details, which the task may extend. */
    const observed = async (type, info, task) => {
        if (!onEvent) return task();
        const before = state.machine;
        const time = Date.now();
        let error = null;
        try {
            return await task();
        } catch (caught) {
            error = String(caught?.message ?? caught);
            throw caught;
        } finally {
            try {
                onEvent({ type, time, duration: Date.now() - time, version: state.version, ...info, before, after: state.machine, status: state.status, output: state.output, error });
            } catch (observerError) {
                console.error("onEvent observer failed:", observerError);
            }
        }
    };

    /** Like enqueue, but first asks a running program to yield so the task starts soon. */
    const interrupting = (task) => {
        stopRequested = true;
        return enqueue(task);
    };

    const actions = {
    /** Creates the machine; call once before anything else. */
    start: () => enqueue(async () => {
        await initMachine();
        await refresh();
    }),
    /** Resets the machine and loads `code`, paused before its first word. */
    restart: (code) => interrupting(() => observed("restart", { code }, () => startProgram(code))),
    /** Runs `count` steps of the current mode (loading `code` first if nothing is active). */
    step: (code, count = 1) => enqueue(() => observed("step", { code, count, mode: state.mode }, async () => {
        if (!ACTIVE.has(state.status)) {
            // a program just loaded is already paused before its first word
            if (!(await startProgram(code)) || count === 1) return;
        }
        set({ source: state.pausedAtPrompt ? state.source : "program", fast: null });
        await client.debugStep(count, state.mode);
        await refresh();
    })),
    /** Runs the program to its end (or until `stop`), in chunks. */
    run: (code) => enqueue(() => observed("run", { code }, async () => {
        if (!ACTIVE.has(state.status) && !(await startProgram(code))) return;
        stopRequested = false;
        set({ running: true, source: state.pausedAtPrompt ? state.source : "program", fast: null });
        for (;;) {
            const status = await client.debugRun(chunk);
            await refresh();
            // "paused" is also what a chunk that ran out of words reports: a breakpoint is told apart
            if (status !== "paused" || stopRequested || state.machine.breakpoint) break;
        }
    })),
    /**
     * Runs `code` on a fresh machine without the stepper: optimized and faster, but it can only be
     * paused by a breakpoint (`@`), after which the program is paused as if it had been stepped.
     * Output arrives while it runs; only `stop` (which replaces the machine) interrupts it.
     */
    runFast: (code) => enqueue(() => observed("runFast", { code }, async () => {
        set({ output: [], source: "program", fast: null, running: true, fastRunning: true });
        try {
            await initMachine();
            const loaded = await client.debugLoad(code, { fast: true });
            const result = loaded ? await client.debugStep(0, "free") : "error"; // an unreadable program was reported
            await refresh();
            if (result === "paused") return;
            const ok = result === "done";
            const lastError = [...state.output].reverse().find((o) => o.stream === "stderr");
            const line = Number(/:(\d+) /.exec(lastError?.text ?? "")?.[1] ?? 0);
            const exited = state.machine.exitCode >= 0;
            set({ fast: { ok, line }, status: exited ? "exit" : ok ? "done" : "error" });
        } finally {
            set({ fastRunning: false });
        }
    })),
    /** Pauses a running program after the current chunk; a fast run is stopped by replacing the machine. */
    stop() {
        stopRequested = true;
        if (state.fastRunning) return actions.kill("stopped: the machine was restarted");
    },
    /** Empties the default stack and the program's stacks (library stacks it changed are restored), and hides the stacks. */
    clearStacks: () => enqueue(() => observed("clearStacks", {}, async () => {
        await client.clearStacks();
        await refresh();
        set({ stacksShown: false });
    })),
    /** Drops the loaded program; the stacks stay as they are. */
    abort: () => interrupting(() => observed("abort", {}, async () => {
        await client.debugAbort();
        await refresh();
    })),
    /**
     * Evaluates `code` on the current machine. A paused program stays paused where it is, and the
     * code runs at that point; it may resume the program (the words step, next, continue and stop).
     * Otherwise the code is a program of its own, and a breakpoint (`@`) in it pauses it. If the code
     * calls `exit`, everything is emptied as by `clearStacks` and the output is cleared, and the exit
     * status is returned (otherwise null).
     */
    evaluate: (code) => enqueue(async () => {
        set({ output: [], echo: code, source: "prompt" });
        if (!state.ready) await initMachine();
        const info = { code };
        await observed("evaluate", info, async () => {
            if (ACTIVE.has(state.status)) {
                info.ok = await client.eval(code);
                await client.debugResume();
            } else {
                const loaded = await client.debugLoad(code, { scratch: true });
                const result = loaded ? await client.debugStep(0, "free") : "error";
                info.ok = result === "done" || result === "paused";
                if (result === "paused") set({ pausedAtPrompt: true });
            }
            await refresh();
        });
        const status = state.machine.exitCode;
        if (status < 0) return null;
        await client.clearStacks();
        await refresh();
        set({ output: [], echo: "", stacksShown: false });
        return status;
    }),
    /** Replaces the machine with a new one, keeping the loaded files and input. */
    reset: () => interrupting(() => observed("reset", {}, async () => {
        set({ output: [] });
        await initMachine();
        await refresh();
    })),
    /** Starts a fresh machine and evaluates setup code without echoing it as prompt input. */
    setup: (code) => interrupting(() => observed("setup", { code }, async () => {
        set({ output: [], echo: "", source: "program", fast: null });
        await initMachine();
        const ok = await client.eval(code);
        await refresh();
        if (!ok) throw new Error("setup failed");
    })),
    /** Replaces the machine's worker, e.g. when a program got stuck inside a nested run. */
    kill(reason = "machine restarted") {
        return observed("kill", { reason }, () => {
            client.terminate();
            client = createClient(onOutput);
            stopRequested = true;
            queue = Promise.resolve();
            set({ busy: false, running: false, fastRunning: false, ready: false, status: "idle", machine: null, fast: null, error: reason });
            return actions.start().then(() => set({ error: reason }));
        });
    },
    setMode: (mode) => set({ mode }),
    setFastRun: (fastRun) => set({ fastRun }),
    setHiddenStacks: (hiddenStacks) => set({ hiddenStacks: [...new Set(hiddenStacks)] }),
    setHiddenStackPrefixes: (hiddenStackPrefixes) => set({ hiddenStackPrefixes: [...new Set(hiddenStackPrefixes)] }),
    setPuzzleGoal: (puzzleGoal) => set({ puzzleGoal }),
    setPuzzleDescription: (puzzleDescription) => set({ puzzleDescription }),
    setPuzzleHints: (puzzleHints, puzzleFreeHints = 0) => set({ puzzleHints, puzzleFreeHints }),
    setPuzzleTitle: (puzzleTitle) => set({ puzzleTitle }),
    setInput(text) {
        set({ input: text });
        return enqueue(() => client.setInput(text));
    },
    setFiles: (newFiles) => set({ files: newFiles }),
    /** Clears everything under the prompt: the echoed line and the output. */
    clearOutput: () => set({ output: [], echo: "", source: "prompt" }),
    setLibraryOpen: (open) => enqueue(async () => {
        set({ library: { ...state.library, open } });
        if (open && state.ready) await refreshLibrary();
    }),
    setLibraryFilter: (filter) => enqueue(async () => {
        set({ library: { ...state.library, filter } });
        if (state.library.open && state.ready) await refreshLibrary();
    }),
    /** Shows or hides one stack's items in the library list. */
    toggleStackDetails: (name) => enqueue(async () => {
        const details = { ...state.library.details };
        if (name in details) delete details[name];
        else details[name] = await client.stack(name, DETAIL_OPTIONS);
        set({ library: { ...state.library, details } });
    }),
    };

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        actions,
    };
}
