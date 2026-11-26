// Tests for the puzzle harness and the token counter. Usage: node playground-plus/test_harness.mjs
// (after `make wasm`)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUZZLE_FILES } from "../playground/puzzles.mjs";
import { formatReport, normalizeSource, puzzleId, validatePuzzle } from "./harness.mjs";
import { answerLength, topLevelTokens } from "./tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SETUP = [
    '"include/std.bo" require', '"examples/puzzles/lib.bo" require',
    "((1 2 3)) (puzzle.solution) PUSH", "(puzzle.solution) LOCK",
    "() (snapshot puzzle.solution =) puzzle.require", "3 1 2",
    '("rot moves the third value to the top.") (puzzle.hints) PUSH', '"rot guess" (puzzle.reveal) PUSH',
].join("\n");
const SPIN = "(spin) (spin) PUSH spin";
/** A puzzle file; `header` replaces the default directives, `setup` the default Bo source. */
const puzzle = ({ header = [";@hints 1", ";@tags shuffle", ";@difficulty 1", ";@solution rot guess", ";@wrong swap guess"], setup = SETUP } = {}) =>
    [";@puzzle", ";@title T", ";@goal G", ...header, ";@end", setup].join("\n");
const without = (...prefixes) => [";@hints 1", ";@tags shuffle", ";@difficulty 1", ";@solution rot guess", ";@wrong swap guess"]
    .filter((line) => !prefixes.some((prefix) => line.startsWith(prefix)));
const options = { budget: 5000 };
const find = (report, id) => report.checks.find((c) => c.id === id);
const failing = (report) => report.checks.filter((c) => !c.ok && c.level === "error").map((c) => c.id);

// ---------------------------------------------------------------- tokens

test("top-level tokens: words, numbers, strings and whole lists each count once", () => {
    assert.deepEqual(topLevelTokens("rot guess"), ["rot", "guess"]);
    assert.deepEqual(topLevelTokens("(2 *) (twicer) PUSH guess"), ["(2 *)", "(twicer)", "PUSH", "guess"]);
    assert.deepEqual(topLevelTokens('"a b" 1.5 (1 (2 3) ()) x'), ['"a b"', "1.5", "(1 (2 3) ())", "x"]);
    assert.deepEqual(topLevelTokens("(a)(b)c"), ["(a)", "(b)", "c"], "parentheses delimit");
    assert.deepEqual(topLevelTokens(""), []);
    assert.deepEqual(topLevelTokens("  \n\t "), []);
});

test("comments and strings: a ; inside a string is text, a quote can be escaped", () => {
    assert.deepEqual(topLevelTokens("1 ; a comment ( \n 2"), ["1", "2"]);
    assert.deepEqual(topLevelTokens('"a;b" 3'), ['"a;b"', "3"]);
    assert.deepEqual(topLevelTokens('"say \\"hi\\" (" end'), ['"say \\"hi\\" ("', "end"]);
    assert.deepEqual(topLevelTokens('(1 "x)" 2) 3'), ['(1 "x)" 2)', "3"], "a ) inside a string does not close the list");
    assert.deepEqual(topLevelTokens("(1 ; )\n 2) 3"), ["(1 ; )\n 2)", "3"], "nor one inside a comment");
});

test("unbalanced input is an error", () => {
    for (const bad of ["(1 2", "1 2)", '"open', "((1)", '(1 "x)']) assert.throws(() => topLevelTokens(bad), Error, bad);
});

test("the length of an answer leaves out a final guess", () => {
    assert.equal(answerLength("rot guess"), 1);
    assert.equal(answerLength("(2 *) (twicer) PUSH guess"), 3);
    assert.equal(answerLength("swap rot"), 2);
    assert.equal(answerLength("guess"), 0);
    assert.equal(answerLength("guess rot"), 2, "only a final guess is left out");
});

// ---------------------------------------------------------------- identity

test("the id depends on the normalised text only", () => {
    const text = puzzle();
    assert.match(puzzleId(text), /^[0-9a-f]{64}$/);
    assert.equal(puzzleId(text), puzzleId(text.replace(/\n/g, "\r\n")));
    assert.equal(puzzleId(text), puzzleId(`${text}\n\n\n`));
    assert.equal(puzzleId(text), puzzleId(text.split("\n").map((line) => `${line}   `).join("\n")));
    assert.notEqual(puzzleId(text), puzzleId(text.replace("rot moves", "rot shifts")));
    assert.equal(normalizeSource("a  \r\nb\r\n\r\n"), "a\nb\n");
});

// ---------------------------------------------------------------- the harness

test("a good puzzle is valid, with its metrics, and every check passes", async () => {
    const report = await validatePuzzle(puzzle(), options);
    assert.equal(report.ok, true, formatReport(report));
    assert.deepEqual(report.checks.map((c) => [c.id, c.ok]), [
        ["header", true], ["setup", true], ["hints", true], ["untouched", true], ["solution:1", true], ["wrong:1", true], ["typable", false],
    ]);
    assert.equal(find(report, "typable").level, "warning");
    assert.deepEqual(report.metrics, { solutionLengths: [1], bestKnownLength: 1 });
    assert.equal(report.id, puzzleId(puzzle()));
    assert.equal(report.puzzle.title, "T");
});

test("header problems are listed together, and nothing is run", async () => {
    const report = await validatePuzzle(puzzle({ header: [";@hints 1"] }), options);
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 1);
    assert.match(find(report, "header").message, /;@solution.*;@tags.*;@difficulty/);
    assert.equal(find(await validatePuzzle("not a puzzle", options), "header").ok, false);
    const badLine = await validatePuzzle(puzzle({ header: [...without(";@wrong"), ';@wrong "unterminated'] }), options);
    assert.match(find(badLine, "header").message, /not valid Bo: unterminated string/);
    const big = await validatePuzzle(puzzle({ setup: `${SETUP}\n;${"x".repeat(70_000)}` }), options);
    assert.match(find(big, "header").message, /longer than 65536/);
});

test("the setup must run: a syntax error, a runtime error and an endless loop are each reported", async () => {
    const syntax = await validatePuzzle(puzzle({ setup: "(1 2" }), options);
    assert.deepEqual(failing(syntax), ["setup"]);
    const runtime = await validatePuzzle(puzzle({ setup: "1 0 /" }), options);
    assert.match(find(runtime, "setup").message, /did not run: it failed: .*DIV/);
    const endless = await validatePuzzle(puzzle({ setup: SPIN }), options);
    assert.match(find(endless, "setup").message, /step budget/);
});

test("the setup must register a check with puzzle.require", async () => {
    const report = await validatePuzzle(puzzle({ setup: `"include/std.bo" require\n"examples/puzzles/lib.bo" require\n3 1 2` }), options);
    assert.deepEqual(failing(report), ["protocol"]);
});

test("the declared hint count must match what the setup defines; a missing reveal is a warning", async () => {
    const mismatch = await validatePuzzle(puzzle({ header: without(";@hints").concat(";@hints 2") }), options);
    assert.deepEqual(failing(mismatch), ["hints"]);
    assert.match(find(mismatch, "hints").message, /says 2 but the setup defines 1/);
    const none = await validatePuzzle(puzzle({ header: without(";@hints").concat(";@hints 0"), setup: SETUP.split("\n").slice(0, 6).join("\n") }), options);
    assert.equal(none.ok, true, formatReport(none));
    assert.equal(find(none, "reveal").level, "warning");
});

test("a puzzle that is already solved, or whose check fails on the untouched state, is rejected", async () => {
    const solved = await validatePuzzle(puzzle({ setup: SETUP.replace("3 1 2", "1 2 3") }), options);
    assert.ok(failing(solved).includes("untouched"));
    assert.match(find(solved, "untouched").message, /solved before the player does anything \(the default stack at the start is \(1 2 3\)\)/);
    const broken = await validatePuzzle(puzzle({ setup: SETUP.replace("(snapshot puzzle.solution =)", "(no-such-word)") }), options);
    assert.match(find(broken, "untouched").message, /raises an error/);
});

test("solutions, right samples and wrong samples are each checked on a fresh puzzle", async () => {
    const badSolution = await validatePuzzle(puzzle({ header: [...without(";@solution"), ";@solution swap guess"] }), options);
    assert.deepEqual(failing(badSolution), ["solution:1"]);
    assert.match(find(badSolution, "solution:1").message, /reported wrong; the default stack was then \(3 2 1\), so check that your check accepts exactly that/);
    assert.deepEqual(badSolution.metrics.solutionLengths, []);

    const right = await validatePuzzle(puzzle({ header: [...without(), ";@right swap swap rot guess"] }), options);
    assert.equal(right.ok, true, formatReport(right));
    assert.equal(find(right, "right:1").ok, true);
    assert.equal(right.metrics.bestKnownLength, 1, "the shortest answer wins");

    const wrongRight = await validatePuzzle(puzzle({ header: [...without(), ";@right swap guess"] }), options);
    assert.deepEqual(failing(wrongRight), ["right:1"]);

    const lenient = await validatePuzzle(puzzle({ header: [...without(";@wrong"), ";@wrong rot guess"] }), options);
    assert.deepEqual(failing(lenient), ["wrong:1"]);
    assert.match(find(lenient, "wrong:1").message, /too lenient \(the default stack was then \(1 2 3\)\)/);

    const undefinedWord = await validatePuzzle(puzzle({ header: [...without(";@wrong"), ";@wrong no-such-word guess"] }), options);
    assert.equal(undefinedWord.ok, true, "a wrong sample that raises an error is still wrong");

    const hung = await validatePuzzle(puzzle({ header: [...without(";@wrong"), `;@wrong ${SPIN} guess`] }), options);
    assert.deepEqual(failing(hung), ["wrong:1"]);
    assert.match(find(hung, "wrong:1").message, /step budget/);
});

test("a failing check built with puzzle.eq says which comparison failed, and the hint count is spelled out", async () => {
    const eq = SETUP.replace("(snapshot puzzle.solution =)", "(snapshot puzzle.solution puzzle.eq)");
    const bad = await validatePuzzle(puzzle({ header: [...without(";@solution"), ";@solution swap guess"], setup: eq }), options);
    assert.match(find(bad, "solution:1").message, /the check compared \(3 2 1\) \(what the answer produced\) with \(1 2 3\) \(what the check expected\)/);
    const good = await validatePuzzle(puzzle({ setup: eq }), options);
    assert.equal(good.ok, true, formatReport(good));

    const hints = await validatePuzzle(puzzle({ header: [...without(";@hints"), ";@hints 3"] }), options);
    assert.match(find(hints, "hints").message, /change the header to ";@hints 1", or add 2 more text\(s\)/);
});

test("a missing wrong sample is only a warning", async () => {
    const report = await validatePuzzle(puzzle({ header: without(";@wrong") }), options);
    assert.equal(report.ok, true);
    assert.equal(find(report, "samples").level, "warning");
});

test("an endless loop inside a validator is stopped too, because the check runs under the budget", async () => {
    const setup = SETUP.replace("(snapshot puzzle.solution =)", `(${SPIN})`);
    const report = await validatePuzzle(puzzle({ setup }), options);
    assert.equal(report.ok, false);
    assert.match(find(report, "untouched").message, /step budget|did not work/);
});

test("all the playground's own puzzles are valid; typing the target is flagged only for the two that allow it", async () => {
    const warned = [];
    for (const file of PUZZLE_FILES) {
        const report = await validatePuzzle(readFileSync(join(here, "..", "examples", "puzzles", file), "utf8"), { file });
        assert.equal(report.ok, true, formatReport(report, file));
        if (find(report, "typable")) warned.push(file);
        assert.ok(report.metrics.bestKnownLength >= 1, file);
    }
    assert.deepEqual(warned, ["07-order-three.bo", "08-order-four.bo"]);
});

test("the report reads well for people", async () => {
    const text = formatReport(await validatePuzzle(puzzle({ header: [...without(";@solution"), ";@solution swap guess"] }), options), "x.bo");
    assert.match(text, /^x\.bo: INVALID/);
    assert.match(text, /ERROR +solution:1/);
    assert.match(formatReport(await validatePuzzle(puzzle(), options)), /valid \(best known answer: 1 token\(s\)\)/);
});

// ---------------------------------------------------------------- the command

test("the validate command exits 0 for a valid puzzle, 1 for an invalid one, 2 for bad usage, and can print JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "plus-validate-"));
    try {
        const good = join(dir, "good.bo");
        const bad = join(dir, "bad.bo");
        writeFileSync(good, puzzle());
        writeFileSync(bad, puzzle({ header: [";@hints 1"] }));
        const run = (...args) => spawnSync("node", [join(here, "validate.mjs"), ...args], { encoding: "utf8" });
        const ok = run(good);
        assert.equal(ok.status, 0, ok.stdout + ok.stderr);
        assert.match(ok.stdout, /good\.bo: valid/);
        assert.equal(run(good, bad).status, 1);
        assert.match(run(bad).stdout, /bad\.bo: INVALID/);
        assert.equal(run().status, 2);
        assert.equal(run("--budget", "x", good).status, 2);
        const json = JSON.parse(run("--json", good).stdout);
        assert.equal(json[0].ok, true);
        assert.equal(json[0].file, good);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
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
