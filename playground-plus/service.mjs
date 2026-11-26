// Playground+'s operations, independent of how they are reached (MCP, HTTP, tests): validate and
// submit puzzles, describe the player, and hand out the guide an agent needs. Agents never get SQL
// or the file system; they get exactly these functions.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUZZLE_FILES, parsePuzzle } from "../playground/puzzles.mjs";
import { describeStacks } from "./agent-player.mjs";
import { formatBrief, makeBrief } from "./brief.mjs";
import { compileSpec, normalizeSpec } from "./compile.mjs";
import { LIMITS, formatReport, normalizeSource, validatePuzzle } from "./harness.mjs";
import { topLevelTokens } from "./tokens.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REFERENCES = {
    language: "doc/language.md",
    library: "doc/library.md",
    primitives: "doc/primitives.md",
    examples: "doc/examples.md",
};
const DAY = 24 * 60 * 60 * 1000;
export const REFERENCE_LIMIT = 14000; // characters of a reference one call returns (the language reference is returned whole)

/**
 * What makes a puzzle that puzzle, whatever its wording: the solution lines and the setup code with
 * comments and text stripped. Two puzzles with the same essence differ only in title, goal,
 * description, hints and reveal text.
 */
export function essence(source) {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const end = lines.indexOf(";@end");
    const solutions = lines.slice(0, Math.max(end, 0)).filter((line) => line.startsWith(";@solution ")).sort().join("\n");
    const body = lines.slice(end + 1).join("\n");
    let tokens;
    try {
        tokens = topLevelTokens(body);
    } catch {
        tokens = body.split(/\s+/); // not readable as Bo: compare it as plain words
    }
    return `${solutions}\n${tokens.map((token) => token.replace(/"(?:[^"\\]|\\.)*"/g, '""')).join(" ")}`;
}

/** The headings of a markdown document, one per line. */
const outline = (text) => text.split("\n").filter((line) => /^#{1,6} /.test(line)).join("\n");

/**
 * The entries of a markdown document that mention `query`: table rows and paragraphs, each under its
 * heading, up to `limit` characters. Returns the text and how many matched.
 */
function searchDocument(text, query, limit) {
    const blocks = [];
    let heading = "";
    let paragraph = [];
    const flush = () => {
        if (paragraph.length) blocks.push({ heading, text: paragraph.join("\n") });
        paragraph = [];
    };
    for (const line of text.split("\n")) {
        if (/^#{1,6} /.test(line)) {
            flush();
            heading = line;
        } else if (line.startsWith("|")) {
            flush();
            if (!/^\|[-| :]+\|$/.test(line)) blocks.push({ heading, text: line });
        } else if (!line.trim()) flush();
        else paragraph.push(line);
    }
    flush();
    const needle = query.toLowerCase();
    const hits = blocks.filter((block) => block.text.toLowerCase().includes(needle));
    let out = "";
    let shown = 0;
    let last = null;
    for (const hit of hits) {
        const piece = `${hit.heading !== last ? `\n${hit.heading || "(introduction)"}\n` : ""}${hit.text}\n`;
        if (out.length + piece.length > limit) break;
        out += piece;
        last = hit.heading;
        shown++;
    }
    return { text: out.trim(), shown, total: hits.length };
}

const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const average = (values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);

/**
 * Counts and rates for a group of sessions; "open" ones are still being played (or will count as abandoned).
 * A person who walks away from a puzzle has not failed it, but an agent that ran out of time or turns has
 * (`abandonedIsFailure`).
 */
function summarize(sessions, abandonedIsFailure = false) {
    const count = (outcome) => sessions.filter((s) => s.outcome === outcome).length;
    const solved = sessions.filter((s) => s.outcome === "solved");
    const finished = sessions.filter((s) => s.outcome !== null && (abandonedIsFailure || s.outcome !== "abandoned")).length;
    return {
        sessions: sessions.length,
        solved: solved.length,
        revealed: count("revealed"),
        skipped: count("skipped"),
        abandoned: count("abandoned"),
        open: sessions.filter((s) => s.outcome === null).length,
        solveRate: finished ? Math.round((solved.length / finished) * 100) / 100 : null,
        medianSolveSeconds: median(solved.map((s) => Math.round(s.durationMs / 1000))),
        averageHintsOnSolved: average(solved.map((s) => s.hints)),
        averageGuessesOnSolved: average(solved.map((s) => s.guesses)),
    };
}

/** The sessions that were the first on their puzzle, in the order given (newest first): later plays are practice. */
function firstPlays(sessions) {
    const firstOf = new Map();
    for (const session of sessions) if (!firstOf.has(session.puzzleId) || session.startedAt < firstOf.get(session.puzzleId).startedAt) firstOf.set(session.puzzleId, session);
    return sessions.filter((s) => firstOf.get(s.puzzleId) === s);
}

/** Sessions grouped by what `key` returns for each (a list), each group described by `describe`, in key order. */
function groupSummaries(sessions, key, describe) {
    const groups = new Map();
    for (const session of sessions) for (const k of key(session)) groups.set(k, [...(groups.get(k) ?? []), session]);
    return Object.fromEntries([...groups].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, list]) => [k, describe(list)]));
}

const NOT_A_GUESS_AT_THE_ANSWER = new Set(["guess", "hint", "reveal"]);
/** How many words each session's prompt lines held (the unit of tokens.mjs), without the words that only check or ask for help. */
function wordsTyped(promptLines) {
    const words = new Map();
    for (const { sessionId, code } of promptLines) {
        let tokens;
        try {
            tokens = topLevelTokens(code);
        } catch {
            tokens = code.split(/\s+/).filter(Boolean); // not valid Bo: count what was typed anyway
        }
        words.set(sessionId, (words.get(sessionId) ?? 0) + tokens.filter((t) => !NOT_A_GUESS_AT_THE_ANSWER.has(t)).length);
    }
    return words;
}

/**
 * @param {{repository: object, validate?: Function, now?: () => number, root?: string}} options
 */
export function createService({ repository, validate = validatePuzzle, now = Date.now, root = ROOT }) {
    const read = (path) => readFileSync(join(root, path), "utf8");

    /** The titles, goals and essences of puzzles that exist outside the database: the playground's own and the guide's examples. */
    let fixed = null;
    const fixedPuzzles = async () => {
        if (fixed) return fixed;
        const found = [];
        for (const file of PUZZLE_FILES) {
            const source = read(`examples/puzzles/${file}`);
            const info = parsePuzzle(source, file);
            found.push({ title: info.title, goal: info.goal, essence: essence(source), origin: `the playground's puzzle "${info.title}"` });
        }
        for (const [, example] of read("playground-plus/guide.md").matchAll(/```spec\n([\s\S]*?)```/g)) {
            const spec = JSON.parse(example);
            const compiled = await compileSpec(spec, { agent: "guide", number: 0 });
            if (!compiled.ok) throw new Error(`a guide example does not compile: ${compiled.problems.join("; ")}`);
            found.push({ title: "", goal: spec.goal, essence: essence(compiled.source), specKey: specKey(compiled.spec), origin: `the guide's ${spec.kind} example "${clean(spec.goal).slice(0, 50)}"` });
        }
        fixed = found;
        return fixed;
    };
    const plain = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const clean = (text) => text.replace(/\s+/g, " ").trim();
    /** What makes a spec that puzzle, whatever its words: its kind, inputs, solution and word. */
    const specKey = (spec) => JSON.stringify([spec.kind, spec.inputs, spec.solution, spec.word ?? null]);

    /** A puzzle already known (guide example or stored) with the same spec essence, or null. */
    async function findSpecDuplicate(spec) {
        const key = specKey(spec);
        const example = (await fixedPuzzles()).find((k) => k.specKey === key);
        if (example) return example.origin;
        for (const { id, title } of repository.listPuzzleSummaries()) {
            const stored = repository.getPuzzle(id).package.spec;
            if (stored && specKey(stored) === key) return `the existing puzzle "${title}"`;
        }
        return null;
    }

    /** An existing puzzle (other than this very text) with the same title or goal, or the same essence, as `{origin, reason}`, or null. */
    async function findDuplicate(puzzle, id, source) {
        const mine = essence(source);
        const known = [
            ...await fixedPuzzles(),
            ...repository.listPuzzleSummaries().filter((p) => p.id !== id).map((p) => ({
                title: p.title, goal: p.goal, essence: essence(repository.getPuzzle(p.id).source), origin: `the existing puzzle "${p.title}"`,
            })),
        ];
        for (const k of known) {
            if ((k.title && plain(k.title) === plain(puzzle.title)) || plain(k.goal) === plain(puzzle.goal)) return { origin: k.origin, reason: "its title or goal is the same" };
            if (k.essence === mine) return { origin: k.origin, reason: "its setup and solutions are the same, only the wording differs" };
        }
        return null;
    }

    /**
     * Checks a puzzle file without storing it. Oversized input is refused before anything is parsed or
     * run. A puzzle that copies the title or goal of an existing one (or of a guide example) is refused:
     * copying an example proves nothing, and the player has seen it.
     */
    async function validatePuzzleText(source) {
        if (typeof source !== "string" || !source.trim()) throw new Error("source must be the puzzle file's text");
        if (source.length > LIMITS.source * 2)
            return { ok: false, id: null, puzzle: null, checks: [{ id: "header", level: "error", ok: false, message: `the file is far longer than ${LIMITS.source} characters` }], metrics: {} };
        const report = await validate(source);
        if (!report.puzzle) return report;
        const duplicate = await findDuplicate(report.puzzle, report.id, source);
        report.checks.push(duplicate
            ? { id: "novelty", level: "error", ok: false, message: `${duplicate.reason} as in ${duplicate.origin}. Write a new puzzle with a different idea; the examples only show the structure` }
            : { id: "novelty", level: "error", ok: true, message: "it is not a copy of an existing puzzle or example" });
        report.ok = report.checks.every((c) => c.ok || c.level !== "error");
        return report;
    }

    /**
     * Compiles an agent's spec into a puzzle file and validates that. The report is in the agent's terms:
     * `problems` (about the spec itself, found before anything is built), then the harness checks.
     */
    async function validateSpec(spec, { client = null, model = null } = {}) {
        const number = repository.listPuzzleSummaries().length + 1;
        const compiled = await compileSpec(spec, { agent: model ?? client, number });
        if (!compiled.ok) return { ok: false, problems: compiled.problems, warnings: [], compiled, report: null };
        const report = await validatePuzzleText(compiled.source);
        const copy = await findSpecDuplicate(compiled.spec);
        if (copy && report.checks.find((c) => c.id === "novelty")?.ok) {
            const novelty = report.checks.find((c) => c.id === "novelty");
            Object.assign(novelty, { ok: false, message: `its inputs and solution are the same as in ${copy}, only the words differ. Write a new puzzle with a different idea; the examples only show the structure` });
            report.ok = false;
        }
        // typing the final stack is the nature of an arrange puzzle, not a mistake to report
        if (compiled.spec.kind === "arrange") report.checks = report.checks.filter((c) => c.id !== "typable");
        return { ok: report.ok, problems: [], warnings: compiled.warnings, compiled, report };
    }

    /** The text an agent reads after validating or submitting a spec. */
    function describeSpecResult({ ok, problems, warnings, compiled, report }) {
        if (problems.length) return `The puzzle is not valid:\n${problems.map((p) => `  PROBLEM ${p}`).join("\n")}\n\nFix these and validate again.`;
        const { derived, spec } = compiled;
        const found = spec.kind === "arrange"
            ? `Your solution "${spec.solution}" turns the start stack (${spec.inputs[0].map((v) => (Array.isArray(v) ? `(${v.join(" ")})` : v)).join(" ")}) into ${derived.results[0]}. That is what the player must leave: check that it is what you meant.`
            : `Your solution gives (this is what the check expects):\n${spec.inputs.map((stack, i) => `  ${stack.map((v) => (Array.isArray(v) ? `(${v.join(" ")})` : v)).join(" ")} ${spec.word} -> ${derived.results[i]}`).join("\n")}\nCheck that these are what you meant.`;
        return [
            `Title: ${derived.title}; tags: ${derived.tags.join(", ")}; difficulty ${derived.difficulty} (estimated).`,
            found,
            formatReport(report),
            ...warnings.map((w) => `  warning spec: ${w}`),
            ok ? "Valid." : "Fix the ERROR lines and validate again.",
        ].join("\n");
    }

    return {
        validatePuzzle: validatePuzzleText,
        validateSpec,
        describeSpecResult,

        /**
         * Validates and, if it passes, stores a puzzle given as a spec. The same spec is stored once: a
         * retry reports `alreadyExisted`.
         */
        async submitSpec(spec, { client = null, model = null, brief = null } = {}) {
            const normal = spec && typeof spec === "object" && !Array.isArray(spec) ? normalizeSpec(spec) : null;
            if (normal) {
                const key = JSON.stringify(normal);
                for (const { id } of repository.listPuzzleSummaries()) {
                    if (JSON.stringify(repository.getPuzzle(id).package.spec) === key) {
                        return { accepted: true, id, alreadyExisted: true, result: null };
                    }
                }
            }
            const result = await validateSpec(spec, { client, model });
            if (!result.ok) return { accepted: false, id: null, alreadyExisted: false, result };
            const stored = await this.submitPuzzle(result.compiled.source, { client, model, spec: result.compiled.spec, report: result.report, brief });
            if (stored.accepted && !stored.alreadyExisted && brief?.requestId) repository.fulfilRequest(brief.requestId, stored.id, now());
            return { accepted: stored.accepted, id: stored.id, alreadyExisted: stored.alreadyExisted, result };
        },

        /**
         * Validates and, if it passes, stores a puzzle. Warnings do not stop it. The same text is stored
         * once: submitting it again reports `alreadyExisted`.
         * @returns {Promise<{accepted: boolean, id: string|null, alreadyExisted: boolean, report: object}>}
         */
        async submitPuzzle(source, { client = null, model = null, spec = null, report: checked = null, brief = null } = {}) {
            const report = checked ?? await validatePuzzleText(source);
            if (!report.ok) return { accepted: false, id: null, alreadyExisted: false, report };
            const { puzzle, id } = report;
            const alreadyExisted = Boolean(repository.getPuzzle(id));
            if (!alreadyExisted) {
                repository.addPuzzle({
                    id, title: puzzle.title, goal: puzzle.goal, description: puzzle.description, hints: puzzle.hints,
                    source: normalizeSource(source), now: now(),
                    package: {
                        schema: 1, tags: puzzle.tags, difficulty: puzzle.difficulty, solutions: puzzle.solutions,
                        right: puzzle.right, wrong: puzzle.wrong, bestKnownLength: report.metrics.bestKnownLength,
                        freeHints: puzzle.freeHints, ...(spec ? { spec } : {}),
                        ...(brief ? { brief: { idea: brief.idea, tag: brief.tag, kind: brief.kind, difficulty: brief.difficulty, ...(brief.requestId ? { requestId: brief.requestId } : {}) } } : {}),
                        warnings: report.checks.filter((c) => !c.ok).map((c) => c.message),
                        provenance: { client, model, submittedAt: now() },
                    },
                });
            }
            return { accepted: true, id, alreadyExisted, report };
        },

        /** Every puzzle with its tags and difficulty and how often it was played (never its answers). */
        listPuzzles() {
            const plays = new Map();
            for (const session of repository.sessionSummaries(1000)) plays.set(session.puzzleId, (plays.get(session.puzzleId) ?? 0) + 1);
            return repository.listPuzzleSummaries().map(({ id, title, goal, tags, difficulty, bestKnownLength }) =>
                ({ id, title, goal, tags, difficulty, bestKnownLength, plays: plays.get(id) ?? 0 }));
        },

        /** The puzzles the player has played (an agent may only play these), newest first, with how many agent attempts each had. */
        listPlayedPuzzles() {
            const played = new Set(repository.listPuzzles().filter((p) => p.played).map((p) => p.id));
            const attempts = new Map();
            for (const session of repository.sessionSummaries(5000)) if (session.role === "agent") attempts.set(session.puzzleId, (attempts.get(session.puzzleId) ?? 0) + 1);
            return repository.listPuzzleSummaries().filter((p) => played.has(p.id)).reverse()
                .map(({ id, title, tags, difficulty }) => ({ id, title, tags, difficulty, agentAttempts: attempts.get(id) ?? 0 }));
        },

        /**
         * The agent runs that can be replayed in the playground, newest first. Only runs on puzzles the player has
         * played are listed, so that a replay never shows the way through a puzzle they have not seen.
         */
        listAgentRuns({ limit = 50 } = {}) {
            const played = new Set(repository.listPuzzles().filter((p) => p.played).map((p) => p.id));
            return repository.sessionSummaries(5000).filter((s) => s.role === "agent" && s.outcome !== null && played.has(s.puzzleId)).slice(0, limit)
                .map((s) => ({ id: s.id, puzzleId: s.puzzleId, title: s.title, model: s.client, outcome: s.outcome, startedAt: s.startedAt, seconds: Math.round(s.durationMs / 1000), guesses: s.guesses, hints: s.hints }));
        },

        /**
         * One replayable agent run with its steps, or null. A step has its `kind` (run, guess, hint, lookup, say, think or
         * give-up), its `code` (the line, the thing looked up, or the words said), `error`, `at` (milliseconds since the
         * puzzle was set up, from the events' own times) and, for the step a model turn led to, `modelMs` (how long
         * the model took to decide) and `outputTokens`.
         */
        getAgentRun(id) {
            const run = this.listAgentRuns({ limit: 5000 }).find((r) => r.id === id);
            if (!run) return null;
            const events = repository.listEvents(id);
            const start = events[0]?.time ?? 0;
            const steps = events.flatMap((event) => {
                const kind = { reveal: "give-up", say: "say", think: "think", lookup: "lookup" }[event.type]
                    ?? (event.type === "evaluate" ? (event.code === "guess" ? "guess" : event.code === "hint" ? "hint" : "run") : null);
                if (!kind) return [];
                const printed = (event.output ?? []).filter((part) => part.stream === "stdout").map((part) => part.text).join("").trim();
                return [{
                    kind, code: kind === "give-up" ? null : event.code, error: event.error, at: Math.max(0, event.time - start),
                    ...(kind === "run" || kind === "guess" || kind === "hint"
                        ? { output: printed.slice(0, 600), stack: describeStacks(event.stack_after), solved: event.puzzle_state?.last === 2 } : {}),
                    ...(event.meta ? { modelMs: event.meta.modelMs, outputTokens: event.meta.outputTokens } : {}),
                }];
            });
            return { run, steps };
        },

    /** Formats a brief for an agent. */
        describeBrief: formatBrief,

        /**
         * What the next puzzle should be, from how the player is doing and what exists (see brief.mjs).
         * Without `preferences` the wishes of the player's waiting request, if there is one, are used.
         */
        getBrief({ preferences, random, easier = 0 } = {}) {
            const request = preferences ? null : repository.pendingRequest(now());
            const brief = makeBrief({ profile: this.getUserProfile(), puzzles: repository.listPuzzleSummaries(), preferences: preferences ?? request?.preferences ?? {}, random, easier });
            return request ? { ...brief, requestId: request.id } : brief;
        },

        /**
         * How the player is doing, from their recorded sessions (human ones only). Only the first time a puzzle
         * was played counts: later plays are practice, and by then the player knows the answer.
         */
        getUserProfile() {
            const sessions = firstPlays(repository.sessionSummaries(1000).filter((s) => s.role === "human"));
            const group = (key) => groupSummaries(sessions, key, summarize);
            const last = sessions[0] ?? null;
            return {
                totals: summarize(sessions),
                byDifficulty: group((s) => (s.difficulty === null ? [] : [s.difficulty])),
                byTag: group((s) => s.tags),
                lastPlayedAt: last ? new Date(last.startedAt).toISOString() : null,
                sessionsInTheLastWeek: sessions.filter((s) => now() - s.startedAt < 7 * DAY).length,
                recent: sessions.slice(0, 5).map((s) => ({ title: s.title, tags: s.tags, difficulty: s.difficulty, outcome: s.outcome ?? "open", seconds: Math.round(s.durationMs / 1000), hints: s.hints, guesses: s.guesses })),
                note: sessions.length ? undefined : "No sessions yet: the player is new. Start easy.",
            };
        },

        /**
         * What the profile dialog shows: the player's statistics (first plays only), those of each agent that
         * has played (every attempt counts: an agent does not learn from the last one), and what is stored.
         * Besides the counts of `getUserProfile` it has the mean difficulty of the puzzles played and how many
         * words were typed to solve them, alone and against the puzzle's best known answer.
         */
        getStatistics() {
            const all = repository.sessionSummaries(5000);
            const words = wordsTyped(repository.listPromptLines());
            const describe = (sessions, abandonedIsFailure = false) => {
                const solved = sessions.filter((s) => s.outcome === "solved");
                return {
                    ...summarize(sessions, abandonedIsFailure),
                    played: sessions.length,
                    meanDifficulty: average(sessions.map((s) => s.difficulty).filter((d) => d !== null)),
                    meanWordsToSolve: average(solved.map((s) => words.get(s.id)).filter((n) => n !== undefined)),
                    meanLengthRatio: average(solved.filter((s) => s.bestKnownLength && words.get(s.id)).map((s) => words.get(s.id) / s.bestKnownLength)),
                };
            };
            const human = all.filter((s) => s.role === "human");
            const first = firstPlays(human);
            const byModel = new Map();
            for (const session of all.filter((s) => s.role === "agent")) byModel.set(session.client ?? "unknown", [...(byModel.get(session.client ?? "unknown") ?? []), session]);
            const counts = repository.humanHistoryCounts();
            return {
                you: {
                    ...describe(first),
                    byDifficulty: groupSummaries(first, (s) => (s.difficulty === null ? [] : [s.difficulty]), describe),
                    byTag: groupSummaries(first, (s) => s.tags, describe),
                },
                agents: [...byModel].sort(([a], [b]) => a.localeCompare(b)).map(([model, sessions]) => ({ model, ...describe(sessions, true) })),
                data: {
                    sessions: counts.sessions, promptLines: counts.promptLines, replays: human.length - first.length,
                    puzzles: repository.listPuzzleSummaries().length, since: counts.since ? new Date(counts.since).toISOString() : null,
                },
            };
        },

        /** Everything the player's history holds, readable: each session with the lines typed (no editor content, no identity). */
        exportMyData() {
            return {
                about: "The sessions you played on recorded puzzles: when, the outcome, and each line you typed at the prompt with whether it worked. Nothing else is stored about you.",
                exportedAt: new Date(now()).toISOString(),
                sessions: repository.exportHumanHistory().map((s) => ({ ...s, startedAt: new Date(s.startedAt).toISOString(), endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null, promptLines: s.promptLines.map((l) => ({ ...l, time: new Date(l.time).toISOString() })) })),
            };
        },

        /** Deletes the player's history (agents' stay). Returns how many sessions and prompt lines were removed. */
        eraseMyHistory: () => repository.eraseHumanHistory(),

        /** The newest sessions, most recent first. */
        getSessionHistory({ limit = 10 } = {}) {
            const count = Math.min(Math.max(Number.isInteger(limit) ? limit : 10, 1), 100);
            return repository.sessionSummaries(count).map((s) => ({
                puzzle: s.title, puzzleId: s.puzzleId, tags: s.tags, difficulty: s.difficulty, role: s.role,
                outcome: s.outcome ?? "open", startedAt: new Date(s.startedAt).toISOString(), seconds: Math.round(s.durationMs / 1000),
                promptsTyped: s.prompts, guesses: s.guesses, hints: s.hints, revealed: s.revealed,
            }));
        },

        /** The authoring guide. Its examples are complete puzzles that the tests validate. */
        getGuide: () => read("playground-plus/guide.md"),

        /** A language document in full (for resources, which a client reads on purpose). */
        getFullReference(topic) {
            if (!Object.hasOwn(REFERENCES, topic)) throw new Error(`topic must be one of ${Object.keys(REFERENCES).join(", ")}`);
            return read(REFERENCES[topic]);
        },

        /**
         * The language documents (see REFERENCES). A short one is returned whole. A long one is returned
         * as an outline, or, with a `query`, as the entries that mention it, so that a client with a small
         * context window is never handed tens of kilobytes at once. Without a topic a query searches every
         * document, so the caller need not know which one holds a word.
         */
        getReference(topic, { query = "" } = {}) {
            const needle = typeof query === "string" ? query.trim() : "";
            if (!topic) {
                if (!needle) {
                    return `Topics: ${Object.entries(REFERENCES).map(([name, path]) => `${name} (${Math.round(read(path).length / 1024)} KB)`).join(", ")}. ` +
                        "Call again with a topic to read it (long ones return an outline), or with a query to search all of them.";
                }
                const parts = [];
                let room = REFERENCE_LIMIT;
                let total = 0;
                for (const name of Object.keys(REFERENCES)) {
                    const found = searchDocument(read(REFERENCES[name]), needle, room);
                    total += found.total;
                    if (!found.total) continue;
                    parts.push(`=== ${name} (${found.shown}${found.shown < found.total ? ` of ${found.total}` : ""}) ===\n${found.text}`);
                    room -= found.text.length;
                    if (room < 500) break;
                }
                return total ? `Entries mentioning "${needle}":\n\n${parts.join("\n\n")}` : `No document mentions "${needle}". Try another word.`;
            }
            if (!Object.hasOwn(REFERENCES, topic)) throw new Error(`topic must be one of ${Object.keys(REFERENCES).join(", ")}`);
            const text = read(REFERENCES[topic]);
            if (!needle) {
                if (text.length <= REFERENCE_LIMIT) return text;
                return `The ${topic} reference is long (${Math.round(text.length / 1024)} KB), so here are its sections:\n\n${outline(text)}\n\n` +
                    `Call get_bo_reference again with topic "${topic}" and a query (a word or phrase, for example "foldl" or "stack") to read the matching entries.`;
            }
            const { text: found, shown, total } = searchDocument(text, needle, REFERENCE_LIMIT);
            if (!total) return `No entry in the ${topic} reference mentions "${needle}". Try another word, or call without a query for an outline.`;
            return `${total} entr${total === 1 ? "y" : "ies"} in the ${topic} reference mention "${needle}"${shown < total ? ` (showing ${shown}; use a more specific query to see the rest)` : ""}:\n\n${found}`;
        },

        formatReport,
    };
}
