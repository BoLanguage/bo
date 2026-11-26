// Tests for the spec compiler. Usage: node playground-plus/test_compile.mjs (after `make wasm`)
import assert from "node:assert/strict";
import { parsePuzzle } from "../playground/puzzles.mjs";
import { KINDS, TAGS, availableKinds, compileSpec, estimateDifficulty, explainFailure, makeTitle, normalizeSpec } from "./compile.mjs";
import { formatReport, validatePuzzle } from "./harness.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const ARRANGE = {
    kind: "arrange", tags: ["shuffle"], goal: "Put the three values in ascending order, smallest at the bottom.",
    inputs: [[7, 3, 5]], solution: "rot", hints: ["The biggest value travels up.", "`rot` cycles the top three."],
};
const DEFINE = {
    kind: "define", tags: ["definition", "arithmetic"], word: "twice-plus-one",
    goal: "Define `twice-plus-one` so that it doubles the number on top and then adds one.",
    inputs: [[0], [3], [10], [-4]], solution: "2 * 1 +", hints: ["Double first, then add one."],
};
const compile = (spec, options = {}) => compileSpec(spec, { agent: "test-model", number: 4, ...options });
const problemsOf = async (changes, base = ARRANGE) => (await compile({ ...base, ...changes })).problems;

test("the kinds: two are available, the others are placeholders an agent is not offered", () => {
    assert.deepEqual(availableKinds(), ["arrange", "define"]);
    assert.deepEqual(Object.keys(KINDS), ["arrange", "define", "predict", "fix", "golf", "named-stack"]);
    assert.ok(TAGS.length >= 5 && TAGS.every((tag) => /^[a-z][a-z-]*$/.test(tag)));
});

test("an arrange spec becomes a puzzle file whose expected stack is what the solution leaves", async () => {
    const compiled = await compile(ARRANGE);
    assert.deepEqual(compiled.problems, []);
    assert.deepEqual(compiled.derived, { title: "Shuffle #4 · test-model", difficulty: 1, tags: ["shuffle"], results: ["(3 5 7)"], freeHints: 0 });
    const parsed = parsePuzzle(compiled.source, "compiled.bo");
    assert.equal(parsed.title, "Shuffle #4 · test-model");
    assert.equal(parsed.goal, ARRANGE.goal);
    assert.deepEqual([parsed.hints, parsed.freeHints, parsed.tags, parsed.difficulty], [2, 0, ["shuffle"], 1]);
    assert.deepEqual(parsed.solutions, ["rot guess"]);
    assert.match(parsed.description, /The stack starts as `7 3 5`.*Leave it as `3 5 7`/);
    assert.ok(parsed.description.endsWith("Run `guess` to check your solution."), "every puzzle says how to check");
    assert.match(compiled.source, /\(snapshot \(3 5 7\) puzzle\.eq\) puzzle\.require\n7 3 5\n/);
    const report = await validatePuzzle(compiled.source);
    assert.equal(report.ok, true, formatReport(report));
});

test("a define spec: expected results come from running the solution, with a free how-to hint first", async () => {
    const compiled = await compile(DEFINE);
    assert.deepEqual(compiled.problems, []);
    assert.deepEqual(compiled.derived.results, ["(1)", "(7)", "(21)", "(-7)"]);
    assert.equal(compiled.derived.freeHints, 1);
    const parsed = parsePuzzle(compiled.source, "compiled.bo");
    assert.deepEqual([parsed.hints, parsed.freeHints], [2, 1], "the free hint is counted among the hints");
    assert.deepEqual(parsed.solutions, ["(2 * 1 +) (twice-plus-one) PUSH guess"]);
    assert.equal(parsed.wrong.length, 2, "an empty definition and a constant one are tried");
    assert.match(compiled.source, /"Define a word by pushing a quotation onto a stack with its name: \(BODY\) \(twice-plus-one\) PUSH\. Then run guess\."/);
    const report = await validatePuzzle(compiled.source);
    assert.equal(report.ok, true, formatReport(report));
    assert.ok(report.checks.some((c) => c.id === "freehints" && c.ok));
    assert.match(parsed.description, /`0 twice-plus-one` leaves `1` and `3 twice-plus-one` leaves `7`/);
    assert.match(parsed.description, /Push a quotation onto `twice-plus-one`\.\nRun `guess` to check your solution\.$/);
});

test("lists as inputs, and a recursive word, work", async () => {
    const total = await compile({ ...DEFINE, tags: ["list"], word: "total", goal: "Define `total` so that it sums a list of numbers.", inputs: [[[1, 2, 3]], [[]], [[5]], [[4, 6]]], solution: "0 (apply +) foldl" });
    assert.deepEqual(total.problems, []);
    assert.deepEqual(total.derived.results, ["(6)", "(0)", "(5)", "(10)"]);
    assert.equal((await validatePuzzle(total.source)).ok, true);
    const factorial = await compile({
        ...DEFINE, tags: ["recursion"], word: "fact", goal: "Define `fact` so that it replaces n with n factorial.", inputs: [[0], [1], [3], [5]],
        solution: "(dup 1 >) (dup 1 - fact *) (drop 1) ifte",
    });
    assert.deepEqual(factorial.problems, []);
    assert.deepEqual(factorial.derived.results, ["(1)", "(1)", "(6)", "(120)"]);
    assert.equal((await validatePuzzle(factorial.source)).ok, true);
});

test("the player is graded on what they leave: wrong definitions and wrong stacks fail, right ones pass", async () => {
    const compiled = await compile(DEFINE);
    for (const [line, expected] of [["(2 * 1 +) (twice-plus-one) PUSH guess", 2], ["(dup + 1 +) (twice-plus-one) PUSH guess", 2], ["(2 *) (twice-plus-one) PUSH guess", 1]]) {
        const withRight = compiled.source.replace(/^;@solution .*$/m, `;@solution ${line}`).replace(/^;@wrong .*\n/gm, "");
        const report = await validatePuzzle(withRight);
        assert.equal(report.ok, expected === 2, `${line}\n${formatReport(report)}`);
    }
    const arrange = await compile(ARRANGE);
    const wrong = arrange.source.replace(/^;@solution .*$/m, ";@solution swap guess");
    assert.match(find(await validatePuzzle(wrong), "solution:1").message, /compared \(7 5 3\) \(what the answer produced\) with \(3 5 7\)/);
});
const find = (report, id) => report.checks.find((c) => c.id === id);

test("the title is the main tag, the puzzle's number and who wrote it", () => {
    assert.equal(makeTitle(["shuffle", "list"], 17, "gemma4:12b"), "Shuffle #17 · gemma4:12b");
    assert.equal(makeTitle(["list"], 2, null), "List #2 · agent");
    assert.equal(makeTitle(["list"], 2, "bad;\nname<script>"), "List #2 · badnamescript");
    assert.ok(makeTitle(["list"], 2, "x".repeat(200)).length < 60);
});

test("difficulty is estimated from the solution's size and use of control words", () => {
    assert.equal(estimateDifficulty("arrange", "rot"), 1);
    assert.equal(estimateDifficulty("arrange", "swap rot"), 2);
    assert.equal(estimateDifficulty("arrange", "swap rot swap rot"), 3);
    assert.equal(estimateDifficulty("arrange", "swap rot swap rot swap rot swap"), 5);
    assert.equal(estimateDifficulty("define", "2 *"), 1);
    assert.equal(estimateDifficulty("define", "2 * 1 +"), 2);
    assert.equal(estimateDifficulty("define", "(dup 0 <) (neg) (nop) ifte"), 4, "five words and a conditional");
    assert.equal(estimateDifficulty("define", "dup dup dup dup dup dup dup dup dup dup dup dup ifte"), 5, "capped");
});

test("a spec with a wrong shape gets every problem at once, in the agent's terms", async () => {
    const compiled = await compile({ kind: "arrange", tags: [], goal: "short", inputs: [], solution: "", hints: [] });
    assert.equal(compiled.ok, false);
    assert.equal(compiled.problems.length, 5);
    for (const field of ["tags", "goal", "solution", "hints", "inputs"]) assert.ok(compiled.problems.some((p) => p.startsWith(field)), field);
    assert.match((await compile(null)).problems[0], /must be an object/);
    assert.match((await problemsOf({ kind: "nope" }))[0], /kind must be one of arrange, define/);
    assert.match((await problemsOf({ kind: "predict" }))[0], /kind "predict" is not available yet/);
    assert.match((await problemsOf({ tags: ["shuffle", "shuffle"] }))[0], /1 to 3 different values from shuffle/);
    assert.match((await problemsOf({ tags: ["magic"] }))[0], /tags must be/);
    assert.match((await problemsOf({ tags: ["shuffle", "list", "recursion", "arithmetic"] }))[0], /tags must be/);
    assert.match((await problemsOf({ hints: ["a", "b", "c", "d"] }))[0], /hints must be a list of 1 to 3/);
    assert.match((await problemsOf({ hints: [""] }))[0], /hints must be/);
    assert.match((await problemsOf({ goal: "x".repeat(301) }))[0], /goal must be/);
    assert.match((await problemsOf({ solution: "(rot" }))[0], /solution is not valid Bo/);
    assert.match((await problemsOf({ solution: "rot guess guess" }))[0], /must not contain guess/);
    assert.match((await problemsOf({ inputs: [[7, 3.5, 5]] }))[0], /inputs\[0\] must be a list of up to 12 whole numbers/);
    assert.match((await problemsOf({ inputs: [["a"]] }))[0], /inputs\[0\]/);
    assert.match((await problemsOf({ inputs: [[1e9]] }))[0], /inputs\[0\]/);
    assert.match((await problemsOf({ inputs: [[[1, [2]]]] }))[0], /inputs\[0\]/, "lists of lists are not supported");
    assert.match((await problemsOf({ inputs: [[7, 3, 5], [1, 2, 3]] }))[0], /arrange puzzle needs exactly one input/);
    assert.match((await problemsOf({ word: "x" }))[0], /word is only for define/);
    assert.match((await problemsOf({ word: "Bad Name", inputs: [[1], [2], [3]] }, DEFINE))[0], /word must be the name to define/);
    assert.match((await problemsOf({ inputs: [[1], [2]] }, DEFINE))[0], /needs 3 to 8 inputs/);
    assert.match((await problemsOf({ inputs: Array.from({ length: 9 }, (_, i) => [i]) }, DEFINE))[0], /needs 3 to 8 inputs/);
});

test("failures say what to do about the commonest mistakes, once when every input fails the same way", async () => {
    const missing = await problemsOf({ solution: "dup 1 < if 0 else 1 then" }, DEFINE);
    assert.equal(missing.length, 1, "four inputs, one message");
    assert.match(missing[0], /^the solution run on every input failed: .*Existence-Error \(WORD\) \(\(if\)\)\. "if" is not a Bo word.*ifte: \(condition\) \(then\) \(else\) ifte.*query "if"/);
    const wrongOrder = await problemsOf({ solution: "dup 1 <= ifte (drop 0) (dup 1 - sum + )" }, DEFINE);
    assert.match(wrongOrder[0], /ifte needs three quotations in this order: \(condition\) \(then\) \(else\) ifte, for example \(dup 0 <\) \(neg\) \(nop\) ifte/);
    // different failures on different inputs are each reported
    const mixed = await problemsOf({ solution: "dup 0 = (1 0 /) (nop) ifte", inputs: [[0], [3], [5]] }, DEFINE);
    assert.ok(mixed.length >= 1 && mixed.every((p) => p.startsWith("the solution run on")), mixed.join("\n"));
    assert.equal(explainFailure("Uncaught Exception -- stdin:1 Stack-Error (DROP) ()"), "Uncaught Exception -- stdin:1 Stack-Error (DROP) ()", "other errors are shown as they are");
});

test("a spec whose solution cannot be run says what failed, and nothing is built", async () => {
    const empty = await compile({ ...ARRANGE, solution: "drop drop drop" });
    assert.match(empty.problems[0], /the solution run on inputs\[0\], failed|leaves nothing/);
    assert.equal(empty.source, null);
    assert.match((await problemsOf({ solution: "no-such-word" }))[0], /the solution run on inputs\[0\], failed/);
    assert.match((await problemsOf({ solution: "1 2 /" }))[0], /not a whole number/, "0.5 is not a whole number");
    assert.match((await compile({ ...ARRANGE, solution: "(spin) (spin) PUSH spin" }, { budget: 5000 })).problems[0], /step budget/);
    assert.match((await problemsOf({ solution: "swap swap" }))[0], /leaves the stack as it started/);
});

test("a define spec whose inputs cannot tell a wrong word from the right one is refused", async () => {
    assert.match((await problemsOf({ solution: "dup drop" }, DEFINE))[0], /every input comes out unchanged \(0 twice-plus-one -> \(0\); 3 twice-plus-one -> \(3\); .*\), so doing nothing would pass\. Check that your solution does what the goal says/);
    assert.match((await problemsOf({ solution: "drop 5" }, DEFINE))[0], /every input gives \(5\) \(0 twice-plus-one -> \(5\); .*\), so a word that ignores its input would pass/);
    assert.match((await problemsOf({ inputs: [[1], [1], [2]] }, DEFINE))[0], /inputs must all be different/);
    assert.match((await problemsOf({ word: "dup" }, DEFINE))[0], /word "dup" already exists in Bo/);
    assert.match((await problemsOf({ word: "guess" }, DEFINE))[0], /already exists/);
    assert.match((await problemsOf({ solution: "xyzzy" }, DEFINE))[0], /the solution run on every input failed: .*"xyzzy" is not a Bo word/);
});

test("warnings: a hint that gives the solution away, a goal without the word, a tag the solution does not use", async () => {
    const leaky = await compile({ ...DEFINE, hints: ["Just write 2 * 1 + and you are done."] });
    assert.deepEqual(leaky.problems, []);
    assert.match(leaky.warnings[0], /a hint contains the whole solution/);
    assert.match((await compile({ ...DEFINE, goal: "Make a word that doubles and adds one." })).warnings[0], /does not mention the word "twice-plus-one"/);
    assert.match((await compile({ ...ARRANGE, tags: ["arithmetic"] })).warnings[0], /tag "arithmetic" is claimed but the solution uses none/);
    assert.deepEqual((await compile(ARRANGE)).warnings, []);
});

test("text in a spec cannot break the file: quotes, backslashes, newlines and comments", async () => {
    const tricky = await compile({
        ...ARRANGE, goal: "Order the three values, using `rot`.\n;@end ;@solution drop",
        hints: ['Say "rot" \\ now; or else\n;@end', "Hint (with parentheses) and a ) stray"],
    });
    assert.deepEqual(tricky.problems, []);
    const parsed = parsePuzzle(tricky.source, "tricky.bo");
    assert.equal(parsed.hints, 2);
    assert.deepEqual(parsed.solutions, ["rot guess"], "the goal's text did not become a directive");
    assert.equal((await validatePuzzle(tricky.source)).ok, true);
});

test("the spec is normalised: whitespace, and a final guess on the solution", () => {
    assert.deepEqual(normalizeSpec({ ...ARRANGE, goal: "  Put   them \n in order  ", solution: " swap   rot guess " }), { ...ARRANGE, goal: "Put them in order", solution: "swap rot" });
    assert.equal(normalizeSpec({ ...ARRANGE, solution: "rot guessing" }).solution, "rot guessing", "only the word guess is dropped");
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
