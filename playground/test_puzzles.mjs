// Runs a puzzle's setup, an empty guess, and its intended prompt solution under the WebAssembly runtime.
// Usage: node playground/test_puzzles.mjs  (after make -C c wasm)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBo } from "../wasm/bo.mjs";
import { PUZZLE_FILES, PUZZLE_SUPPORT_FILES, createStaticPuzzleProvider, parsePuzzle } from "./puzzles.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => readFileSync(join(root, "examples", "puzzles", file), "utf8");
const answerPuzzle = source("01-answer-stack.bo");
const doublePuzzle = source("02-define-double.bo");
const absolutePuzzle = source("03-absolute-value.bo");
const squaresPuzzle = source("04-map-squares.bo");
const evensPuzzle = source("05-filter-evens.bo");
const oddSquareTotalPuzzle = source("06-odd-square-total.bo");
const orderThreePuzzle = source("07-order-three.bo");
const orderFourPuzzle = source("08-order-four.bo");
const submittedProgramPuzzle = source("09-submit-stack-program.bo");
const puzzleLibrary = source("lib.bo");

const answerInfo = parsePuzzle(answerPuzzle, "01-answer-stack.bo");
assert.deepEqual(answerInfo, {
    file: "01-answer-stack.bo",
    title: "First stack: store the answer",
    goal: "Put a value on a named stack",
    description: "Put 42 on the `ANSWER` stack, then run `guess` to check it.",
    hints: 1,
    freeHints: 0,
    hiddenStacks: [],
    tags: ["named-stack"],
    difficulty: 1,
    solutions: ["42 (ANSWER) PUSH guess"],
    right: ["6 7 * (ANSWER) PUSH guess"],
    wrong: ["41 (ANSWER) PUSH guess"],
});
assert.equal(PUZZLE_FILES.length, 9);

// the directives that describe a puzzle for tools: tags, difficulty, solution and sample answers
const described = parsePuzzle([
    ";@puzzle", ";@title T", ";@goal G",
    ";@tags shuffle quotation", ";@tags shuffle named-stack", ";@difficulty 3",
    ";@solution rot guess", ";@solution swap rot guess", ";@right rot swap swap guess", ";@wrong guess", ";@wrong dup guess",
    ";@end",
].join("\n"), "d.bo");
assert.deepEqual(
    [described.tags, described.difficulty, described.solutions, described.right, described.wrong],
    [["shuffle", "quotation", "named-stack"], 3, ["rot guess", "swap rot guess"], ["rot swap swap guess"], ["guess", "dup guess"]]);
const header = (...lines) => [";@puzzle", ";@title T", ";@goal G", ...lines, ";@end"].join("\n");
assert.equal(parsePuzzle(header(";@hints 3", ";@freehints 2"), "f.bo").freeHints, 2);
for (const [lines, message] of [
    [[";@hints 3", ";@freehints 3"], /freehints must be 0, 1 or 2/],
    [[";@hints 3", ";@freehints many"], /freehints must be 0, 1 or 2/],
    [[";@hints 1", ";@freehints 2"], /freehints \(2\) is more than hints \(1\)/],
    [[";@freehints 1"], /freehints \(1\) is more than hints \(0\)/],
]) assert.throws(() => parsePuzzle(header(...lines), "bad.bo"), message, lines.join(" "));
for (const [line, message] of [
    [";@tags", /tags requires at least one tag/],
    [";@tags Shuffle", /a tag is lowercase/],
    [";@tags 1up", /a tag is lowercase/],
    [";@tags a b c d e f g h i", /at most 8 tags/],
    [";@difficulty 6", /from 1 to 5/],
    [";@difficulty easy", /from 1 to 5/],
    [";@solution", /solution requires a line of Bo/],
    [`;@wrong ${"x".repeat(501)}`, /longer than 500/],
]) assert.throws(() => parsePuzzle(header(line), "bad.bo"), message, line);
assert.throws(() => parsePuzzle(header(";@difficulty 2", ";@difficulty 3"), "bad.bo"), /given twice/);
assert.throws(() => parsePuzzle(header(...Array.from({ length: 21 }, () => ";@right 1")), "bad.bo"), /at most 20 right lines/);

async function play(source, commands) {
    let stdout = "";
    let stderr = "";
    const bo = await createBo({
        autoload: "include/core.bo",
        onOutput: (text, stream) => (stream === "stdout" ? (stdout += text) : (stderr += text)),
    });
    bo.writeFile("examples/puzzles/lib.bo", puzzleLibrary);
    assert.equal(bo.eval(source), true, stderr);
    for (const [command, expected] of commands) {
        stdout = "";
        assert.equal(bo.eval(command), true, `${command}: ${stderr}`);
        assert.match(stdout, expected);
    }
    assert.equal(stderr, "");
}

await play(answerPuzzle, [
    ["guess", /The required stack has not been created yet\./],
    ["42 (ANSWER) PUSH guess", /Solved\./],
]);
await play(answerPuzzle, [
    ["hint", /Put a value on ANSWER with VALUE \(ANSWER\) PUSH\./],
    ["42 (ANSWER) PUSH guess", /Solved after using a hint\./],
]);
// the first `puzzle.free` hints cost nothing: only a later one makes a solve "after using a hint"
const freeHintPuzzle = `${answerPuzzle}\n("one" "two") (puzzle.hints) PUSH\n1 (puzzle.free) PUSH\n`;
await play(freeHintPuzzle, [
    ["hint", /one/],
    ["(puzzle.hint-used) DEPTH emit", /0/],
    ["42 (ANSWER) PUSH guess", /Solved\./],
]);
await play(freeHintPuzzle, [
    ["hint hint", /two/],
    ["(puzzle.hint-used) DEPTH emit (puzzle.hint-shown) DEPTH emit", /12/],
    ["hint", /two/],
    ["42 (ANSWER) PUSH guess", /Solved after using a hint\./],
]);
// puzzle.eq is `=` that also keeps the first differing pair for tools that check puzzles
await play(answerPuzzle, [
    ["3 3 puzzle.eq emit", /1/],
    ["10 0 puzzle.eq emit", /0/],
    ["5 6 puzzle.eq drop (puzzle.mismatch) TOP emit", /0/],
    ["(puzzle.mismatch) DEPTH emit", /2/],
    ["7 (ANSWER) PUSH guess (puzzle.mismatch) DEPTH emit", /0/],
]);
await play(doublePuzzle, [
    ["guess", /The required stack has not been created yet\./],
    ["(2 *) (twicer) PUSH guess", /Solved\./],
]);
await play(absolutePuzzle, [
    ["((dup 0 <) (neg) (nop) ifte) (absolute) PUSH guess", /Solved\./],
]);
await play(absolutePuzzle, [
    ["99 (drop drop) (absolute) PUSH guess", /That definition raised an error while being checked\./],
    ["snapshot emit", /\(99\)/],
    ["((dup 0 <) (neg) (nop) ifte) (absolute) PUSH guess", /Solved\./],
]);
await play(squaresPuzzle, [
    ["((apply dup * unit) map) (squares) PUSH guess", /Solved\./],
]);
await play(evensPuzzle, [
    ["((apply 2 mod 0 =) filter) (evens) PUSH guess", /Solved\./],
]);
await play(oddSquareTotalPuzzle, [
    ["((apply 2 mod 1 =) filter (apply dup * unit) map 0 (apply +) foldl) (odd-square-total) PUSH guess", /Solved\./],
]);
await play(orderThreePuzzle, [
    ["rot guess", /Solved\./],
]);
await play(orderFourPuzzle, [
    ["swap rot guess", /Solved\./],
]);
await play(submittedProgramPuzzle, [
    ["nip rot apply 4 roll snapshot emit", /\(1 2 3 4 5\)/],
    ["(nip rot apply 4 roll) (solution) PUSH guess", /Solved in 4 operations\./],
    ["snapshot emit", /\(1 2 3 4 5\)/],
    ["restart snapshot emit", /\(5 \(3 4\) 1 3 2\)/],
]);

// hints are ordered levels, repeating the last one; reveal gives up and is reported by a later guess
const hintedPuzzle = `
"include/std.bo" require
"examples/puzzles/lib.bo" require
(7) (puzzle.solution) PUSH
(ANSWER) ((ANSWER) TOP puzzle.solution =) puzzle.require
("first hint" "second hint") (puzzle.hints) PUSH
"7 (ANSWER) PUSH guess" (puzzle.reveal) PUSH
`;
await play(hintedPuzzle, [
    ["hint", /^first hint$/],
    ["hint", /^second hint$/],
    ["hint", /^second hint$/],
    ["reveal", /^7 \(ANSWER\) PUSH guess$/],
    ["7 (ANSWER) PUSH guess", /Solved after revealing the solution\./],
]);
await play(`"include/std.bo" require\n"examples/puzzles/lib.bo" require`, [
    ["hint", /No hint is available for this puzzle\./],
    ["reveal", /No solution is available for this puzzle\./],
]);

// the runtime records the play on hidden stacks: every guess's result, and one item per hint
await play(hintedPuzzle, [
    ["(puzzle.last) EXISTS emit", /^0$/],
    ["guess", /The required stack has not been created yet\./],
    ["hint", /^first hint$/],
    ["hint", /^second hint$/],
    ["7 (ANSWER) PUSH guess", /Solved after using a hint\./],
    ["(puzzle.last) DEPTH emit", /^2$/],
    ["(puzzle.last) TOP emit", /^2$/],
    ["(puzzle.hint-used) DEPTH emit", /^2$/],
]);

// every puzzle declares as many hints as it defines, and a solution to reveal
for (const file of PUZZLE_FILES) {
    const text = source(file);
    await play(text, [
        ["(puzzle.hints) TOP len emit", new RegExp(`^${parsePuzzle(text, file).hints}$`)],
        ["(puzzle.reveal) EXISTS emit", /^1$/],
    ]);
}

// the built-in provider returns every puzzle with its source, plus the files the puzzles include
const provided = await createStaticPuzzleProvider(new URL("file:///puzzles/"), async (url) =>
    source(url.pathname.slice("/puzzles/".length))).load();
assert.deepEqual(provided.puzzles.map((p) => p.id), PUZZLE_FILES);
assert.equal(provided.puzzles[0].source, answerPuzzle);
assert.equal(provided.puzzles[0].title, answerInfo.title);
assert.deepEqual(Object.keys(provided.files).sort(), [
    ...PUZZLE_FILES, ...PUZZLE_SUPPORT_FILES,
].map((file) => `examples/puzzles/${file}`).sort());
assert.equal(provided.files["examples/puzzles/lib.bo"], puzzleLibrary);
