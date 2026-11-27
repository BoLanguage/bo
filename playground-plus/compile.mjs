// Turns an agent's puzzle *spec* into a puzzle file (see "Puzzle specs" in doc/playground-plus.md).
//
// An agent writes the creative part (what to do, hints, tags) plus the data (the start stack or the
// test inputs, and a solution in Bo). Everything mechanical is done here: the file header, the check,
// the hint count, the reveal text, the expected results (found by running the solution on the real
// machine, so the agent never computes them), the difficulty and the title. What comes out is the same
// single Bo file the playground has always loaded, and the harness validates it like any other.
import { DEFAULT_BUDGET, defaultFiles, openMachine } from "./harness.mjs";
import { TAGS } from "./taxonomy.mjs";
import { answerLength } from "./tokens.mjs";

export { TAGS };

/** Kinds of puzzle. Only available ones are offered to agents. */
export const KINDS = {
    arrange: { available: true, summary: "rearrange or compute on a given stack; the player ends with a stack equal to what the solution leaves" },
    define: { available: true, summary: "define an op that turns each test input into the expected result" },
    predict: { available: false, summary: "the player says what a shown program leaves on the stack" },
    fix: { available: false, summary: "a broken definition is given and the player repairs it" },
    golf: { available: false, summary: "define an op with as few tokens as possible" },
    "named-stack": { available: false, summary: "leave values on named stacks" },
};
export const availableKinds = () => Object.keys(KINDS).filter((kind) => KINDS[kind].available);

export const SPEC_LIMITS = { goal: 300, hint: 300, hints: 3, tags: 3, solution: 300, op: 30, value: 1_000_000, stack: 12, cases: 8 };
const MIN_CASES = 3;
// hints that every puzzle of a kind starts with, and that do not count as help
const FREE_HINTS = {
    arrange: [],
    define: (op) => [`Define an op by pushing a quotation onto a stack with its name: (BODY) (${op}) PUSH. Then run guess.`],
};
// ops that show a tag was really used (only for the tags where that is clear)
const TAG_OPS = {
    shuffle: ["swap", "rot", "-rot", "over", "dup", "drop", "nip", "tuck", "roll", "pick"],
    arithmetic: ["+", "-", "*", "/", "//", "mod", "neg", "abs", "min", "max", "^"],
    conditional: ["ifte"],
    list: ["map", "filter", "foldl", "len", "nth"],
};
const ITERATION = ["ifte", "map", "filter", "foldl"];

/**
 * A machine error line with a pointer for what small models most often get wrong: an op that does not
 * exist (`if`, `then`, `rec`) and the order of `ifte`'s three quotations.
 */
export function explainFailure(line) {
    const missing = /Existence-Error \(EXECUTE\) \(\(([^()\s]+)\)\)/.exec(line)?.[1];
    if (missing) return `${line}. "${missing}" is not a Bo op (an op you are defining can call itself by its own name; conditions use ifte: (condition) (then) (else) ifte). get_bo_reference with the query "${missing}" searches the documentation`;
    if (/\(IFTE\)/.test(line)) return `${line}. ifte needs three quotations in this order: (condition) (then) (else) ifte, for example (dup 0 <) (neg) (nop) ifte; the condition runs on the value below them`;
    return line;
}

const clean = (text) => text.replace(/\s+/g, " ").trim();
const quote = (text) => `"${clean(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const isValue = (value) => Number.isInteger(value) && Math.abs(value) <= SPEC_LIMITS.value;
const literal = (value) => (Array.isArray(value) ? `(${value.map(String).join(" ")})` : String(value));
const stackLiteral = (stack) => stack.map(literal).join(" ");
/** The tokens of a piece of Bo (ops and numbers), without strings, parentheses or comments. */
const tokensOf = (code) => code.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/;[^\n]*/g, " ").replace(/[()]/g, " ").split(/\s+/).filter(Boolean);

/** A first estimate of difficulty (1 to 5) from the solution's size; real play data can correct it later. */
export function estimateDifficulty(kind, solution) {
    const tokens = tokensOf(solution);
    const size = tokens.length;
    const thresholds = kind === "arrange" ? [1, 2, 4, 6] : [2, 4, 7, 11];
    let level = 1 + thresholds.filter((limit) => size > limit).length;
    if (tokens.some((token) => ITERATION.includes(token))) level++;
    return Math.min(level, 5);
}

/** What the title says: the first tag, a number, and who wrote it. */
export function makeTitle(tags, number, agent) {
    const name = (agent ?? "").replace(/[^\w.:+\- ]/g, "").trim().slice(0, 40) || "agent";
    return `${tags[0][0].toUpperCase()}${tags[0].slice(1)} #${number} · ${name}`;
}

/** The spec as it will be used: trimmed texts, a solution without a final `guess`. Nothing here is validated. */
export function normalizeSpec(spec) {
    const text = (value) => (typeof value === "string" ? clean(value) : value);
    let solution = text(spec.solution);
    if (typeof solution === "string") solution = solution.replace(/\s*\bguess$/, "");
    const normal = { kind: spec.kind, tags: spec.tags, goal: text(spec.goal), inputs: spec.inputs, solution, hints: Array.isArray(spec.hints) ? spec.hints.map(text) : spec.hints };
    if (spec.op !== undefined) normal.op = text(spec.op);
    return normal;
}

/** Everything wrong with the shape of a spec, in the agent's terms (field names), all at once. */
function checkShape(spec) {
    const problems = [];
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["the puzzle must be an object with kind, tags, goal, inputs, solution and hints"];
    if (!Object.hasOwn(KINDS, spec.kind)) problems.push(`kind must be one of ${availableKinds().join(", ")}`);
    else if (!KINDS[spec.kind].available) problems.push(`kind "${spec.kind}" is not available yet; use one of ${availableKinds().join(", ")}`);
    if (!Array.isArray(spec.tags) || spec.tags.length < 1 || spec.tags.length > SPEC_LIMITS.tags || !spec.tags.every((tag) => TAGS.includes(tag)) || new Set(spec.tags).size !== spec.tags.length)
        problems.push(`tags must be 1 to ${SPEC_LIMITS.tags} different values from ${TAGS.join(", ")}; the first is the main topic`);
    if (typeof spec.goal !== "string" || spec.goal.length < 10 || spec.goal.length > SPEC_LIMITS.goal) problems.push(`goal must be a sentence of 10 to ${SPEC_LIMITS.goal} characters saying what the player must do`);
    if (typeof spec.solution !== "string" || !spec.solution.trim()) problems.push("solution must be the Bo ops that solve the puzzle");
    else if (spec.solution.length > SPEC_LIMITS.solution) problems.push(`solution is longer than ${SPEC_LIMITS.solution} characters`);
    else {
        try {
            answerLength(spec.solution);
        } catch (error) {
            problems.push(`solution is not valid Bo: ${error.message}`);
        }
        if (tokensOf(spec.solution).includes("guess")) problems.push("solution must not contain guess (it is added for you)");
    }
    if (!Array.isArray(spec.hints) || spec.hints.length < 1 || spec.hints.length > SPEC_LIMITS.hints || !spec.hints.every((hint) => typeof hint === "string" && hint.trim() && hint.length <= SPEC_LIMITS.hint))
        problems.push(`hints must be a list of 1 to ${SPEC_LIMITS.hints} texts of up to ${SPEC_LIMITS.hint} characters, from a gentle nudge to a strong one`);
    if (!Array.isArray(spec.inputs) || !spec.inputs.length) problems.push("inputs must be a list of stacks, each a list of whole numbers (or lists of whole numbers), bottom first");
    else {
        const bad = spec.inputs.findIndex((stack) => !Array.isArray(stack) || stack.length > SPEC_LIMITS.stack
            || !stack.every((value) => isValue(value) || (Array.isArray(value) && value.length <= SPEC_LIMITS.stack && value.every(isValue))));
        if (bad >= 0) problems.push(`inputs[${bad}] must be a list of up to ${SPEC_LIMITS.stack} whole numbers (|n| up to ${SPEC_LIMITS.value}) or lists of them`);
    }
    if (spec.kind === "arrange" && Array.isArray(spec.inputs) && spec.inputs.length > 1) problems.push("an arrange puzzle needs exactly one input: the stack the player starts with");
    if (spec.kind === "define") {
        if (typeof spec.op !== "string" || !/^[a-z][a-z0-9-]*$/.test(spec.op) || spec.op.length > SPEC_LIMITS.op)
            problems.push(`op must be the name of the op to define: lowercase letters, digits and hyphens, starting with a letter (at most ${SPEC_LIMITS.op} characters)`);
        if (Array.isArray(spec.inputs) && (spec.inputs.length < MIN_CASES || spec.inputs.length > SPEC_LIMITS.cases))
            problems.push(`a define puzzle needs ${MIN_CASES} to ${SPEC_LIMITS.cases} inputs, so that a hard-coded answer fails`);
    } else if (spec.op !== undefined) problems.push("op is only for define puzzles");
    return problems;
}

/**
 * @param {object} spec the agent's puzzle (see the guide)
 * @param {{agent?: string, number: number, files?: Record<string, string>, budget?: number}} options
 *   `number` is the puzzle's number in the player's list; `agent` goes in the title
 * @returns {Promise<{ok: boolean, problems: string[], warnings: string[], source: string|null, spec: object, derived: object|null}>}
 */
export async function compileSpec(spec, { agent = null, number, files = defaultFiles(), budget = DEFAULT_BUDGET }) {
    const result = (problems, extra = {}) => ({ ok: problems.length === 0, problems, warnings: extra.warnings ?? [], source: extra.source ?? null, spec: normalized, derived: extra.derived ?? null });
    const normalized = spec && typeof spec === "object" && !Array.isArray(spec) ? normalizeSpec(spec) : spec;
    const shape = checkShape(normalized);
    if (shape.length) return result(shape);

    const { kind, tags, goal, inputs, solution, hints } = normalized;
    const op = normalized.op;
    const warnings = [];
    const problems = [];

    // 1. run the solution to find what it leaves, which is what the player must leave
    const machine = await openMachine(files, budget);
    const setup = machine.run('"include/std.bo" require\n"examples/puzzles/lib.bo" require');
    if (setup.status !== "done") return result([`the puzzle library did not load: ${setup.stderr || setup.status}`]);
    const outcome = (run) => {
        if (run.status === "paused") return { error: "did not finish within the step budget (an endless loop?)" };
        if (run.status !== "done") return { error: `failed: ${explainFailure(run.stderr.trim().split("\n")[0] || run.status)}` };
        if (!/^[-\d() ]*$/.test(run.stdout)) return { error: `left something that is not a whole number or a list of whole numbers: ${run.stdout.slice(0, 60)}` };
        return { out: run.stdout };
    };
    /** Moves the outcomes into `results`, or says what went wrong: once if it went the same way on every input. */
    const collect = (outcomes) => {
        const errors = outcomes.map((o, index) => (o.error ? { index, error: o.error } : null)).filter(Boolean);
        if (errors.length > 1 && errors.length === outcomes.length && errors.every((e) => e.error === errors[0].error)) problems.push(`the solution run on every input ${errors[0].error}`);
        else for (const { index, error } of errors) problems.push(`the solution run on inputs[${index}], ${error}`);
        if (!errors.length) results.push(...outcomes.map((o) => o.out));
    };
    const results = [];
    if (kind === "arrange") {
        collect([outcome(machine.run(`${stackLiteral(inputs[0])} ${solution} snapshot emit`))]);
        if (results.length) {
            const start = `(${stackLiteral(inputs[0])})`;
            if (results[0] === "()") problems.push("the solution leaves nothing on the stack; a puzzle needs a result to check");
            else if (results[0] === start) problems.push("the solution leaves the stack as it started, so there is nothing to solve");
        }
    } else {
        if (machine.run(`(${op}) EXISTS emit`).stdout !== "0") problems.push(`op "${op}" already exists in Bo; choose another name`);
        else {
            const defined = machine.run(`(${solution}) (${op}) PUSH`);
            if (defined.status !== "done") problems.push(`the solution could not be defined: ${explainFailure(defined.stderr.trim().split("\n")[0] || defined.status)}`);
            else collect(inputs.map((stack) => outcome(machine.run(`clear ${stackLiteral(stack)} ${op} snapshot emit`))));
        }
        if (results.length) {
            const ins = inputs.map((stack) => `(${stackLiteral(stack)})`);
            const shown = inputs.slice(0, 4).map((stack, index) => `${stackLiteral(stack)} ${op} -> ${results[index]}`).join("; ");
            if (new Set(ins).size !== ins.length) problems.push("inputs must all be different");
            if (results.every((r, index) => r === ins[index])) problems.push(`every input comes out unchanged (${shown}), so doing nothing would pass. Check that your solution does what the goal says, or choose inputs that the op changes`);
            else if (new Set(results).size === 1) problems.push(`every input gives ${results[0]} (${shown}), so an op that ignores its input would pass. Check that your solution does what the goal says, or choose inputs with different results`);
        }
    }
    if (problems.length) return result(problems);

    // 2. the hints, free ones first
    const free = typeof FREE_HINTS[kind] === "function" ? FREE_HINTS[kind](op) : FREE_HINTS[kind];
    const allHints = [...free, ...hints];
    const solutionText = clean(solution);
    if (solutionText.length >= 4 && hints.some((hint) => clean(hint).includes(solutionText))) warnings.push("a hint contains the whole solution; hints should help without giving it away");
    if (kind === "define" && !goal.includes(op)) warnings.push(`the goal does not mention the op "${op}", so the player may not know what to define`);
    for (const tag of tags)
        if (TAG_OPS[tag] && !tokensOf(solution).some((used) => TAG_OPS[tag].includes(used))) warnings.push(`tag "${tag}" is claimed but the solution uses none of its usual ops (${TAG_OPS[tag].slice(0, 4).join(" ")} ...)`);

    // 3. the file
    const title = makeTitle(tags, number, agent);
    const difficulty = estimateDifficulty(kind, solution);
    const strip = (text) => text.slice(1, -1);
    let description;
    let solutionLine;
    let wrongLines;
    let require;
    let start = "";
    if (kind === "arrange") {
        description = [`The stack starts as \`${stackLiteral(inputs[0])}\` (the last value is on top). Leave it as \`${strip(results[0])}\`.`];
        solutionLine = `${solution} guess`;
        wrongLines = ["clear guess"];
        require = `() (snapshot (${strip(results[0])}) puzzle.eq) puzzle.require`;
        start = stackLiteral(inputs[0]);
    } else {
        const shown = inputs.slice(0, 2).map((stack, index) => `\`${stackLiteral(stack)} ${op}\` leaves ${strip(results[index]) ? `\`${strip(results[index])}\`` : "nothing"}`);
        description = [`For example, ${shown.join(" and ")}.`, `Push a quotation onto \`${op}\`.`];
        solutionLine = `(${solution}) (${op}) PUSH guess`;
        wrongLines = [`() (${op}) PUSH guess`];
        const sameLength = inputs.every((stack) => stack.length === inputs[0].length);
        if (sameLength) wrongLines.push(`(${"drop ".repeat(inputs[0].length)}${strip(results[0])}) (${op}) PUSH guess`);
        const cases = inputs.map((stack, index) => `clear ${stackLiteral(stack)} ${op} snapshot ${results[index]} puzzle.eq drop`).join(" ");
        require = `(${op}) (${cases} (puzzle.mismatch) DEPTH 0 =) puzzle.require`;
    }
    const lines = [
        ";@puzzle", `;@title ${title}`, `;@goal ${goal}`, `;@hints ${allHints.length}`, ...(free.length ? [`;@freehints ${free.length}`] : []),
        `;@tags ${tags.join(" ")}`, `;@difficulty ${difficulty}`, `;@solution ${solutionLine}`, ...wrongLines.map((line) => `;@wrong ${line}`),
        ";@description", ...[...description, "Run `guess` to check your solution."].map((line) => `; ${line}`), ";@enddescription", ";@end", "",
        '"include/std.bo" require', '"examples/puzzles/lib.bo" require', "",
        require, ...(start ? [start] : []),
        `(${allHints.map(quote).join(" ")}) (puzzle.hints) PUSH`,
        ...(free.length ? [`${free.length} (puzzle.free) PUSH`] : []),
        `${quote(solutionLine)} (puzzle.reveal) PUSH`, "",
    ];
    return result([], { warnings, source: lines.join("\n"), derived: { title, difficulty, tags, results, freeHints: free.length } });
}
