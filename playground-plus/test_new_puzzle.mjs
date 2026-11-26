// Tests for the pure parts of the "New puzzle" dialog (the dialog itself is checked in a real browser).
// Usage: node playground-plus/test_new_puzzle.mjs
import assert from "node:assert/strict";
import { buildPrompt, describeJob, describePreferences } from "./client/new-puzzle.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("what the player asked for is put in words", () => {
    assert.equal(describePreferences(), "");
    assert.equal(describePreferences({}), "");
    assert.equal(describePreferences({ tags: ["list"] }), "about list");
    assert.equal(describePreferences({ tags: ["list", "recursion"], change: "harder" }), "about list or recursion, a bit harder than the last one");
    assert.equal(describePreferences({ change: "easier" }), "a bit easier than the last one");
});

test("what a running job is doing is told in plain words, with the time spent", () => {
    const job = { model: "gemma4:12b", startedAt: 1_000_000, turn: 0, tool: null, attempt: 1 };
    assert.equal(describeJob(job, 1_000_000 + 5_000), "gemma4:12b is starting up (the first time can take a minute or two) · 0:05");
    assert.equal(describeJob({ ...job, turn: 3, tool: "validate_puzzle" }, 1_000_000 + 83_000), "gemma4:12b is checking its puzzle · 1:23");
    assert.equal(describeJob({ ...job, turn: 1, tool: "get_bo_guide" }, 1_000_000 + 600_000), "gemma4:12b is reading the guide · 10:00");
    assert.equal(describeJob({ ...job, turn: 5, tool: "submit_puzzle", attempt: 2 }, 1_000_000), "gemma4:12b is handing the puzzle over, on its second try · 0:00");
    assert.equal(describeJob({ ...job, turn: 5, tool: "validate_puzzle", attempt: 3 }, 1_000_000), "gemma4:12b is checking its puzzle, on its third try · 0:00");
    assert.equal(describeJob({ ...job, turn: 2, tool: "something_new" }, 1_000_000), "gemma4:12b is working · 0:00");
    assert.match(describeJob(job, 0), /· 0:00$/, "a clock that is behind never shows a negative time");
});

test("the message for the assistant names the tools in order, and asks not to reveal the solution", () => {
    const plain = buildPrompt();
    assert.match(plain, /^Please write me a new puzzle for Playground\+\./);
    assert.ok(plain.indexOf("get_bo_guide") < plain.indexOf("get_brief") && plain.indexOf("get_brief") < plain.indexOf("validate_puzzle") && plain.indexOf("validate_puzzle") < plain.indexOf("submit_puzzle"));
    assert.match(plain, /do not tell me the solution/);
    assert.doesNotMatch(plain, /I would like/);
    assert.match(buildPrompt({ tags: ["list"], change: "harder" }), /I would like it about list, a bit harder than the last one\./);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`FAIL ${name}\n${error.stack.split("\n").slice(0, 8).join("\n")}`);
    }
}
process.exit(failed ? 1 : 0);
