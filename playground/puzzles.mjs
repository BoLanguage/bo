// Puzzle files are ordinary Bo source with a short, machine-readable comment header. Only this
// inventory is kept here because a static browser cannot list examples/puzzles/ by itself.
export const PUZZLE_FILES = [
    "01-answer-stack.bo",
    "02-define-double.bo",
    "03-absolute-value.bo",
    "04-map-squares.bo",
    "05-filter-evens.bo",
    "06-odd-square-total.bo",
    "07-order-three.bo",
    "08-order-four.bo",
    "09-submit-stack-program.bo",
];
export const PUZZLE_SUPPORT_FILES = ["lib.bo"];

/**
 * The playground's own puzzles: the files listed above, fetched from `baseUrl` with `fetchText(url)`.
 *
 * A puzzle provider is any object with `load()` resolving to `{puzzles, files}`: the puzzles (the
 * header fields of parsePuzzle plus a unique `id` and the Bo `source` that sets the puzzle up) and
 * the files to add to the machine's virtual file system. An application built on the playground
 * can supply its own provider (see config.mjs).
 */
export function createStaticPuzzleProvider(baseUrl, fetchText) {
    return {
        async load() {
            const puzzles = [];
            const files = {};
            for (const file of PUZZLE_FILES) {
                const source = await fetchText(new URL(file, baseUrl));
                files[`examples/puzzles/${file}`] = source;
                puzzles.push({ ...parsePuzzle(source, file), id: file, source });
            }
            for (const file of PUZZLE_SUPPORT_FILES)
                files[`examples/puzzles/${file}`] = await fetchText(new URL(file, baseUrl));
            return { puzzles, files };
        },
    };
}

const required = ["title", "goal"];
const TAG = /^[a-z][a-z0-9-]{0,29}$/;
const MAX_TAGS = 8;
const MAX_PROMPT_LINE = 500;
const MAX_PROMPT_LINES = 20;

/**
 * Reads a puzzle's `;@puzzle` header; the rest of the file remains executable Bo source. The
 * playground presents the title, goal, description, hint count (`;@freehints N` of which the first N
 * cost nothing, at most 2) and hidden stacks. The other
 * directives describe the puzzle for an application that checks or records it: `;@tags` (concept
 * tags), `;@difficulty` (1 to 5, the author's claim), `;@solution` (a reference prompt line, several
 * allowed), and `;@right` / `;@wrong` (sample prompt lines that must, or must not, solve it).
 */
export function parsePuzzle(source, file) {
    const lines = source.split(/\r?\n/);
    if (lines[0] !== ";@puzzle") throw new Error(`${file}: first line must be ;@puzzle`);

    const puzzle = {
        file, title: "", goal: "", description: "", hints: 0, freeHints: 0, hiddenStacks: [],
        tags: [], difficulty: null, solutions: [], right: [], wrong: [],
    };
    let ended = false;
    for (let index = 1; index < lines.length; index++) {
        const line = lines[index];
        if (line === ";@end") {
            ended = true;
            break;
        }
        if (line === "") continue;
        const directive = /^;@(title|goal|description|hints|freehints|hide|tags|difficulty|solution|right|wrong)(?: (.*))?$/.exec(line);
        if (!directive) throw new Error(`${file}:${index + 1}: invalid puzzle header directive`);
        const [, name, value = ""] = directive;
        const where = `${file}:${index + 1}`;
        if (name === "hide") {
            if (!value) throw new Error(`${where}: hide requires a stack name`);
            puzzle.hiddenStacks.push(value);
        } else if (name === "tags") {
            for (const tag of value.split(/\s+/).filter(Boolean)) {
                if (!TAG.test(tag)) throw new Error(`${where}: a tag is lowercase letters, digits and hyphens, starting with a letter`);
                if (!puzzle.tags.includes(tag)) puzzle.tags.push(tag);
            }
            if (!value.trim()) throw new Error(`${where}: tags requires at least one tag`);
            if (puzzle.tags.length > MAX_TAGS) throw new Error(`${where}: at most ${MAX_TAGS} tags`);
        } else if (name === "difficulty") {
            if (puzzle.difficulty !== null) throw new Error(`${where}: difficulty given twice`);
            if (!/^[1-5]$/.test(value)) throw new Error(`${where}: difficulty must be a whole number from 1 to 5`);
            puzzle.difficulty = Number(value);
        } else if (name === "solution" || name === "right" || name === "wrong") {
            // a prompt line to run after the puzzle's setup (the reference solution, or a sample answer)
            if (!value.trim()) throw new Error(`${where}: ${name} requires a line of Bo`);
            if (value.length > MAX_PROMPT_LINE) throw new Error(`${where}: ${name} is longer than ${MAX_PROMPT_LINE} characters`);
            const list = name === "solution" ? puzzle.solutions : puzzle[name];
            if (list.length >= MAX_PROMPT_LINES) throw new Error(`${where}: at most ${MAX_PROMPT_LINES} ${name} lines`);
            list.push(value);
        } else if (name === "description" && !value) {
            const description = [];
            while (++index < lines.length && lines[index] !== ";@enddescription") {
                const descriptionLine = /^;(?: ?(.*))?$/.exec(lines[index]);
                if (!descriptionLine) throw new Error(`${file}:${index + 1}: description lines must be comments`);
                description.push(descriptionLine[1]);
            }
            if (index === lines.length) throw new Error(`${file}: description is missing ;@enddescription`);
            puzzle.description = description.join("\n").trim();
        } else {
            if (!value) throw new Error(`${file}:${index + 1}: ${name} requires text`);
            if (name === "hints") {
                if (!/^\d+$/.test(value)) throw new Error(`${file}:${index + 1}: hints must be a non-negative integer`);
                puzzle.hints = Number(value);
            } else if (name === "freehints") {
                if (!/^[0-2]$/.test(value)) throw new Error(`${where}: freehints must be 0, 1 or 2`);
                puzzle.freeHints = Number(value);
            } else puzzle[name] = value;
        }
    }
    if (!ended) throw new Error(`${file}: puzzle header is missing ;@end`);
    if (puzzle.freeHints > puzzle.hints) throw new Error(`${file}: freehints (${puzzle.freeHints}) is more than hints (${puzzle.hints})`);
    for (const name of required) {
        if (!puzzle[name]) throw new Error(`${file}: puzzle header is missing ${name}`);
    }
    return puzzle;
}
