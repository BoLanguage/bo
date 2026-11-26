// Integration test of the recorder: the playground's store and machine on one side, a real
// Playground+ server and database on the other.
// Usage: node playground-plus/test_recorder.mjs   (after `make wasm`)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalClient } from "../playground/client.mjs";
import { createStore } from "../playground/store.mjs";
import { createApi } from "./client/api.mjs";
import { PAST_NOTE, REVEAL_NOTE, createPlusPuzzleProvider } from "./client/provider.mjs";
import { createRecorder, puzzleState, toRecord, visibleStacks } from "./client/recorder.mjs";
import { startServer } from "./server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const puzzleDir = join(root, "examples", "puzzles");
const read = (file) => readFileSync(join(puzzleDir, file), "utf8");
const library = read("lib.bo");
const orderThree = read("07-order-three.bo");
const orderFour = read("08-order-four.bo");
const answer = read("01-answer-stack.bo");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const running = await startServer();
const { repository } = running;
const api = createApi(running.url);
for (const [id, source] of [["p3", orderThree], ["p4", orderFour], ["p1", answer]])
    repository.addPuzzle({ id, title: id, goal: "g", source, package: {} });

/** A store wired to a recorder, as boot.mjs wires the page. */
const play = async ({ api: target = api, onError } = {}) => {
    const errors = [];
    const recorder = createRecorder({ api: target, onError: onError ?? ((error) => errors.push(error)) });
    recorder.setPuzzles([{ id: "p3", source: orderThree }, { id: "p4", source: orderFour }, { id: "p1", source: answer }]);
    const store = createStore((out) => createLocalClient(out), { files: { "examples/puzzles/lib.bo": library }, onEvent: recorder.onEvent });
    await store.actions.start();
    return { actions: store.actions, state: store.getState, recorder, errors };
};

test("a solved puzzle is one session of prompt events with its play state, ending as solved", async () => {
    const { actions, recorder, errors } = await play();
    await actions.setup(orderThree);
    await actions.evaluate("hint");
    await actions.evaluate("guess");
    await actions.evaluate("rot guess");
    await recorder.idle();
    assert.deepEqual(errors, []);
    const session = findSession("p3", "solved");
    const events = repository.listEvents(session.id);
    assert.deepEqual(events.map((e) => [e.seq, e.type, e.code]), [[1, "setup", null], [2, "evaluate", "hint"], [3, "evaluate", "guess"], [4, "evaluate", "rot guess"]]);
    assert.match(session.bo_version, /^\d+\.\d+/);
    assert.equal(session.client, "playground-plus-page");
    assert.ok(session.ended_at >= session.started_at);
    assert.deepEqual(events[0].puzzle_state, { guesses: 0, last: null, hints: 0, revealed: false });
    assert.deepEqual(events[2].puzzle_state, { guesses: 1, last: 1, hints: 1, revealed: false });
    assert.deepEqual(events[3].puzzle_state, { guesses: 2, last: 2, hints: 1, revealed: false });
    // the initial state is the setup's, without the puzzle's own stacks
    assert.deepEqual(events[0].stack_after.map((s) => s.name), [""]);
    assert.deepEqual(events[0].stack_after[0].items.map((i) => i[1]), ["3", "1", "2"]);
    assert.ok(events[2].stack_before && events[2].stack_after);
    for (const event of events) for (const stacks of [event.stack_before, event.stack_after])
        assert.ok((stacks ?? []).every((s) => s.name === "" || !s.name.startsWith("puzzle.")), "no hidden stacks");
});

test("wrong guesses are counted without ending the session; reveal followed by a solve is 'revealed'", async () => {
    const { actions, recorder } = await play();
    await actions.setup(orderFour);
    await actions.evaluate("guess");
    await actions.evaluate("reveal");
    await actions.evaluate("swap rot guess");
    await recorder.idle();
    const session = findSession("p4", "revealed");
    const states = repository.listEvents(session.id).map((e) => e.puzzle_state);
    assert.deepEqual(states.map((s) => s.guesses), [0, 1, 1, 2]);
    assert.deepEqual(states.map((s) => s.last), [null, 1, 1, 2]);
    assert.equal(states[2].revealed, true);
});

test("starting another puzzle skips the open one; an editor run ends it as abandoned without recording anything of it", async () => {
    const { actions, recorder } = await play();
    await actions.setup(answer);
    await actions.evaluate("42 (ANSWER) PUSH");
    await actions.setup(orderThree);
    await recorder.idle();
    const skipped = findSession("p1", "skipped");
    const events = repository.listEvents(skipped.id);
    assert.deepEqual(events.map((e) => e.type), ["setup", "evaluate"]);
    assert.equal(events[0].code, null, "the puzzle's own source is not stored per event");
    assert.ok(events[1].stack_after.some((s) => s.name === "ANSWER"), "a stack the player made is visible");
    // the second puzzle's session is open and holds just its setup
    assert.equal(openSessionOf("p3").outcome, null);

    await actions.setup(answer);
    await actions.evaluate("7 (ANSWER) PUSH");
    await actions.run('"secret program\\n" emits 99'); // from the editor: replaces the machine
    await recorder.idle();
    const abandoned = repository.listSessions("p1").at(-1);
    assert.equal(abandoned.outcome, "abandoned");
    const kept = repository.listEvents(abandoned.id);
    assert.deepEqual(kept.map((e) => e.type), ["setup", "evaluate"], "no editor event is stored");
    assert.doesNotMatch(JSON.stringify(kept), /secret program/);
});

test("an editor event is never stored, even if it is the one that leaves the puzzle solved", async () => {
    const calls = [];
    const fake = {
        createSession: async () => (calls.push("create"), { id: "s1" }),
        addEvents: async (id, events) => calls.push(["add", events.map((e) => e.type)]),
        endSession: async (id, outcome) => calls.push(["end", outcome]),
    };
    const recorder = createRecorder({ api: fake });
    recorder.setPuzzles([{ id: "x", source: "SETUP" }]);
    const machine = (last) => ({ stacks: [{ name: "", depth: 0, items: [] }, ...(last ? [{ name: "puzzle.last", depth: 1, items: [["n", String(last)]] }] : [])] });
    recorder.onEvent({ type: "setup", code: "SETUP", time: 1, duration: 1, version: "0.7.0", after: machine(null) });
    recorder.onEvent({ type: "run", code: "secret", time: 2, duration: 1, before: machine(null), after: machine(2), output: [] });
    await recorder.idle();
    assert.deepEqual(calls, ["create", ["add", ["setup"]], ["end", "solved"]]);
});

test("stored puzzles come first and say what opening the editor means; practice puzzles are left alone", async () => {
    repository.addPuzzle({ id: "described", title: "D", goal: "g", description: "Hello.", source: "S", package: {} });
    const practice = { load: async () => ({ files: { "a.bo": "1" }, puzzles: [{ id: "01.bo", title: "P", description: "plain", source: "x", hiddenStacks: [] }] }) };
    const loaded = await createPlusPuzzleProvider({ practice, api }).load();
    assert.deepEqual(loaded.files, { "a.bo": "1" });
    const byId = Object.fromEntries(loaded.puzzles.map((p) => [p.id, p]));
    assert.equal(byId.described.description, `Hello.\n\n${REVEAL_NOTE}`);
    assert.deepEqual([byId.described.recorded, byId.described.played, byId["01.bo"].recorded], [true, false, false]);
    // p3 was played in the tests above: it is a past puzzle, practice from now on
    assert.equal(byId.p3.played, true);
    assert.deepEqual([byId.p3.recorded, byId.p3.description], [false, PAST_NOTE]);
    assert.equal(byId.p3.freeHints, 0, "a source that is not a puzzle file has no free hints");
    repository.addPuzzle({ id: "free", title: "F", goal: "g", hints: 3, source: ";@puzzle\n;@title F\n;@goal g\n;@hints 3\n;@freehints 2\n;@end\n", package: {} });
    const again = await createPlusPuzzleProvider({ practice, api }).load();
    assert.equal(again.puzzles.find((p) => p.id === "free").freeHints, 2, "the header's free hints reach the page");
    assert.equal(byId["01.bo"].description, "plain");
    assert.equal(loaded.puzzles.at(-1).id, "01.bo", "practice puzzles come last");
    const warnings = [];
    const offline = await createPlusPuzzleProvider({ practice, api: createApi("http://127.0.0.1:9"), onError: (m) => warnings.push(m) }).load();
    assert.deepEqual(offline.puzzles.map((p) => p.id), ["01.bo"]);
    assert.equal(warnings.length, 1);
});

test("emptying everything ends the session as abandoned, and puzzles that are not recorded make no session", async () => {
    const { actions, recorder } = await play();
    await actions.setup(orderThree);
    await actions.evaluate("rot");
    await actions.reset();
    await actions.evaluate("rot guess");
    await actions.setup("1 2 +");
    await actions.evaluate("3 4 +");
    await recorder.idle();
    const session = findSession("p3", "abandoned", (events) => events.some((e) => e.type === "reset"));
    assert.deepEqual(repository.listEvents(session.id).map((e) => e.type), ["setup", "evaluate", "reset"]);
});

test("opening the editor during a puzzle ends the session as revealed, and only then", async () => {
    const { actions, recorder } = await play();
    assert.equal(recorder.hasOpenSession(), false, "nothing is open before a puzzle");
    assert.equal(recorder.revealSource(), false);
    await actions.setup("1 2 +"); // a puzzle that is not recorded
    assert.equal(recorder.hasOpenSession(), false);
    await actions.setup(orderFour);
    await actions.evaluate("swap");
    assert.equal(recorder.hasOpenSession(), true);
    assert.equal(recorder.revealSource(), true);
    assert.equal(recorder.hasOpenSession(), false);
    assert.equal(recorder.revealSource(), false, "it counts once");
    await actions.evaluate("rot guess"); // later play is not recorded
    await recorder.idle();
    const session = findSession("p4", "revealed", (events) => events.some((e) => e.type === "reveal"));
    const events = repository.listEvents(session.id);
    assert.deepEqual(events.map((e) => e.type), ["setup", "evaluate", "reveal"]);
    assert.equal(events[2].puzzle_state.revealed, true);
    assert.equal(events[2].code, null);
});

test("a solved or skipped puzzle no longer asks about the editor", async () => {
    const { actions, recorder } = await play();
    await actions.setup(orderThree);
    await actions.evaluate("rot guess");
    assert.equal(recorder.hasOpenSession(), false, "solved");
    await actions.setup(orderFour);
    assert.equal(recorder.hasOpenSession(), true);
    await actions.reset();
    assert.equal(recorder.hasOpenSession(), false, "reset");
    await recorder.idle();
});

test("a puzzle stored after the page loaded is announced once, with the editor note", async () => {
    const stored = [{ id: "a", title: "A", description: "", source: "s" }];
    let trigger;
    const api = { listPuzzles: async () => stored, onNewPuzzle: (callback) => ((trigger = callback), () => {}) };
    const practice = { load: async () => ({ files: {}, puzzles: [] }) };
    const provider = createPlusPuzzleProvider({ practice, api });
    assert.deepEqual((await provider.load()).puzzles.map((p) => p.id), ["a"]);
    const announced = [];
    provider.subscribe((puzzle) => announced.push(puzzle));
    await trigger();
    assert.deepEqual(announced, [], "nothing is new yet");
    stored.push({ id: "b", title: "B", description: "Hello.", source: "s2" });
    await trigger();
    await trigger();
    assert.deepEqual(announced.map((p) => p.id), ["b"], "announced once");
    assert.equal(announced[0].description, `Hello.\n\n${REVEAL_NOTE}`);
    assert.equal(announced[0].recorded, true);
});

test("the recorder reports when a recorded puzzle starts and stops being played", async () => {
    const changes = [];
    const started = [];
    const recorder = createRecorder({
        api: { createSession: async () => ({ id: "s" }), addEvents: async () => {}, endSession: async () => {} },
        onOpenChange: (open) => changes.push(open), onStart: (puzzle) => started.push(puzzle.id),
    });
    recorder.setPuzzles([{ id: "x", source: "SETUP" }]);
    const machine = (last) => ({ stacks: [{ name: "", depth: 0, items: [] }, ...(last ? [{ name: "puzzle.last", depth: 1, items: [["n", String(last)]] }] : [])] });
    const event = (type, extra = {}) => ({ type, time: 1, duration: 1, version: "0.7.0", after: machine(null), ...extra });
    recorder.onEvent(event("setup", { code: "SETUP" }));
    recorder.onEvent(event("evaluate", { code: "x", ok: true }));
    recorder.onEvent(event("evaluate", { code: "guess", ok: true, after: machine(2) }));
    assert.deepEqual(changes, [true, false], "opened by the setup, closed by the solving guess");
    recorder.onEvent(event("setup", { code: "SETUP" }));
    recorder.revealSource();
    recorder.onEvent(event("setup", { code: "SETUP" }));
    recorder.onEvent(event("reset"));
    recorder.onEvent(event("setup", { code: "not a recorded puzzle" }));
    assert.deepEqual(changes, [true, false, true, false, true, false], "also closed by a reveal and by a reset; others change nothing");
    assert.deepEqual(started, ["x", "x", "x"], "told at each start of a recorded puzzle, and not for others");
    await recorder.idle();
});

test("every way of losing the puzzle ends the session as abandoned, and harmless actions do not", async () => {
    const losing = {
        "exit at the prompt (the page then starts fresh)": async (a) => { await a.evaluate("exit"); await a.reset(); },
        "Reset everything (reset)": (a) => a.reset(),
        "a step with F10 (a fresh machine)": (a) => a.step("1 2 +"),
        "a run from the editor": (a) => a.run("1 2 +"),
        "a fast run": (a) => a.runFast("1 2 +"),
        "a restart from the editor": (a) => a.restart("1 2 +"),
        "the machine being killed": (a) => a.kill(),
        "emptying the program's stacks": (a) => a.clearStacks(),
        "wiping the puzzle's own stacks": (a) => a.evaluate("(puzzle.validator) CLEAR"),
    };
    for (const [what, act] of Object.entries(losing)) {
        const { actions, recorder } = await play();
        await actions.setup(orderThree);
        await actions.evaluate("hint");
        assert.equal(recorder.hasOpenSession(), true, what);
        await act(actions);
        assert.equal(recorder.hasOpenSession(), false, what);
        await recorder.idle();
        const session = repository.listSessions("p3").at(-1);
        assert.equal(session.outcome, "abandoned", what);
        const types = repository.listEvents(session.id).map((e) => e.type);
        assert.ok(!types.some((t) => ["step", "run", "runFast", "restart", "kill", "clearStacks"].includes(t)), `${what}: editor and machine events are not stored`);
    }
    const harmless = {
        "the Bo word clear": (a) => a.evaluate("clear"),
        "emptying one stack (its icon)": (a) => a.evaluate("() CLEAR"),
        "abort in the debugger": (a) => a.abort(),
        "a wrong guess": (a) => a.evaluate("guess"),
        "an error": (a) => a.evaluate("1 0 /"),
        "an unknown word": (a) => a.evaluate("no-such-word"),
    };
    for (const [what, act] of Object.entries(harmless)) {
        const { actions, recorder } = await play();
        await actions.setup(orderThree);
        await act(actions);
        assert.equal(recorder.hasOpenSession(), true, what);
        await actions.evaluate("clear 1 2 3 guess"); // solves from any state, so each case ends cleanly
        await recorder.idle();
        assert.equal(repository.listSessions("p3").at(-1).outcome, "solved", `${what}: the puzzle can still be solved`);
    }
});

test("a failing server never disturbs the player, and the failure is reported", async () => {
    const down = createApi("http://127.0.0.1:9"); // nothing listens there
    const { actions, recorder, errors, state } = await play({ api: down });
    await actions.setup(orderThree);
    await actions.evaluate("rot guess");
    await recorder.idle();
    assert.equal(state().error, null);
    assert.equal(state().machine.stacks[0].depth, 3);
    assert.ok(errors.length >= 1);
});

test("the pieces: play state, visible stacks and records", () => {
    const machine = {
        stacks: [
            { name: "", depth: 2, items: [["n", "1"], ["n", "2"]] },
            { name: "puzzle.last", depth: 2, items: [["n", "1"], ["n", "3"]] },
            { name: "puzzle.hint-used", depth: 1, items: [["n", "1"]] },
            { name: "guess", depth: 1, items: [["l", "(...)"]] },
            { name: "mine", depth: 1, items: [["n", "5"]] },
        ],
    };
    assert.deepEqual(puzzleState(machine), { guesses: 2, last: 3, hints: 1, revealed: false });
    assert.deepEqual(puzzleState(null), { guesses: 0, last: null, hints: 0, revealed: false });
    assert.deepEqual(visibleStacks(machine, new Set(["guess"])).map((s) => s.name), ["", "mine"]);
    assert.equal(visibleStacks(null, new Set()), null);
    const record = toRecord({ type: "evaluate", time: 5, duration: 1, code: "x", ok: true, output: [{ stream: "stdout", text: "y".repeat(5000) }], before: machine, after: machine }, new Set(["guess"]));
    assert.equal(record.output[0].text.length, 4000);
    assert.deepEqual(toRecord({ type: "abort", time: 5, duration: 1, before: machine, after: machine }, new Set()), {
        type: "abort", time: 5, duration: 1, error: null, puzzleState: { guesses: 2, last: 3, hints: 1, revealed: false },
    });
});

function findSession(puzzleId, outcome, accept = () => true) {
    const found = repository.listSessions(puzzleId).filter((s) => s.outcome === outcome && accept(repository.listEvents(s.id)));
    assert.ok(found.length >= 1, `no ${outcome} session for ${puzzleId}`);
    return found.at(-1);
}
function openSessionOf(puzzleId) {
    return repository.listSessions(puzzleId).filter((s) => s.outcome === null).at(-1);
}
let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`FAIL ${name}\n${error.stack.split("\n").slice(0, 6).join("\n")}`);
    }
}
await running.close();
process.exit(failed ? 1 : 0);
