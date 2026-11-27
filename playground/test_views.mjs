// Tests for the pure helpers of views.mjs (no DOM needed).
// Usage: node playground/test_views.mjs
import assert from "node:assert/strict";
import { hintSummary, inlineCodeParts, promptPlaceholder, splitItems, textHint, visibleStacks } from "./views.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the hint summary says how many hints cost nothing", () => {
    assert.equal(hintSummary(0), "no hints available");
    assert.equal(hintSummary(1), "1 hint available");
    assert.equal(hintSummary(3), "3 hints available");
    assert.equal(hintSummary(1, 1), "1 hint available (free)");
    assert.equal(hintSummary(3, 1), "3 hints available (the first is free)");
    assert.equal(hintSummary(3, 2), "3 hints available (the first 2 are free)");
    assert.equal(hintSummary(3, 0, 1), "3 hints available (1 used)");
    assert.equal(hintSummary(3, 1, 2), "3 hints available (2 used; the first is free)");
    assert.equal(hintSummary(2, 0, 7), "2 hints available (2 used)", "asking again after the last hint does not count past the total");
    assert.equal(hintSummary(0, 0, 3), "no hints available");
});

test("the prompt says what the next step is while a program is paused", () => {
    const idle = "Type some Bo";
    assert.equal(promptPlaceholder({ status: "idle", machine: null }, idle), idle);
    assert.equal(promptPlaceholder({ status: "done", machine: { next: null } }, idle), idle);
    assert.equal(promptPlaceholder({ status: "paused", machine: { next: { op: "+" } } }, idle),
        "Paused before + \u00b7 Type step, next, continue or stop, or any Bo to run here");
    assert.equal(promptPlaceholder({ status: "paused", machine: { next: null } }, idle),
        "Paused \u00b7 Type step, next, continue or stop, or any Bo to run here");
    const long = promptPlaceholder({ status: "paused", machine: { next: { op: "(a very long list of many elements)" } } }, idle);
    assert.ok(long.startsWith("Paused before (a very long list of ma\u2026 \u00b7 Type"), long);
    assert.match(promptPlaceholder({ status: "ready", machine: null }, idle), /^Program loaded/);
});

test("splitItems separates the top-level items of a rendered list", () => {
    assert.deepEqual(splitItems("(a (b c) d)"), ["a", "(b c)", "d"]);
    assert.deepEqual(splitItems("(1 +)"), ["1", "+"]);
    assert.deepEqual(splitItems("()"), []);
    assert.deepEqual(splitItems("((1) (2 (3)))"), ["(1)", "(2 (3))"]);
    assert.deepEqual(splitItems("(a  b\tc)"), ["a", "b", "c"]);
});

test("splitItems copes with text cut short by the machine", () => {
    assert.deepEqual(splitItems("(1 2 (3 4"), ["1", "2", "(3 4"]);
    assert.deepEqual(splitItems("(1 2 3\u2026"), ["1", "2", "3\u2026"]);
});

test("textHint reads lists of printable character codes as text", () => {
    assert.equal(textHint("l", "(72 105)"), '"Hi"');
    assert.equal(textHint("l", "(79 80)"), '"OP"');
    assert.equal(textHint("l", "(1 2 3)"), null);
    assert.equal(textHint("l", "(72)"), null, "a single number is not text");
    assert.equal(textHint("l", "(300 400)"), null);
    assert.equal(textHint("n", "42"), null);
    assert.equal(textHint("l", "((72) (105))"), null);
});

test("inlineCodeParts marks paired backticks as code without parsing other markup", () => {
    assert.deepEqual(inlineCodeParts("Push `solution` then `guess`."), [
        { text: "Push ", code: false },
        { text: "solution", code: true },
        { text: " then ", code: false },
        { text: "guess", code: true },
        { text: ".", code: false },
    ]);
    assert.deepEqual(inlineCodeParts("Use <b>text</b> and `unfinished"), [
        { text: "Use <b>text</b> and `unfinished", code: false },
    ]);
});

test("visibleStacks hides named stacks but keeps the default stack", () => {
    const stacks = [{ name: "" }, { name: "answer" }, { name: "puzzle.solution" }];
    assert.deepEqual(visibleStacks(stacks, ["puzzle.solution"]).map((stack) => stack.name), ["", "answer"]);
    assert.deepEqual(visibleStacks(stacks, [""]).map((stack) => stack.name), ["", "answer", "puzzle.solution"]);
    assert.deepEqual(visibleStacks(stacks, [], ["puzzle."]).map((stack) => stack.name), ["", "answer"]);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`FAIL ${name}\n${error.stack.split("\n").slice(0, 6).join("\n")}`);
    }
}
process.exit(failed ? 1 : 0);
