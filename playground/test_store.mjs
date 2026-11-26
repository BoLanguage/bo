// Tests for the playground store, driven through the in-process client (no browser).
// Usage: node playground/test_store.mjs   (after `make -C c wasm`)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalClient } from "./client.mjs";
import { EXAMPLES, SUPPORT_FILES } from "./examples.mjs";
import { PUZZLE_FILES, PUZZLE_SUPPORT_FILES, parsePuzzle } from "./puzzles.mjs";
import { createStore } from "./store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const create = async (options = {}) => {
    let clients = 0;
    const store = createStore((onOutput) => (clients++, createLocalClient(onOutput)), options);
    await store.actions.start();
    return { store, actions: store.actions, state: store.getState, clients: () => clients };
};
const top = (state) => state().machine.stacks[0].items.map((i) => i[1]);

test("start creates the machine and reports its version", async () => {
    const { state } = await create();
    assert.equal(state().ready, true);
    assert.match(state().version, /^\d+\.\d+/);
    assert.equal(state().status, "idle");
    assert.equal(state().machine.counts.library, 219);
});

test("step on an idle machine loads the program paused before its first word", async () => {
    const { actions, state } = await create();
    await actions.step("1 2 +");
    assert.equal(state().status, "paused");
    assert.equal(state().machine.next.word, "+");
    assert.deepEqual(top(state), ["1", "2"]);
    await actions.step("1 2 +");
    assert.equal(state().machine.next.word, "ADD");
    assert.equal(state().previous.next.word, "+", "the previous state is kept to mark changes");
});

test("run finishes a program and collects output in order", async () => {
    const { actions, state } = await create();
    await actions.run('"a\\n" emits 3 emit "\\nb\\n" emits');
    assert.equal(state().status, "done");
    assert.equal(state().output.map((o) => o.text).join(""), "a\n3\nb\n");
    assert.equal(state().running, false);
});

test("errors end the program and keep the failing line", async () => {
    const { actions, state } = await create();
    await actions.run("1\n2\n1 0 /\n4");
    assert.equal(state().status, "error");
    assert.equal(state().machine.line, 3);
    assert.match(state().output.at(-1).text, /\(DIV\)/);
    assert.equal(state().output.at(-1).stream, "stderr");
});

test("an endless program can be stopped between chunks and then stepped", async () => {
    const { actions, state } = await create({ chunk: 500 });
    const running = actions.run("(1) (nop) loop");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state().running, true);
    actions.stop();
    await running;
    assert.equal(state().status, "paused");
    assert.ok(state().machine.steps >= 500);
    await actions.step("ignored", 3);
    assert.equal(state().status, "paused");
});

test("restart resets the machine and the output", async () => {
    const { actions, state } = await create();
    await actions.run('"x\\n" emits (1) (A) PUSH');
    assert.ok(state().machine.stacks.some((s) => s.name === "A"));
    await actions.restart("1 2 +");
    assert.equal(state().output.length, 0);
    assert.equal(state().status, "paused");
    assert.equal(state().machine.stacks.some((s) => s.name === "A"), false);
});

test("setup runs source on a fresh machine without echoing it", async () => {
    const { actions, state } = await create();
    await actions.evaluate("1 2");
    await actions.setup("(3 *) (triple) PUSH");
    assert.equal(state().echo, "");
    assert.deepEqual(top(state), []);
    await actions.evaluate("7 triple");
    assert.deepEqual(top(state), ["21"]);
});

test("hidden stack names are kept in application state", async () => {
    const { actions, state } = await create();
    actions.setHiddenStacks(["puzzle.solution", "puzzle.solution"]);
    assert.deepEqual(state().hiddenStacks, ["puzzle.solution"]);
    actions.setPuzzleGoal("Store a value.");
    assert.equal(state().puzzleGoal, "Store a value.");
    actions.setPuzzleDescription("A short explanation.");
    assert.equal(state().puzzleDescription, "A short explanation.");
    actions.setPuzzleHints(2);
    actions.setPuzzleTitle("A puzzle");
    assert.equal(state().puzzleHints, 2);
    assert.equal(state().puzzleTitle, "A puzzle");
});

test("the prompt evaluates on the current machine, also while a program is paused", async () => {
    const { actions, state } = await create();
    await actions.evaluate("(3 *) (triple) PUSH 5 triple");
    assert.deepEqual(top(state), ["15"]);
    assert.equal(state().echo, "(3 *) (triple) PUSH 5 triple");
    assert.equal(state().source, "prompt");
    await actions.step("1 2 +\n100"); // starting a program replaces the machine
    assert.equal(state().source, "program");
    assert.deepEqual(top(state), ["1", "2"]);
    await actions.evaluate("(3 *) (triple) PUSH 7 triple");
    assert.equal(state().error, null);
    assert.equal(state().status, "paused", "the program stays paused");
    assert.equal(state().machine.next.word, "+");
    assert.deepEqual(top(state), ["1", "2", "21"]);
    await actions.run("");
    assert.equal(state().status, "done");
    assert.deepEqual(top(state), ["1", "23", "100"]);
});

test("Run stops at a breakpoint, then goes on from there", async () => {
    const { actions, state } = await create();
    await actions.run("1 @ 2");
    assert.equal(state().status, "paused");
    assert.equal(state().machine.breakpoint, true);
    assert.deepEqual(top(state), ["1"]);
    assert.equal(state().pausedAtPrompt, false);
    await actions.run("");
    assert.equal(state().status, "done");
    assert.deepEqual(top(state), ["1", "2"]);
});

test("a fast run also stops at a breakpoint, and Step goes on one word at a time", async () => {
    const { actions, state } = await create();
    await actions.runFast("1 @ 2 3 +");
    assert.equal(state().status, "paused");
    assert.equal(state().fast, null);
    assert.deepEqual(top(state), ["1"]);
    await actions.step("", 1); // the word after the breakpoint is +, after the literals 2 and 3
    assert.equal(state().status, "paused");
    assert.equal(state().machine.breakpoint, false);
    await actions.run("");
    assert.equal(state().status, "done");
    assert.deepEqual(top(state), ["1", "5"]);
});

test("a breakpoint at the prompt pauses the line; what follows runs there, and the words resume it", async () => {
    const { actions, state } = await create();
    await actions.evaluate("1 @ 2");
    assert.equal(state().status, "paused");
    assert.equal(state().pausedAtPrompt, true);
    assert.equal(state().source, "prompt");
    assert.deepEqual(top(state), ["1"]);
    await actions.evaluate("10 +");
    assert.equal(state().status, "paused", "still paused");
    assert.deepEqual(top(state), ["11"]);
    await actions.evaluate("step");
    assert.equal(state().status, "idle", "the line is over: the status is what it was before");
    assert.equal(state().pausedAtPrompt, false);
    assert.deepEqual(top(state), ["11", "2"]);
    await actions.evaluate("3 @ 4");
    await actions.evaluate("continue");
    assert.deepEqual(top(state), ["11", "2", "3", "4"]);
    await actions.evaluate("5 @ 6");
    await actions.evaluate("stop");
    assert.equal(state().status, "idle");
    assert.deepEqual(top(state), ["11", "2", "3", "4", "5"]);
});

test("a prompt line that ends does not replace the status of the program that ran before", async () => {
    const { actions, state } = await create();
    await actions.runFast("1\n1 0 /");
    assert.equal(state().status, "error");
    await actions.evaluate("2 3 +");
    assert.equal(state().status, "error");
    await actions.evaluate("1 0 /");
    assert.equal(state().status, "error");
    assert.equal(state().machine.steps, 0);
});

test("step and its words are errors at the prompt when nothing is paused", async () => {
    const { actions, state } = await create();
    await actions.evaluate("step");
    assert.match(state().output.map((o) => o.text).join(""), /Debug-Error \(STEP\)/);
    assert.equal(state().status, "idle");
});

test("each prompt evaluation replaces the output of the previous one", async () => {
    const { actions, state } = await create();
    await actions.evaluate('"one\\n" emits');
    assert.equal(state().output.map((o) => o.text).join(""), "one\n");
    await actions.evaluate('"two\\n" emits');
    assert.equal(state().output.map((o) => o.text).join(""), "two\n");
    await actions.evaluate("1 0 /");
    assert.equal(state().output.length, 1);
    assert.equal(state().output[0].stream, "stderr");
});

test("clearStacks empties the stacks without resetting the machine or the loaded program", async () => {
    const { actions, state } = await create();
    await actions.evaluate("(2 *) (twice) PUSH (7) (L) PUSH 1 2 3");
    assert.deepEqual(state().machine.stacks.map((s) => s.name), ["", "L", "twice"]);
    await actions.clearStacks();
    assert.deepEqual(state().machine.stacks.map((s) => s.name), [""]);
    assert.deepEqual(top(state), []);
    await actions.step("1 2 +\n9");
    await actions.evaluate("5");
    await actions.clearStacks();
    assert.equal(state().status, "paused", "the program stays loaded");
    assert.deepEqual(top(state), []);
    await actions.evaluate("3 4"); // the pending + needs operands again
    await actions.run("");
    assert.equal(state().status, "done");
    assert.deepEqual(top(state), ["7", "9"]);
});

test("the stacks stay shown once something was on them, until a fresh machine or clearStacks", async () => {
    const { actions, state } = await create();
    assert.equal(state().stacksShown, false);
    await actions.evaluate("1");
    assert.equal(state().stacksShown, true);
    await actions.evaluate("drop");
    assert.deepEqual(top(state), []);
    assert.equal(state().stacksShown, true, "an emptied default stack stays visible");
    await actions.evaluate("1");
    await actions.clearStacks();
    assert.equal(state().stacksShown, false);
    await actions.evaluate("2");
    await actions.reset();
    assert.equal(state().stacksShown, false);
});

test("modes decide what one step is", async () => {
    const { actions, state } = await create();
    actions.setMode("lines");
    await actions.step("(1 +) (inc) PUSH\n5 inc inc\n7");
    assert.equal(state().machine.line, 1);
    await actions.step("");
    assert.equal(state().machine.line, 2);
    await actions.step("");
    assert.equal(state().status, "done");
    assert.deepEqual(top(state), ["7", "7"]);
});

test('the mode "word, over calls" runs what a word calls without stopping in it', async () => {
    const program = "(1 +) (inc) PUSH\n5 inc inc\n7";
    const { actions, state } = await create();
    await actions.step(program);
    await actions.step(""); // PUSH runs; the literal 5 is not a step
    assert.equal(state().machine.next.word, "inc");
    await actions.step("");
    assert.equal(state().machine.next.word, "+", "by words, a step goes into the call");
    const over = await create();
    over.actions.setMode("over");
    await over.actions.step(program);
    await over.actions.step("");
    assert.equal(over.state().machine.next.word, "inc");
    await over.actions.step("");
    assert.equal(over.state().machine.next.word, "inc", "the first inc ran as one step");
    assert.deepEqual(top(over.state), ["6"]);
    await over.actions.step("");
    assert.equal(over.state().status, "done");
    assert.deepEqual(top(over.state), ["7", "7"]);
});

test("the library list is loaded on demand, filtered and inspectable", async () => {
    const { actions, state } = await create();
    assert.equal(state().library.stacks.length, 0);
    await actions.setLibraryOpen(true);
    assert.ok(state().library.total > 225);
    await actions.setLibraryFilter("map");
    assert.deepEqual(state().library.stacks.map((s) => s.name).sort(), ["map"]);
    await actions.toggleStackDetails("map");
    assert.equal(state().library.details["map"].items.length, 1);
    await actions.toggleStackDetails("map");
    assert.deepEqual(state().library.details, {});
});

test("files and reset reach the new machine", async () => {
    const { actions, state } = await create({ files: { "data/x.bo": "(42) (answer) PUSH" } });
    await actions.evaluate('"data/x.bo" () INCLUDE answer');
    assert.deepEqual(top(state), ["42"]);
    await actions.reset();
    assert.deepEqual(top(state), []);
    await actions.evaluate('"data/x.bo" () INCLUDE answer');
    assert.deepEqual(top(state), ["42"]);
});

test("standard input reaches the machine and survives restarts", async () => {
    const { actions, state } = await create({ input: "hi\n" });
    await actions.run("stdin read stdin read");
    assert.equal(state().status, "done", state().output.map((o) => o.text).join(""));
    assert.deepEqual(top(state), ["104", "105"], "reads 'h' then 'i'");
    await actions.setInput("Z");
    await actions.reset();
    await actions.run("stdin read");
    assert.deepEqual(top(state), ["90"], "reads the new input, 'Z' = 90");
});

test("runFast runs a program on a fresh machine without the stepper", async () => {
    const { actions, state } = await create();
    await actions.evaluate("99");
    await actions.runFast('"hi\\n" emits 6 7 *');
    assert.equal(state().status, "done");
    assert.deepEqual(state().fast, { ok: true, line: 0 });
    assert.equal(state().output.map((o) => o.text).join(""), "hi\n");
    assert.deepEqual(top(state), ["42"], "the machine was replaced: 99 is gone");
    assert.equal(state().fastRunning, false);
    assert.equal(state().running, false);
});

test("exit at the prompt empties everything, like clearStacks, and reports the status", async () => {
    const { actions, state } = await create();
    await actions.evaluate("(7) (L) PUSH 1 2");
    assert.equal(state().stacksShown, true);
    assert.equal(await actions.evaluate('"bye\\n" emits 3 exit'), 3);
    assert.deepEqual(state().machine.stacks.map((s) => s.name), [""]);
    assert.deepEqual(top(state), []);
    assert.equal(state().stacksShown, false);
    assert.equal(state().echo, "");
    assert.deepEqual(state().output, []);
    assert.equal(await actions.evaluate("4"), null, "the machine stays usable");
    assert.deepEqual(top(state), ["4"]);
});

test("a failing fast run reports the line, and exit is recognised", async () => {
    const { actions, state } = await create();
    await actions.runFast("1\n2\n1 0 /\n4");
    assert.equal(state().status, "error");
    assert.deepEqual(state().fast, { ok: false, line: 3 });
    await actions.runFast("1 2 7 exit");
    assert.equal(state().status, "exit");
    assert.equal(state().machine.exitCode, 7);
    await actions.step("1 2 +"); // stepping afterwards forgets the fast run
    assert.equal(state().fast, null);
});

test("clearOutput keeps what the machine knows about the last fast run", async () => {
    const { actions, state } = await create();
    await actions.runFast("1\n1 0 /");
    actions.clearOutput();
    assert.deepEqual(state().fast, { ok: false, line: 2 }, "the Next panel can still say which line failed");
    assert.deepEqual(state().output, []);
});

test("clearOutput clears the echoed line and the output", async () => {
    const { actions, state } = await create();
    await actions.evaluate('"x\\n" emits');
    assert.equal(state().echo.length > 0, true);
    actions.clearOutput();
    assert.equal(state().echo, "");
    assert.deepEqual(state().output, []);
    assert.equal(state().source, "prompt");
});

test("kill builds a new client and restarts the machine", async () => {
    const { actions, state, clients } = await create();
    await actions.evaluate("1 2");
    await actions.kill();
    assert.equal(clients(), 2);
    assert.equal(state().error, "machine restarted");
    assert.equal(state().ready, true);
    assert.deepEqual(top(state), []);
});

test("kill reports an event with the machine before it and the fresh one after", async () => {
    const events = [];
    const { actions } = await create({ onEvent: (event) => events.push(event) });
    await actions.evaluate("1 2");
    await actions.kill("stopped");
    const kill = events.at(-1);
    assert.equal(kill.type, "kill");
    assert.equal(kill.reason, "stopped");
    assert.equal(kill.before.stacks[0].depth, 2, "the machine that was lost");
    assert.equal(kill.after.stacks[0].depth, 0, "the fresh one");
});

test("onEvent reports each prompt evaluation with its raw code, result, and stacks before and after", async () => {
    const events = [];
    const { actions } = await create({ onEvent: (event) => events.push(event) });
    await actions.evaluate("1 2");
    await actions.evaluate("+");
    await actions.evaluate("1 0 /");
    assert.deepEqual(events.map((e) => [e.type, e.code, e.ok]), [
        ["evaluate", "1 2", true],
        ["evaluate", "+", true],
        ["evaluate", "1 0 /", false],
    ]);
    const [first, second, failed] = events;
    assert.equal(first.before.stacks[0].depth, 0);
    assert.equal(first.after.stacks[0].depth, 2);
    assert.equal(second.before.stacks[0].depth, 2);
    assert.equal(second.after.stacks[0].items[0][1], "3");
    assert.equal(failed.output.at(-1).stream, "stderr");
    assert.ok(events.every((e) => e.time > 0 && e.duration >= 0 && e.error === null));
    assert.ok(events.every((e) => /^\d+\.\d+/.test(e.version)), "events carry the runtime version");
    assert.ok(first.time <= second.time && second.time <= failed.time);
});

test("onEvent also reports setup, step, run, reset, clearStacks and abort", async () => {
    const events = [];
    const { actions } = await create({ onEvent: (event) => events.push(event) });
    await actions.setup("1 2 3");
    await actions.step("4 5", 2);
    await actions.abort();
    await actions.run("6 7");
    await actions.clearStacks();
    await actions.reset();
    assert.deepEqual(events.map((e) => e.type), ["setup", "step", "abort", "run", "clearStacks", "reset"]);
    assert.equal(events[0].code, "1 2 3");
    assert.deepEqual([events[1].code, events[1].count, events[1].mode], ["4 5", 2, "words"]);
});

test("onEvent reports a failed setup as an event with its error, and a throwing observer does not break the store", async () => {
    const events = [];
    const { actions, state } = await create({ onEvent: (event) => events.push(event) });
    await actions.setup("1 0 /");
    assert.equal(events[0].error, "setup failed");
    const logged = console.error;
    console.error = () => {};
    try {
        const broken = await create({ onEvent: () => { throw new Error("observer bug"); } });
        await broken.actions.evaluate("1 2");
        assert.deepEqual(top(broken.state), ["1", "2"]);
        assert.equal(broken.state().error, null);
    } finally {
        console.error = logged;
    }
    assert.equal(state().error, "setup failed");
});

test("the examples list matches the examples folder", () => {
    const files = readdirSync(join(root, "examples")).filter((f) => f.endsWith(".bo") && !SUPPORT_FILES.includes(f));
    assert.deepEqual(EXAMPLES.map((e) => e.file).sort(), files.sort());
    for (const example of EXAMPLES) {
        assert.ok(example.title, example.file);
        if (example.input) assert.ok(readFileSync(join(root, "examples", "expected", example.input)), example.file);
    }
});

test("the Breeze tribute runs from the playground editor", async () => {
    const { actions, state } = await create();
    const source = readFileSync(join(root, "examples", "15-breeze-hash.bo"), "utf8");
    const expected = readFileSync(join(root, "examples", "expected", "15-breeze-hash.out"), "utf8");
    await actions.run(source);
    assert.equal(state().status, "done");
    assert.equal(state().output.map((entry) => entry.text).join(""), expected);
    assert.ok(state().output.every((entry) => entry.stream === "stdout"));
});

test("the puzzle list matches the puzzles folder", () => {
    const files = readdirSync(join(root, "examples", "puzzles"))
        .filter((f) => f.endsWith(".bo") && !PUZZLE_SUPPORT_FILES.includes(f));
    assert.deepEqual(PUZZLE_FILES.toSorted(), files.toSorted());
    for (const file of PUZZLE_FILES) {
        const puzzle = parsePuzzle(readFileSync(join(root, "examples", "puzzles", file), "utf8"), file);
        assert.ok(puzzle.title, puzzle.file);
        assert.ok(puzzle.goal, puzzle.file);
    }
});

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
process.exit(failed ? 1 : 0);
