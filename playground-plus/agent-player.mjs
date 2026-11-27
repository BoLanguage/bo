// Lets a local model (through Ollama) play a puzzle the player has already played, on a server-side Bo
// machine, while the page watches. The model gets what a person gets: the puzzle's title, goal and
// description, a Bo prompt, `guess`, `hint` and the documentation. It does not get the puzzle's source,
// its hidden stacks or its answer, and `reveal` is giving up. The run is recorded as a session with role
// "agent" (client = the model), built by the same `toRecord` the page's recorder uses, so agents and people
// are measured by the same rules. Only a run that ends on its own is recorded: one the player stops is not,
// and neither is one where Ollama itself failed (that is not the model's doing).
//
// Outcomes: solved; revealed (the model gave up); abandoned (it ran out of time or turns, stopped calling
// tools, or left the puzzle). For an agent all of those but the first are failures, and the statistics
// count them so.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTextToolCall, toOllamaTools } from "./agent/agent.mjs";
import { createOllama, modelTraits } from "./agent/ollama.mjs";
import { hasPuzzleRuntime, puzzleState, toRecord, visibleStacks } from "./client/recorder.mjs";
import { DEFAULT_BUDGET, defaultFiles, openMachine } from "./harness.mjs";

export const AGENT_LIMITS = { maxTurns: 20, timeoutMs: 5 * 60_000, turnTimeoutMs: 2 * 60_000, lookups: 4, line: 500 };
const KEPT_TRANSCRIPTS = 30;
const STEP_TEXT = 600; // characters of one step's text or output shown to whoever is watching
const TOOL_TEXT = 4000; // characters of a tool's result given back to the model
const THINK_TEXT = 4000; // characters kept of what a model thought before acting
const MAX_NUDGES = 3;

export class AgentPlayError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code; // "busy", "unavailable", "model", "puzzle" or "unplayed" (the player has not played it yet)
    }
}

const TOOLS = [
    {
        name: "run_bo",
        description: "Type one line of Bo at the prompt and run it. The stacks stay as they are between lines. Returns what the line printed and the stacks afterwards.",
        inputSchema: { type: "object", properties: { line: { type: "string", description: "one line of Bo, for example: 1 2 +" } }, required: ["line"] },
    },
    { name: "guess", description: "Check your current stacks against the puzzle's goal. It says whether the puzzle is solved.", inputSchema: { type: "object", properties: {} } },
    { name: "hint", description: "Show the next hint for the puzzle. The first hint is free; every later one is counted against you.", inputSchema: { type: "object", properties: {} } },
    { name: "look_up", description: "Search the Bo documentation for a word or phrase, for example foldl. Limited: use it only when you really need it.", inputSchema: { type: "object", properties: { query: { type: "string", description: "a word or phrase" } }, required: ["query"] } },
    { name: "give_up", description: "Stop playing and ask to see the answer. The puzzle then counts as not solved.", inputSchema: { type: "object", properties: {} } },
];
const TOOL_NAMES = TOOLS.map((tool) => tool.name);

/** The "Bo in one minute" primer of the authoring guide, without its closing note about the authoring tools. */
export function boPrimer(guide) {
    const start = guide.indexOf("## Bo in one minute");
    if (start < 0) return "";
    const end = guide.indexOf("Uppercase ops are kernel primitives");
    return `${guide.slice(start, end < 0 ? undefined : end).trim()}\n\nUppercase ops are kernel primitives; lowercase ones act on the default stack.`;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const BLOCKED = [
    [/puzzle\./, "That is part of the puzzle's own machinery and is not available. Work with the stacks you can see."],
    [/(^|[\s()])reveal($|[\s()])/, "`reveal` is not available here. Call give_up if you want to stop and see the answer."],
];

/** The visible stacks as the model reads them: the default stack, then any stack the model made (not the error report). */
export function describeStacks(stacks) {
    return (stacks ?? []).filter(({ name, depth }) => name === "" || (depth > 0 && name !== "DIAGNOSTICS"))
        .map(({ name, items, depth }) => `${name === "" ? "Stack" : `Stack "${name}"`}: (${items.map(([, value]) => value).join(" ")}${depth > items.length ? " …" : ""})`)
        .join("\n");
}

function systemPrompt(primer, limit) {
    return [
        "You are playing a puzzle in Bo, a small stack-based language, on a real Bo machine, the way a person does at the Playground prompt.",
        "Tools: run_bo (type one line of Bo; the stacks stay between lines), guess (check your answer), hint (the next hint; the first is free, later ones are counted against you), look_up (search the Bo documentation), give_up (see the answer and stop).",
        `Work in small steps: run some Bo, look at the stacks, adjust. When the stacks look right, call guess. Be brief and call the tools; you have at most ${limit.maxTurns} turns and ${Math.round(limit.timeoutMs / 60_000)} minutes.`,
        primer,
    ].filter(Boolean).join("\n\n");
}

/** Why a run that was not solved ended, as the person watching reads it. */
const ENDINGS = {
    revealed: "Gave up and asked for the answer.",
    timeout: "Ran out of time.",
    stuck: "Got stuck: one move took too long.",
    turns: "Used all its turns without solving it.",
    "no-tool-call": "Stopped using the tools.",
    left: "Left the puzzle (the machine was reset).",
};

/**
 * @param {{repository: object, service: object, ollama?: object, capabilities: () => Promise<{available: boolean, reason: string|null, models: object[], model: string|null}>,
 *   now?: () => number, limits?: Partial<typeof AGENT_LIMITS>, budget?: number, transcriptDir?: string|null, random?: () => number}} options
 *   `capabilities` says whether a model can play and which ones (the generator's: same Ollama, same size rule).
 *   `budget` is the ops one line may execute, so that an endless loop is stopped.
 */
export function createAgentPlayer({
    repository, service, ollama = createOllama(), capabilities, now = Date.now, limits = {}, budget = DEFAULT_BUDGET, transcriptDir = null, random = Math.random,
}) {
    const limit = { ...AGENT_LIMITS, ...limits };
    let job = null; // the running job, or the last one that ended
    let counter = 0;

    const snapshot = (current, since = 0) => ({
        id: current.id, state: current.state, puzzle: current.puzzle, model: current.model, startedAt: current.startedAt, endedAt: current.endedAt,
        timeoutMs: limit.timeoutMs, turn: current.turn, maxTurns: limit.maxTurns, outcome: current.outcome, message: current.message,
        stepCount: current.steps.length, steps: current.steps.slice(since), sessionId: current.sessionId ?? null,
    });

    function saveTranscript(current, extra) {
        if (!transcriptDir) return;
        try {
            mkdirSync(transcriptDir, { recursive: true });
            const stamp = new Date(current.startedAt).toISOString().replace(/[:.]/g, "-");
            writeFileSync(join(transcriptDir, `${stamp}-${current.model.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify({
                model: current.model, puzzle: current.puzzle, state: current.state, outcome: current.outcome, message: current.message, steps: current.steps, ...extra,
            }, null, 2));
            const files = readdirSync(transcriptDir).filter((f) => f.endsWith(".json")).sort();
            for (const old of files.slice(0, Math.max(files.length - KEPT_TRANSCRIPTS, 0))) rmSync(join(transcriptDir, old), { force: true });
        } catch {
            // diagnostics must never get in the way of playing
        }
    }

    /** Plays until the puzzle is solved, the model gives up, a limit is reached or the job is cancelled. */
    async function play(current, row) {
        const deadline = current.startedAt + limit.timeoutMs;
        const machine = await openMachine(defaultFiles(), budget);
        current.boVersion = machine.bo.version ?? null;
        if (machine.run(row.source).status !== "done") throw new Error("the puzzle could not be set up");
        const opening = machine.bo.state();
        const own = new Set(opening.stacks.map(({ name }) => name).filter((name) => name !== ""));
        const events = [toRecord({ type: "setup", time: now(), duration: 0, after: opening }, own)];
        let turnMeta = null; // how the model's turn went (time, tokens): kept with the first event the turn led to
        const add = (event) => {
            if (turnMeta) events.push({ ...event, meta: turnMeta });
            else events.push(event);
            turnMeta = null;
        };
        /** Records something that is not a line of Bo (what the model said, what it looked up). */
        const note = (type, text) => add({ ...toRecord({ type, time: now(), duration: 0, after: machine.bo.state() }, own), code: text });
        const step = (fields) => current.steps.push({ n: current.steps.length + 1, at: now() - current.startedAt, ...fields });
        const messages = [
            { role: "system", content: systemPrompt(boPrimer(service.getGuide()), limit) },
            { role: "user", content: `${row.title}\n\nGoal: ${row.goal}\n${row.description ? `\n${row.description}\n` : ""}\nThe stacks now:\n${describeStacks(events[0].stackAfter) || "Stack: ()"}` },
        ];
        let ending = null; // {outcome, reason}, once the run is over
        let lookups = 0;

        /** Runs a line as the player would type it, records it, and tells the model what happened. */
        function execute(code, kind) {
            const before = machine.bo.state();
            const at = now();
            const result = machine.run(code);
            if (result.status === "paused") machine.bo.debug.abort();
            const after = machine.bo.state();
            const failed = result.status !== "done";
            const output = [{ stream: "stdout", text: result.stdout }, { stream: "stderr", text: result.stderr }].filter((part) => part.text);
            add(toRecord({ type: "evaluate", time: at, duration: now() - at, code, ok: !failed, error: failed ? clip(result.stderr || result.status, 300) : null, output, before, after }, own));
            const solved = puzzleState(after).last === 2;
            if (solved) ending = { outcome: "solved" };
            else if (result.status === "exit" || !hasPuzzleRuntime(after)) ending = { outcome: "abandoned", reason: "left" };

            let problem = "";
            if (result.status === "paused") problem = `That line did not finish within ${budget} steps (an endless loop?) and was stopped.`;
            else if (result.status === "unreadable") problem = `That is not valid Bo: ${clip(result.stderr.trim(), 200) || "it could not be read"}.`;
            else if (failed && result.status !== "exit") problem = clip(result.stderr.trim() || `The line ended with status ${result.status}.`, 300);
            const stacks = describeStacks(visibleStacks(after, own));
            const said = result.stdout.trim();
            step({ kind, code, output: clip(said, STEP_TEXT), error: problem ? clip(problem, STEP_TEXT) : null, stack: clip(stacks, STEP_TEXT), solved });
            return [said, problem, solved ? "The puzzle is solved." : "", stacks].filter(Boolean).join("\n");
        }

        function useTool({ name, arguments: args }) {
            if (ending) return { text: "The puzzle is over.", error: true };
            const input = args && typeof args === "object" ? args : {};
            switch (name) {
                case "run_bo": {
                    const line = input.line ?? input.code;
                    if (typeof line !== "string" || !line.trim()) return { text: "Error: give the line of Bo to run as `line`.", error: true };
                    if (line.length > limit.line || line.includes("\n")) return { text: `Error: send one line of at most ${limit.line} characters.`, error: true };
                    for (const [pattern, message] of BLOCKED) if (pattern.test(line)) return { text: `Error: ${message}`, error: true };
                    return { text: execute(line.trim(), "run") };
                }
                case "guess":
                    return { text: execute("guess", "guess") };
                case "hint":
                    return { text: execute("hint", "hint") };
                case "look_up": {
                    if (lookups >= limit.lookups) return { text: "Error: no more lookups: use what you have learned.", error: true };
                    lookups++;
                    const query = typeof input.query === "string" ? input.query.slice(0, 100) : "";
                    const answer = service.getReference(undefined, { query });
                    note("lookup", query);
                    step({ kind: "lookup", code: query, output: clip(answer, STEP_TEXT) });
                    return { text: answer };
                }
                case "give_up": {
                    const record = toRecord({ type: "reveal", time: now(), duration: 0, after: machine.bo.state() }, own);
                    add({ ...record, puzzleState: { ...record.puzzleState, revealed: true } });
                    step({ kind: "give-up" });
                    ending = { outcome: "revealed", reason: "revealed" };
                    return { text: "You gave up." };
                }
                default:
                    return { text: `Error: there is no tool named "${name}". The tools are: ${TOOL_NAMES.join(", ")}.`, error: true };
            }
        }

        const tools = toOllamaTools(TOOLS);
        const options = { num_ctx: 16384, temperature: 0.2, seed: Math.floor(random() * 2 ** 31) };
        const done = () => ({ events, messages, ending });
        let nudges = 0;
        for (let turn = 1; !ending; turn++) {
            if (current.controller.signal.aborted) return { cancelled: true };
            const remaining = deadline - now();
            if (turn > limit.maxTurns) ending = { outcome: "abandoned", reason: "turns" };
            else if (remaining <= 0) ending = { outcome: "abandoned", reason: "timeout" };
            if (ending) break;
            current.turn = turn;
            let reply;
            try {
                reply = await ollama.chat({ model: current.model, messages, tools, options, timeoutMs: Math.min(limit.turnTimeoutMs, remaining), signal: current.controller.signal, ...modelTraits(current.model) });
            } catch (error) {
                if (current.controller.signal.aborted) return { cancelled: true };
                if (error?.name === "TimeoutError" || /timed? ?out/i.test(String(error?.message))) {
                    ending = { outcome: "abandoned", reason: limit.turnTimeoutMs < remaining ? "stuck" : "timeout" };
                    break;
                }
                throw error; // Ollama itself failed: not the model's doing, so nothing is recorded
            }
            const message = reply.message ?? { role: "assistant", content: "" };
            const content = (message.content ?? "").trim();
            let calls = (message.tool_calls ?? []).map((c) => ({ name: c.function?.name, arguments: c.function?.arguments ?? {} }));
            if (!calls.length) {
                const text = parseTextToolCall(content, TOOL_NAMES);
                if (text) calls = [text];
            }
            turnMeta = { turn, modelMs: reply.ms, promptTokens: reply.promptTokens, outputTokens: reply.outputTokens, thinkingChars: (message.thinking ?? "").length };
            const thinking = (message.thinking ?? "").trim();
            if (thinking) { // what a model that thinks says to itself before it acts: often its only "talk" when it calls a tool
                note("think", clip(thinking, THINK_TEXT));
                step({ kind: "think", text: clip(thinking, THINK_TEXT) });
            }
            if (content) {
                note("say", clip(content, 2000));
                step({ kind: "say", text: clip(content, STEP_TEXT) });
            }
            if (!calls.length) {
                if (nudges++ >= MAX_NUDGES) {
                    ending = { outcome: "abandoned", reason: "no-tool-call" };
                    break;
                }
                messages.push({ role: "assistant", content }, { role: "user", content: "Please continue: call one of the tools (run_bo to try something, guess to check your answer)." });
                continue;
            }
            messages.push({ role: "assistant", content, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
            for (const call of calls) messages.push({ role: "tool", tool_name: call.name, content: clip(useTool(call).text, TOOL_TEXT) });
        }
        return done();
    }

    /** Writes a finished run as a session, in one go (a run that did not finish leaves nothing behind). */
    function record(current, events, outcome) {
        const id = repository.createSession({ puzzleId: current.puzzle.id, role: "agent", client: current.model, boVersion: current.boVersion ?? null, now: current.startedAt });
        repository.addEvents(id, events);
        repository.endSession(id, outcome, current.endedAt);
        return id;
    }

    async function run(current, row) {
        try {
            const result = await play(current, row);
            current.endedAt = now();
            if (result.cancelled || current.controller.signal.aborted) {
                current.state = "cancelled";
                return;
            }
            const { outcome, reason } = result.ending;
            const last = result.events.at(-1)?.puzzleState ?? {};
            current.outcome = outcome;
            current.message = outcome === "solved"
                ? `Solved it with ${last.guesses ?? 0} ${last.guesses === 1 ? "guess" : "guesses"} and ${last.hints ?? 0} ${last.hints === 1 ? "hint" : "hints"}.`
                : ENDINGS[reason];
            current.sessionId = record(current, result.events, outcome);
            current.state = "finished";
            saveTranscript(current, { messages: result.messages });
        } catch (error) {
            current.endedAt = now();
            current.state = "failed";
            current.message = `The model could not be used: ${error.message}`;
            saveTranscript(current, { error: String(error.stack ?? error) });
        }
    }

    return {
        /** Whether a model can play, and which (see the generator's `capabilities`). */
        capabilities,
        /** The limits a run keeps to: turns, and milliseconds in all. */
        limits: { maxTurns: limit.maxTurns, timeoutMs: limit.timeoutMs },
        /** The current or latest job, with the steps from number `since` on, or `{state: "idle"}`. */
        status: (since = 0) => (job ? snapshot(job, since) : { state: "idle", steps: [], stepCount: 0 }),

        /**
         * Starts a model on a puzzle the player has already played, in the background. Throws an
         * AgentPlayError when one is already running, when the puzzle is unknown or not yet played, or when
         * the model (or Ollama) is not available.
         */
        async start({ puzzleId, model } = {}) {
            if (job?.state === "running") throw new AgentPlayError("busy", "An agent is already playing.");
            const row = typeof puzzleId === "string" ? repository.getPuzzle(puzzleId) : null;
            if (!row) throw new AgentPlayError("puzzle", "That puzzle does not exist.");
            if (!repository.listPuzzles().find((p) => p.id === puzzleId)?.played) throw new AgentPlayError("unplayed", "Play that puzzle yourself first: an agent only plays puzzles you have already played.");
            const caps = await capabilities();
            if (!caps.available) throw new AgentPlayError("unavailable", caps.reason);
            const chosen = model ?? caps.model;
            if (!caps.models.some((m) => m.name === chosen)) throw new AgentPlayError("model", `The model "${chosen}" is not installed. Installed: ${caps.models.map((m) => m.name).join(", ")}.`);
            if (job?.state === "running") throw new AgentPlayError("busy", "An agent is already playing."); // started meanwhile
            const current = {
                id: ++counter, state: "running", puzzle: { id: row.id, title: row.title }, model: chosen, startedAt: now(), endedAt: null,
                turn: 0, outcome: null, message: null, steps: [], controller: new AbortController(),
            };
            job = current;
            run(current, row);
            return snapshot(current);
        },

        /** Stops the running job; nothing of it is recorded. Returns the job. */
        cancel() {
            if (job?.state === "running") {
                job.controller.abort();
                job.state = "cancelled";
                job.endedAt = now();
            }
            return job ? snapshot(job) : { state: "idle", steps: [], stepCount: 0 };
        },
    };
}
