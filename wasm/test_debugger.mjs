// Tests for the stepping debugger and state inspection of the WebAssembly runtime.
// Usage: node wasm/test_debugger.mjs   (after `make -C c wasm`)
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBo } from "./bo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examples = join(root, "examples");
const expected = join(examples, "expected");

const create = async (options = {}) => {
    const out = { stdout: "", stderr: "" };
    const bo = await createBo({ ...options, onOutput: (text, stream) => (out[stream] += text) });
    return { bo, out };
};
const defaultStack = (bo) => bo.state().stacks[0].items.map((item) => item[1]);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("library stacks are hidden and only counted", async () => {
    const { bo } = await create();
    const state = bo.state();
    assert.equal(state.status, "idle");
    assert.deepEqual(state.stacks.map((s) => s.origin), ["default"]);
    assert.equal(state.counts.library, 265);
    assert.ok(state.counts.kernel > 50);
});

test("user stacks appear, shadowed library stacks are flagged, popping restores them", async () => {
    const { bo } = await create();
    bo.eval("(1 +) (succ) PUSH (7 8) (L) PUSH");
    let origins = Object.fromEntries(bo.state().stacks.map((s) => [s.name, s.origin]));
    assert.deepEqual(origins, { "": "default", L: "user", succ: "user" });
    bo.eval("(0) (map) PUSH");
    origins = Object.fromEntries(bo.state().stacks.map((s) => [s.name, s.origin]));
    assert.equal(origins["map"], "shadows");
    assert.equal(bo.stack("map").baseDepth, 1);
    bo.eval("(map) POP drop");
    assert.equal(bo.state().stacks.some((s) => s.name === "map"), false);
});

test("including the library again does not make it look like user code", async () => {
    const { bo } = await create();
    bo.eval('"include/std.bo" () INCLUDE');
    assert.deepEqual(bo.state().stacks.map((s) => s.origin), ["default"]);
});

test("a private op of a loaded file works there and is out of reach and out of sight elsewhere", async () => {
    const { bo } = await create({ autoload: "" });
    bo.writeFile("private.bo", "(1 () ADD) (__zz-inc) PUSH\n(__zz-inc) (zz-twice) PUSH\n");
    assert.equal(bo.include("private.bo"), true);
    assert.equal(bo.eval("5 zz-twice"), true);
    assert.deepEqual(defaultStack(bo), ["6"]);
    assert.equal(bo.eval("__zz-inc"), false);
    assert.ok(bo.stacks("zz-").stacks.some((s) => s.name === "zz-twice"));
    assert.ok(!bo.stacks("zz-").stacks.some((s) => s.name === "__zz-inc"));
});

test("markBaseline treats later definitions as library", async () => {
    const { bo } = await create();
    bo.eval("(2 *) (twice) PUSH");
    assert.equal(bo.state().stacks.length, 2);
    bo.markBaseline();
    assert.equal(bo.state().stacks.length, 1);
    assert.equal(bo.stack("twice").origin, "library");
});

test("stepping pauses before each op and executes it on the next step", async () => {
    const { bo } = await create();
    assert.equal(bo.debug.load("(1 +) (succ) PUSH\n10 succ"), true);
    assert.equal(bo.state().status, "ready");
    assert.equal(bo.debug.step(0), "paused");
    let state = bo.state();
    assert.equal(state.next.op, "PUSH");
    assert.equal(state.next.origin, "kernel");
    assert.equal(state.next.native, "PUSH");
    assert.equal(state.steps, 0);
    assert.equal(bo.debug.step(1), "paused");
    state = bo.state();
    assert.equal(state.line, 2);
    assert.equal(state.next.op, "succ");
    assert.equal(state.next.origin, "user");
    assert.equal(state.next.definition, "(1 +)");
    assert.deepEqual(defaultStack(bo), ["10"]);
    assert.equal(bo.debug.run(), "done");
    assert.deepEqual(defaultStack(bo), ["11"]);
    assert.equal(bo.state().status, "done");
});

test("step modes count ops, lines or user ops", async () => {
    const program = "(1 +) (inc) PUSH\n(5 inc inc) apply\n";
    const count = async (mode) => {
        const { bo } = await create();
        bo.debug.load(program);
        let n = 0;
        let status = bo.debug.step(0, mode);
        while (status === "paused") {
            n++;
            status = bo.debug.step(1, mode);
        }
        assert.deepEqual(defaultStack(bo), ["7"]);
        return n;
    };
    assert.equal(await count("lines"), 2);
    assert.equal(await count("user"), 4);
    assert.ok((await count("ops")) > 8);
});

test("a line is one program: lines mode pauses once per line, not per op", async () => {
    const { bo } = await create();
    bo.debug.load("5 dup dup\n6 dup\n7");
    assert.equal(bo.debug.step(0, "lines"), "paused");
    assert.equal(bo.state().line, 1);
    assert.equal(bo.debug.step(1, "lines"), "paused");
    assert.equal(bo.state().line, 2);
    assert.deepEqual(defaultStack(bo), ["5", "5", "5", "6"]);
    assert.equal(bo.debug.step(1, "lines"), "done");
    assert.equal(bo.state().line, 3, "the last line stays known after the program ends");
});

test("clearStacks empties the program's stacks and restores library stacks it changed", async () => {
    const { bo } = await create();
    bo.eval("(1 +) (inc) PUSH (7 8) (L) PUSH 5 6 7 (0) (map) PUSH (1) (map) PUSH");
    assert.deepEqual(bo.state().stacks.map((s) => s.name), ["", "L", "inc", "map"]);
    assert.equal(bo.stack("map").depth, 3);
    bo.clearStacks();
    const state = bo.state();
    assert.deepEqual(state.stacks.map((s) => s.name), [""], "only the default stack remains");
    assert.equal(state.stacks[0].depth, 0);
    assert.equal(bo.stack("map").depth, 1, "the library definition is back");
    assert.equal(bo.stack("map").origin, "library");
    assert.equal(bo.stack("L").depth, 0);
    assert.equal(bo.eval("5 inc"), false, "the program's own ops are gone");
});

test("clearStacks also empties DIAGNOSTICS and unlocks the program's own locked stacks", async () => {
    const { bo } = await create();
    bo.eval("(1 0 /) () catch drop (1) (MINE) PUSH (MINE) LOCK");
    assert.equal(bo.stack("DIAGNOSTICS").depth, 1);
    bo.clearStacks();
    assert.equal(bo.stack("DIAGNOSTICS").depth, 0);
    assert.equal(bo.eval("(5) (MINE) PUSH"), true, "the stack can be used again");
    assert.equal(bo.stack("MINE").depth, 1);
});

test("stacks report whether they are locked", async () => {
    const { bo } = await create();
    bo.eval("(1) (MINE) PUSH (1 0 /) () catch drop");
    assert.equal(bo.stack("MINE").locked, false);
    assert.equal(bo.stack("DIAGNOSTICS").locked, true);
    bo.eval("(MINE) LOCK");
    assert.equal(bo.stack("MINE").locked, true);
    assert.equal(bo.state().stacks.find((s) => s.name === "MINE").locked, true);
    assert.equal(bo.state().stacks[0].locked, false, "the default stack");
});

test("the control stack shows nested programs", async () => {
    const { bo } = await create();
    bo.debug.load("(1 0 /) (drop 42) catch");
    bo.debug.step(0);
    const kinds = [];
    while (bo.debug.step(1) === "paused") kinds.push(bo.state().frames.map((f) => f.kind).join(","));
    assert.ok(kinds.some((k) => k.includes("catch")), kinds.join(" | "));
    assert.ok(kinds.some((k) => k.split(",").length >= 2));
    assert.deepEqual(defaultStack(bo).slice(-1), ["42"]);
});

test("uncaught errors, exit and reading errors end the program", async () => {
    let { bo, out } = await create();
    bo.debug.load("1 2\n1 0 /\n99");
    assert.equal(bo.debug.run(), "error");
    assert.match(out.stderr, /Uncaught Exception -- stdin:2 Domain-Error \(DIV\)/);
    assert.equal(bo.state().stacks.find((s) => s.name === "DIAGNOSTICS").origin, "user");
    assert.equal(bo.debug.load("1"), true, "a new program can be loaded after an error");
    bo.debug.run();

    ({ bo } = await create());
    bo.debug.load("1 2 3 exit 4");
    assert.equal(bo.debug.run(), "exit");
    assert.equal(bo.state().exitCode, 3);
    assert.deepEqual(defaultStack(bo), ["1", "2"]); // exit consumed its status 3
    assert.equal(bo.eval("5"), true, "the machine stays usable");

    ({ bo, out } = await create());
    assert.equal(bo.debug.load("(1 2"), false);
    assert.match(out.stderr, /LOWER/);
    assert.equal(bo.state().status, "idle");
});

test("a breakpoint pauses a debugged program and does nothing in a plain eval", async () => {
    const { bo } = await create();
    assert.equal(bo.eval("1 @ 2"), true);
    assert.deepEqual(defaultStack(bo), ["1", "2"]);
    assert.equal(bo.debug.load("3 @ 4"), true);
    assert.equal(bo.debug.run(), "paused");
    assert.equal(bo.state().breakpoint, true);
    assert.deepEqual(defaultStack(bo), ["1", "2", "3"]);
    // eval runs at the pause point; the commands only record what to do, and resume() does it
    assert.equal(bo.eval("10 +"), true);
    assert.deepEqual(defaultStack(bo), ["1", "2", "13"]);
    assert.equal(bo.debug.resume(), null);
    assert.equal(bo.eval("continue"), true);
    assert.equal(bo.debug.resume(), "done");
    assert.deepEqual(defaultStack(bo), ["1", "2", "13", "4"]);
    assert.equal(bo.eval("(() STEP) () catch"), true, "nothing is paused now");
    assert.match(defaultStack(bo).at(-1), /Debug-Error/);
});

test("a fast load runs freely to a breakpoint, then steps by ops", async () => {
    const { bo } = await create();
    assert.equal(bo.debug.load("(1 @ 2 +) apply 7", { fast: true }), true);
    assert.equal(bo.debug.step(0, "free"), "paused");
    assert.equal(bo.state().breakpoint, true);
    assert.deepEqual(defaultStack(bo), ["1"]);
    assert.equal(bo.debug.step(1), "paused", "the op + runs, and the pause is before the ADD inside it");
    assert.equal(bo.state().breakpoint, false);
    assert.equal(bo.debug.run(), "done");
    assert.deepEqual(defaultStack(bo), ["3", "7"]);
});

test("after a breakpoint the next item is reported, a literal too, also at the end of a line", async () => {
    const { bo } = await create();
    assert.equal(bo.debug.load("(1 @ 2 +) apply 7\n3 @\n4 5 +", { fast: true }), true);
    assert.equal(bo.debug.step(0, "free"), "paused");
    assert.deepEqual([bo.state().next.op, bo.state().next.origin, bo.state().next.literal], ["2", "literal", "number"]);
    assert.equal(bo.debug.step(0, "free"), "paused");
    assert.deepEqual([bo.state().next.op, bo.state().next.literal], ["4", "number"], "the first item of the next line");
    assert.equal(bo.debug.step(0, "free"), "done");
    assert.equal(bo.state().next, null);
});

test('the mode "over" steps ops and skips what they call', async () => {
    const { bo } = await create();
    assert.equal(bo.debug.load("(1 +) (inc) PUSH\n5 inc inc"), true);
    assert.equal(bo.debug.step(0, "over"), "paused");
    assert.equal(bo.state().next.op, "PUSH");
    assert.equal(bo.debug.step(1, "over"), "paused"); // PUSH runs; the next line starts
    assert.equal(bo.state().next.op, "inc");
    assert.equal(bo.debug.step(1, "over"), "paused"); // the first inc, and all that it calls, is one step
    assert.equal(bo.state().next.op, "inc");
    assert.deepEqual(defaultStack(bo), ["6"]);
    assert.equal(bo.debug.step(1, "over"), "done");
    assert.deepEqual(defaultStack(bo), ["7"]);
});

test("a scratch program leaves the status of the program that ran before", async () => {
    const { bo } = await create();
    assert.equal(bo.debug.load("1 0 /"), true);
    assert.equal(bo.debug.run(), "error");
    assert.equal(bo.state().status, "error");
    assert.equal(bo.debug.load("2 3 +", { scratch: true }), true);
    assert.equal(bo.debug.step(0, "free"), "done");
    assert.equal(bo.state().status, "error");
    assert.deepEqual(defaultStack(bo), ["1", "0", "5"]);
});

test("a program is rejected while another one is active; abort drops it", async () => {
    const { bo } = await create();
    assert.equal(bo.debug.load("1 2 +"), true);
    assert.equal(bo.debug.load("3"), false);
    bo.debug.step(1);
    bo.debug.abort();
    assert.equal(bo.state().status, "idle");
    assert.equal(bo.state().frames.length, 0);
    assert.equal(bo.debug.load("3"), true);
    assert.equal(bo.debug.run(), "done");
    // abort leaves the stacks as they were: the operands and the pending selector remain
    assert.deepEqual(defaultStack(bo), ["1", "2", "()", "3"]);
});

test("nested includes and parallel runs are stepped over", async () => {
    const { bo } = await create({ autoload: "include/core.bo" });
    bo.debug.load('"include/std.bo" () INCLUDE\n(1 2 3) (dup *) parallel');
    assert.equal(bo.debug.step(0), "paused");
    assert.equal(bo.state().next.op, "INCLUDE");
    bo.debug.step(1);
    assert.equal(bo.state().line, 2);
    assert.equal(bo.debug.run(), "done");
    assert.deepEqual(defaultStack(bo), ["((1) (4) (9))"]);
});

test("library and kernel stacks can be listed and inspected on demand", async () => {
    const { bo } = await create();
    const all = bo.stacks("cons");
    assert.ok(all.total >= 4);
    assert.ok(all.stacks.some((s) => s.name === "consl" && s.origin === "library"));
    assert.ok(all.stacks.some((s) => s.name === "CONSL" && s.origin === "kernel"));
    assert.ok(bo.stacks("MAP").stacks.some((s) => s.name === "map"));
    assert.equal(bo.stack("map").items.length, 1);
    assert.equal(bo.stack("no.such.stack"), null);
    assert.equal(bo.stack("").origin, "default");
});

test("long values are cut and big stacks are windowed", async () => {
    const { bo } = await create();
    bo.eval("1 300 :");
    bo.eval("1 2 3 4 5 6 7 8 9 10");
    const state = bo.state({ maxItems: 3, maxChars: 20 });
    const stack = state.stacks[0];
    assert.equal(stack.items.length, 3);
    assert.equal(stack.hidden, stack.depth - 3);
    const big = bo.stack("", { maxItems: 20, maxChars: 20 }).items.find((i) => i[0] === "l");
    assert.ok(big[1].length <= 21 && big[1].endsWith("…"));
});

test("every example gives its expected output when stepped to the end", async () => {
    const names = readdirSync(examples).filter((f) => f.endsWith(".bo"));
    for (const file of names) {
        const name = file.slice(0, -3);
        const inputPath = join(expected, `${name}.in`);
        const { bo, out } = await create({
            autoload: "include/core.bo",
            input: existsSync(inputPath) ? readFileSync(inputPath, "utf8") : "",
        });
        for (const source of readdirSync(examples).filter((f) => f.endsWith(".bo")))
            bo.writeFile(`examples/${source}`, readFileSync(join(examples, source), "utf8"));
        assert.equal(bo.debug.load(readFileSync(join(examples, file), "utf8")), true, name);
        const status = bo.debug.run(1e9);
        assert.equal(status, "done", `${name}: ${out.stderr}`);
        assert.equal(out.stderr, "", name);
        assert.equal(out.stdout, readFileSync(join(expected, `${name}.out`), "utf8"), name);
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
