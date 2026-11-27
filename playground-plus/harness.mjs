// Validates a puzzle file (see "Puzzle package" in doc/playground-plus.md) by running it on the real
// Bo machine, in WebAssembly (so its code cannot reach the host: the virtual file system is in
// memory). Every run is stepped with an op budget, so an endless loop is reported, not suffered.
//
// What is checked, and how each finding is reported, is described by `checks` in the result; a
// check with level "error" fails the puzzle, one with level "warning" is only advice.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBo } from "../wasm/bo.mjs";
import { parsePuzzle } from "../playground/puzzles.mjs";
import { answerLength } from "./tokens.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BUDGET = 200_000; // ops one run may execute
export const LIMITS = { source: 64 * 1024, title: 120, goal: 300, description: 4000 };
const RESULTS = ["missing", "wrong", "solved", "error"]; // the codes `guess` leaves on puzzle.last
const LIBRARY = "examples/puzzles/lib.bo";

/** The file text with line endings, trailing whitespace and the final newline made uniform. */
export function normalizeSource(text) {
    return `${text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n+$/, "")}\n`;
}

/** A puzzle's identity: the hash of its normalised text. Equal text, equal puzzle. */
export function puzzleId(text) {
    return createHash("sha256").update(normalizeSource(text)).digest("hex");
}

export const defaultFiles = () => ({ [LIBRARY]: readFileSync(join(ROOT, LIBRARY), "utf8") });
const clip = (text, max = 300) => (text.length > max ? `${text.slice(0, max)}...` : text).trim();

/** A fresh machine with the puzzle library available; `run` executes a program under the budget. */
export async function openMachine(files, budget) {
    let stdout = "";
    let stderr = "";
    const bo = await createBo({ onOutput: (text, stream) => (stream === "stdout" ? (stdout += text) : (stderr += text)) });
    for (const [path, text] of Object.entries(files)) bo.writeFile(path, text);
    return {
        bo,
        /** Runs `code`: {status: "done" | "error" | "paused" | "exit" | "unreadable", stdout, stderr}. */
        run(code) {
            stdout = stderr = "";
            if (!bo.debug.load(code)) return { status: "unreadable", stdout, stderr };
            const status = bo.debug.run(budget);
            return { status, stdout, stderr };
        },
        /** The result of the last `guess` (0 missing, 1 wrong, 2 solved, 3 error), or null if there was none. */
        result() {
            const items = bo.stack("puzzle.last")?.items;
            return items?.length ? Number(items.at(-1)[1]) : null;
        },
    };
}

const why = (run) => {
    if (run.status === "paused") return "it did not finish within the step budget (an endless loop?)";
    if (run.status === "unreadable" || run.status === "error") return `it failed: ${clip(run.stderr) || run.status}`;
    return `it ended with status ${run.status}`;
};

/** The default stack as `snapshot` shows it: bottom first, in parentheses. */
function stackText(machine) {
    const stack = machine.bo.stack("", { maxItems: 12, maxChars: 40 });
    if (!stack) return "(unknown)";
    return `(${stack.items.map(([, value]) => value).join(" ")}${stack.depth > stack.items.length ? " ..." : ""})`;
}

/** The default stack, but only when the puzzle's check is about it (otherwise what is on it is not the point). */
function stackNote(machine) {
    return machine.bo.stack("puzzle.required")?.items.at(-1)?.[1] === "()" ? stackText(machine) : null;
}

/**
 * Why a check did not accept: the first comparison made with `puzzle.eq` that failed, if the check
 * uses it, or else (for a check on the default stack) the stack the answer left.
 */
function failureDetail(machine) {
    const mismatch = machine.bo.stack("puzzle.mismatch", { maxItems: 2, maxChars: 60 });
    if (mismatch?.items.length === 2) {
        const [[, actual], [, expected]] = mismatch.items;
        return `the check compared ${actual} (what the answer produced) with ${expected} (what the check expected): one of them is wrong`;
    }
    const stack = stackNote(machine);
    return stack === null ? "" : `the default stack was then ${stack}, so check that your check accepts exactly that`;
}

/**
 * @param {string} text the puzzle file
 * @param {{file?: string, budget?: number, files?: Record<string, string>}} [options] `files` are the
 *   files the puzzle may include (by default the puzzle library); `budget` the ops one run may execute
 * @returns {Promise<{ok: boolean, id: string, puzzle: object|null, checks: object[], metrics: object}>}
 */
export async function validatePuzzle(text, { file = "puzzle.bo", budget = DEFAULT_BUDGET, files = defaultFiles() } = {}) {
    const checks = [];
    const check = (id, level, ok, message, details) => checks.push({ id, level, ok, message, ...(details ? { details } : {}) });
    const metrics = { solutionLengths: [], bestKnownLength: null };
    const result = (puzzle = null) => ({ ok: checks.every((c) => c.ok || c.level !== "error"), id: puzzleId(text), puzzle, checks, metrics });

    // 1. the header, and the limits
    let puzzle;
    try {
        puzzle = parsePuzzle(text, file);
    } catch (error) {
        check("header", "error", false, error.message);
        return result();
    }
    const problems = [];
    if (text.length > LIMITS.source) problems.push(`the file is longer than ${LIMITS.source} characters`);
    for (const field of ["title", "goal", "description"])
        if (puzzle[field].length > LIMITS[field]) problems.push(`the ${field} is longer than ${LIMITS[field]} characters`);
    if (!puzzle.solutions.length) problems.push("add at least one `;@solution` line (a prompt line that solves it)");
    if (!puzzle.tags.length) problems.push("add `;@tags` (for example `;@tags shuffle`)");
    if (puzzle.difficulty === null) problems.push("add `;@difficulty` from 1 to 5");
    for (const kind of ["solutions", "right", "wrong"])
        for (const line of puzzle[kind]) {
            try {
                answerLength(line);
            } catch (error) {
                problems.push(`the ${kind === "solutions" ? "solution" : kind} line "${clip(line, 60)}" is not valid Bo: ${error.message}`);
            }
        }
    check("header", "error", problems.length === 0, problems.length ? problems.join("; ") : "the header is complete");
    if (problems.length) return result(puzzle);
    if (!puzzle.wrong.length) check("samples", "warning", false, "add a `;@wrong` line: a plausible wrong answer shows the check is not too lenient");

    // 2. the setup
    const fresh = async () => openMachine(files, budget);
    const first = await fresh();
    const setup = first.run(text);
    if (setup.status !== "done") {
        check("setup", "error", false, `the setup did not run: ${why(setup)}`);
        return result(puzzle);
    }
    check("setup", "error", true, "the setup runs");
    const stackExists = (machine, name) => Boolean(machine.bo.stack(name));
    if (!stackExists(first, "puzzle.validator")) {
        check("protocol", "error", false, "the setup never calls `puzzle.require`, so `guess` has nothing to check");
        return result(puzzle);
    }

    // 3. hints and reveal, as the header and the runtime see them
    const hintCount = stackExists(first, "puzzle.hints") ? Number(first.run("(puzzle.hints) TOP len emit").stdout) : 0;
    check("hints", "error", hintCount === puzzle.hints,
        hintCount === puzzle.hints ? `${hintCount} hint(s), as declared` : `;@hints says ${puzzle.hints} but the setup defines ${hintCount}: change the header to ";@hints ${hintCount}", or ${hintCount < puzzle.hints ? `add ${puzzle.hints - hintCount} more text(s) to` : `remove ${hintCount - puzzle.hints} text(s) from`} the list pushed onto puzzle.hints`);
    const actualFree = stackExists(first, "puzzle.free") ? Number(first.run("(puzzle.free) TOP emit").stdout) : 0;
    if (puzzle.freeHints || actualFree)
        check("freehints", "error", actualFree === puzzle.freeHints,
            actualFree === puzzle.freeHints ? `${actualFree} free hint(s), as declared` : `;@freehints says ${puzzle.freeHints} but the setup pushes ${actualFree} onto puzzle.free`);
    if (!stackExists(first, "puzzle.reveal")) check("reveal", "warning", false, "no `puzzle.reveal` text: `reveal` will have nothing to show");

    // 4. the untouched puzzle must not already be solved
    const untouched = first.run("guess");
    const untouchedResult = first.result();
    if (untouched.status !== "done" || untouchedResult === null) check("untouched", "error", false, `\`guess\` on the untouched puzzle did not work: ${why(untouched)}`);
    else if (untouchedResult === 2) check("untouched", "error", false, `the puzzle is solved before the player does anything${stackNote(first) === null ? "" : ` (the default stack at the start is ${stackNote(first)})`}`);
    else if (untouchedResult === 3) check("untouched", "error", false, "the check raises an error on the untouched puzzle");
    else check("untouched", "error", true, `the untouched puzzle is not solved (${RESULTS[untouchedResult]})`);

    // 5. every answer line runs on its own fresh copy of the puzzle
    const answer = async (line) => {
        const machine = await fresh();
        const setupRun = machine.run(text);
        const run = setupRun.status === "done" ? machine.run(line) : setupRun;
        return { machine, run, result: machine.result() };
    };
    let firstSolutionStack = null;
    for (const [index, line] of puzzle.solutions.entries()) {
        const { machine, run, result: code } = await answer(line);
        const ok = run.status === "done" && code === 2;
        check(`solution:${index + 1}`, "error", ok, ok ? `"${clip(line, 60)}" solves it` : `the solution "${clip(line, 60)}" does not solve it: ${run.status !== "done" ? why(run) : `\`guess\` reported ${RESULTS[code] ?? "nothing"}${failureDetail(machine) ? `; ${failureDetail(machine)}` : ""}`}`);
        if (ok) {
            metrics.solutionLengths.push(answerLength(line));
            firstSolutionStack ??= machine.bo.stack("");
        }
    }
    metrics.bestKnownLength = metrics.solutionLengths.length ? Math.min(...metrics.solutionLengths) : null;
    for (const [index, line] of puzzle.right.entries()) {
        const { machine, run, result: code } = await answer(line);
        const ok = run.status === "done" && code === 2;
        check(`right:${index + 1}`, "error", ok, ok ? `"${clip(line, 60)}" is accepted` : `"${clip(line, 60)}" should be accepted but ${run.status !== "done" ? why(run) : `\`guess\` reported ${RESULTS[code] ?? "nothing"}${failureDetail(machine) ? `; ${failureDetail(machine)}` : ""}`}`);
        if (ok) metrics.bestKnownLength = Math.min(metrics.bestKnownLength ?? Infinity, answerLength(line));
    }
    for (const [index, line] of puzzle.wrong.entries()) {
        const { machine, run, result: code } = await answer(line);
        const hung = run.status === "paused";
        const ok = !hung && code !== 2;
        check(`wrong:${index + 1}`, "error", ok, ok ? `"${clip(line, 60)}" is rejected` : hung ? `the wrong sample "${clip(line, 60)}" ${why(run)}` : `"${clip(line, 60)}" is accepted but should be wrong: the check is too lenient${stackNote(machine) === null ? "" : ` (the default stack was then ${stackNote(machine)})`}`);
    }

    // 6. a warning if the answer can be reached by typing the final state (nothing enforces the steps)
    const items = firstSolutionStack?.items ?? [];
    if (firstSolutionStack && items.length && items.every(([kind, value]) => (kind === "n" || kind === "l") && !value.endsWith("…"))) {
        const probe = await answer(`clear ${items.map(([, value]) => value).join(" ")} guess`);
        if (probe.run.status === "done" && probe.result === 2)
            check("typable", "warning", false, "the answer can be reached by simply typing the final stack, so nothing enforces how it is reached (use a submitted program checked by the puzzle, or accept that the player can do this)");
    }
    return result(puzzle);
}

/** A short text for people: one line per check, then the verdict. */
export function formatReport(report, name = "puzzle") {
    const lines = report.checks.map((c) => `  ${c.ok ? "ok     " : c.level === "error" ? "ERROR  " : "warning"} ${c.id}: ${c.message}`);
    const best = report.metrics.bestKnownLength;
    return [`${name}: ${report.ok ? "valid" : "INVALID"}${best === null ? "" : ` (best known answer: ${best} token(s))`}`, ...lines].join("\n");
}
