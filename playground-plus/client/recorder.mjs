// Turns the playground's store events (see `onEvent` in playground/store.mjs) into recorded puzzle
// sessions on the server. This module has no DOM and no storage of its own, so it runs in Node tests.
//
// What is recorded, by design: the prompt lines the player typed (`evaluate` events), their
// result, the visible stacks before and after, and the play state the puzzle runtime keeps on
// hidden stacks (guesses, hints, reveal), plus when a puzzle starts and when the machine is reset.
// What is not: anything done in the editor (its contents, runs, steps and output; such an event
// is not stored, although it can still end the session if the puzzle ends up solved), and the
// puzzle's own stacks, which hold its solution and messages.
const HIDDEN_PREFIX = "puzzle.";
const OUTPUT_LIMIT = 4000; // characters kept of a prompt line's output
const RECORDED = new Set(["setup", "evaluate", "reset"]);

/** The play state the puzzle runtime (examples/puzzles/lib.bo) keeps on hidden stacks. */
export function puzzleState(machine) {
    const find = (name) => machine?.stacks.find((stack) => stack.name === name);
    const guesses = find("puzzle.last");
    const lastGuess = guesses?.items?.at(-1);
    return {
        guesses: guesses?.depth ?? 0,
        last: lastGuess ? Number(lastGuess[1]) : null, // 0 missing, 1 wrong, 2 solved, 3 error
        hints: find("puzzle.hint-used")?.depth ?? 0,
        revealed: Boolean(find("puzzle.revealed")),
    };
}

/** True while the machine still holds the puzzle: the setup's `puzzle.require` leaves `puzzle.validator`. */
export function hasPuzzleRuntime(machine) {
    return Boolean(machine?.stacks.some((stack) => stack.name === "puzzle.validator"));
}

/** The default stack and the stacks the player made, without anything the puzzle itself set up. */
export function visibleStacks(machine, own) {
    if (!machine) return null;
    return machine.stacks
        .filter(({ name }) => name === "" || (!name.startsWith(HIDDEN_PREFIX) && !own.has(name)))
        .map(({ name, depth, items }) => ({ name, depth, items }));
}

const trimOutput = (output = []) => {
    const kept = [];
    let room = OUTPUT_LIMIT;
    for (const { stream, text } of output) {
        if (room <= 0) break;
        kept.push({ stream, text: text.slice(0, room) });
        room -= text.length;
    }
    return kept;
};

/** The server's form of an event; `own` holds the names of the stacks the puzzle's setup made. */
export function toRecord(event, own) {
    const record = { type: event.type, time: event.time, duration: event.duration, error: event.error ?? null, puzzleState: puzzleState(event.after) };
    if (event.type === "evaluate") {
        Object.assign(record, {
            code: event.code, ok: event.ok, output: trimOutput(event.output),
            stackBefore: visibleStacks(event.before, own), stackAfter: visibleStacks(event.after, own),
        });
    } else if (event.type === "setup") record.stackAfter = visibleStacks(event.after, own);
    return record;
}

/**
 * @param {{api: ReturnType<import("./api.mjs").createApi>, client?: string, onError?: Function, onOpenChange?: (open: boolean) => void,
 *   onStart?: (puzzle: object) => void}} options
 *   `api` is where sessions are stored; recording failures go to `onError` and never reach the player;
 *   `onOpenChange` is told when a recorded puzzle starts or ends being played; `onStart` when a recorded
 *   puzzle is started (its first play: afterwards it counts as played)
 * @returns {{setPuzzles: Function, onEvent: Function, hasOpenSession: Function, revealSource: Function, idle: () => Promise<void>}}
 */
export function createRecorder({ api, client = "playground-plus-page", onError = console.error, onOpenChange = () => {}, onStart = () => {} }) {
    let bySource = new Map();
    let current = null; // {id, puzzle, own, ended}
    let queue = Promise.resolve();
    let wasOpen = false;

    const enqueue = (task) => {
        queue = queue.then(task).catch(onError);
    };
    const notify = () => {
        const open = Boolean(current && !current.ended);
        if (open === wasOpen) return;
        wasOpen = open;
        onOpenChange(open);
    };
    const finish = (session, outcome) => {
        if (session.ended) return;
        session.ended = true;
        enqueue(async () => session.id && api.endSession(session.id, outcome));
    };
    const add = (session, record) => enqueue(async () => session.id && api.addEvents(session.id, [record]));

    function handle(event) {
        if (event.type === "setup") {
            if (current) finish(current, "skipped"); // another puzzle was started
            current = null;
            const puzzle = bySource.get(event.code);
            if (!puzzle) return;
            const own = new Set((event.after?.stacks ?? []).map(({ name }) => name).filter((name) => name !== ""));
            const session = { id: null, puzzle, own, ended: false, state: puzzleState(event.after) };
            current = session;
            onStart(puzzle);
            enqueue(async () => {
                session.id = (await api.createSession({ puzzleId: puzzle.id, client, boVersion: event.version })).id;
                await api.addEvents(session.id, [toRecord(event, own)]);
            });
            return;
        }
        const session = current;
        if (!session || session.ended) return;
        const record = toRecord(event, session.own);
        session.state = record.puzzleState;
        if (RECORDED.has(event.type)) add(session, record);
        if (record.puzzleState.last === 2) finish(session, record.puzzleState.revealed ? "revealed" : "solved");
        else if (!hasPuzzleRuntime(event.after)) finish(session, "abandoned"); // reset, kill, or a program that replaced the machine
    }

    return {
        /** Sets the puzzles whose play is recorded (those with an `id` and the `source` their setup runs). */
        setPuzzles(puzzles) {
            bySource = new Map(puzzles.map((puzzle) => [puzzle.source, puzzle]));
        },

        onEvent(event) {
            handle(event);
            notify();
        },

        /** True while a recorded puzzle is being played (not yet solved, revealed, abandoned or skipped). */
        hasOpenSession: () => Boolean(current && !current.ended),

        /**
         * The player chose to see the puzzle's source (by opening the editor or sharing its program),
         * which gives the solution away: the session ends as revealed. Returns false if none was open.
         */
        revealSource(now = Date.now()) {
            const session = current;
            if (!session || session.ended) return false;
            add(session, { type: "reveal", time: now, duration: 0, error: null, puzzleState: { ...session.state, revealed: true } });
            finish(session, "revealed");
            notify();
            return true;
        },

        /** Resolves when everything recorded so far has been sent (for tests). */
        idle: () => queue,
    };
}
