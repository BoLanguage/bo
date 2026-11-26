// Playground+'s own puzzle writer: runs a local model (through Ollama) as the agent that writes a puzzle,
// in the background, on the server. It is a client of the same service as any MCP client: the model
// talks to a real MCP server over an in-memory connection, reads the guide, gets a brief, validates and
// submits, so everything an outside agent goes through (validation, novelty, the player's waiting request)
// applies here too. One puzzle is written at a time. A try that gets stuck is given up on after a few
// minutes and restarted, quietly and one level easier, up to three times.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runAgent } from "./agent/agent.mjs";
import { createOllama, modelTraits } from "./agent/ollama.mjs";
import { createMcpServer } from "./mcp.mjs";
import { cleanPreferences } from "./taxonomy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Models that were measured to write good puzzles, best first (see "What the experiments showed"). */
export const PREFERRED_MODELS = ["gemma4:12b", "qwen3.5:9b"];
const GPU_SIZE_LIMIT = 16; // billions of parameters: what fits a 10 to 16 GB graphics card
export const MIN_MODEL_SIZE_B = 7; // smaller models (a 1.5B one was tried) cannot write a puzzle, so they are not offered

export class GeneratorError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code; // "busy", "unavailable", "model" or "preferences"
    }
}

const sizeOf = (model) => Number.parseFloat(model.parameterSize ?? "") || null;

/** The model to use when the player does not choose: a measured one if installed, else a tool-capable one that fits a common GPU. */
export function chooseModel(models, preferred = PREFERRED_MODELS) {
    for (const name of preferred) if (models.some((m) => m.name === name)) return name;
    const fitting = models.filter((m) => sizeOf(m) !== null && sizeOf(m) <= GPU_SIZE_LIMIT).sort((a, b) => sizeOf(b) - sizeOf(a));
    return (fitting[0] ?? models[0])?.name ?? null;
}

const FAILURES = {
    "no-tool-call": "The model stopped without writing a puzzle.",
    "max-turns": "The model did not finish a valid puzzle in time.",
    timeout: "The model got stuck and took too long.",
};
const KEPT_TRANSCRIPTS = 30;

/**
 * @param {{repository: object, service: object, ollama?: object, now?: () => number, attempts?: number,
 *   attemptTimeoutMs?: number, turnTimeoutMs?: number, transcriptDir?: string|null, agentOptions?: object,
 *   preferred?: string[], buildExists?: () => boolean}} options
 *   A try that runs longer than `attemptTimeoutMs`, or whose single turn takes longer than `turnTimeoutMs`,
 *   is given up on and the next one starts, without the player being asked; each retry is one level easier.
 *   With a `transcriptDir`, every try is saved there as JSON (the newest 30 are kept) to see why one was slow.
 */
export function createGenerator({
    repository, service, ollama = createOllama(), now = Date.now, attempts = 3, attemptTimeoutMs = 4 * 60_000, turnTimeoutMs = 2 * 60_000,
    minSizeB = MIN_MODEL_SIZE_B, transcriptDir = null, agentOptions = {}, preferred = PREFERRED_MODELS,
    buildExists = () => existsSync(join(ROOT, "wasm", "build", "bo-core.wasm")),
}) {
    let job = null; // the running job, or the last one that ended

    const snapshot = (current) => current && ({
        state: current.state, requestId: current.requestId, model: current.model, startedAt: current.startedAt, turn: current.turn,
        tool: current.tool, attempt: current.attempt, attempts: current.attempts, message: current.message, puzzle: current.puzzle,
    });

    /** Saves what a try said and did, newest last, keeping the most recent few. */
    function saveTranscript(current, result) {
        if (!transcriptDir) return;
        try {
            mkdirSync(transcriptDir, { recursive: true });
            const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
            const name = `${stamp}-${current.model.replace(/[^\w.-]/g, "_")}-try${current.attempt}.json`;
            writeFileSync(join(transcriptDir, name), JSON.stringify({ model: current.model, attempt: current.attempt, requestId: current.requestId, ...result }, null, 2));
            const files = readdirSync(transcriptDir).filter((f) => f.endsWith(".json")).sort();
            for (const old of files.slice(0, Math.max(files.length - KEPT_TRANSCRIPTS, 0))) rmSync(join(transcriptDir, old), { force: true });
        } catch {
            // diagnostics must never get in the way of writing the puzzle
        }
    }

    /** Whether a puzzle can be written here, with the models to choose from; `reason` says what is missing. */
    async function capabilities() {
        if (!buildExists()) return { available: false, reason: "The WebAssembly build is missing (run `make wasm`): puzzles cannot be checked without it.", models: [], model: null };
        let installed;
        try {
            installed = await ollama.listModels();
        } catch {
            return { available: false, reason: `Ollama was not found at ${ollama.base}. Install it from https://ollama.com, then pull a model, for example: ollama pull gemma4:12b`, models: [], model: null };
        }
        const toolCapable = installed.filter((m) => !m.capabilities.length || m.capabilities.includes("tools"));
        if (!toolCapable.length) return { available: false, reason: "Ollama is running, but none of its models can use tools. Pull one, for example: ollama pull gemma4:12b", models: [], model: null };
        // models this small were measured to fail at the task, and offering them only leads to a bad first experience
        const usable = toolCapable.filter((m) => sizeOf(m) === null || sizeOf(m) >= minSizeB);
        if (!usable.length) return { available: false, reason: `Ollama's models are too small to write puzzles well (${minSizeB}B parameters or more are needed). Pull one, for example: ollama pull gemma4:12b`, models: [], model: null };
        const models = usable.map(({ name, parameterSize }) => ({ name, parameterSize }))
            .sort((a, b) => (preferred.indexOf(a.name) + 1 || Infinity) - (preferred.indexOf(b.name) + 1 || Infinity) || a.name.localeCompare(b.name));
        return { available: true, reason: null, models, model: chooseModel(models, preferred) };
    }

    async function run(current) {
        for (let attempt = 1; attempt <= current.attempts; attempt++) {
            current.attempt = attempt;
            current.turn = 0;
            current.tool = null;
            const before = repository.listPuzzleSummaries().length;
            const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
            const server = createMcpServer(service, { client: current.model, briefEasier: () => attempt - 1 });
            const mcp = new Client({ name: current.model, version: "1" });
            let result;
            try {
                await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
                result = await runAgent({
                    ollama, model: current.model, mcp, signal: current.controller.signal, retryEmpty: 2,
                    totalTimeoutMs: attemptTimeoutMs, turnTimeoutMs, ...agentOptions, ...modelTraits(current.model),
                    onStep: (step) => {
                        current.turn = step.turn;
                        current.tool = step.calls.at(-1)?.name ?? current.tool;
                    },
                });
            } catch (error) {
                result = { outcome: "error", finalText: String(error.message ?? error) };
            } finally {
                await mcp.close().catch(() => {});
                await server.close().catch(() => {});
            }
            saveTranscript(current, result);
            if (current.controller.signal.aborted) {
                current.state = "cancelled";
                return;
            }
            const puzzles = repository.listPuzzleSummaries();
            if (result.outcome === "accepted" && puzzles.length > before) {
                const puzzle = puzzles.at(-1);
                repository.fulfilRequest(current.requestId, puzzle.id, now()); // a no-op if the submit already did
                current.puzzle = { id: puzzle.id, title: puzzle.title };
                current.state = "done";
                return;
            }
            // a turn that timed out surfaces as an error: it is the model being stuck, not a failure of Ollama
            const stuck = result.outcome === "timeout" || (result.outcome === "error" && /timeout|timed out|aborted/i.test(result.finalText ?? ""));
            current.message = stuck ? FAILURES.timeout : result.outcome === "error" ? `The model could not be used: ${result.finalText}` : FAILURES[result.outcome] ?? "No puzzle was written.";
        }
        current.state = "failed";
        repository.cancelRequest(current.requestId, now());
    }

    return {
        capabilities,

        /** The current or latest job, or `{state: "idle"}`. */
        status: () => snapshot(job) ?? { state: "idle" },

        /**
         * Starts writing a puzzle in the background and returns the job. Throws a GeneratorError when one is
         * already running, when Ollama or the model is not available, or when the preferences are not valid.
         */
        async start({ preferences = {}, model } = {}) {
            if (job?.state === "running") throw new GeneratorError("busy", "A puzzle is already being written.");
            let clean;
            try {
                clean = cleanPreferences(preferences);
            } catch (error) {
                throw new GeneratorError("preferences", error.message);
            }
            const caps = await capabilities();
            if (!caps.available) throw new GeneratorError("unavailable", caps.reason);
            const chosen = model ?? caps.model;
            if (!caps.models.some((m) => m.name === chosen)) throw new GeneratorError("model", `The model "${chosen}" is not installed. Installed: ${caps.models.map((m) => m.name).join(", ")}.`);
            if (job?.state === "running") throw new GeneratorError("busy", "A puzzle is already being written."); // started meanwhile
            const current = {
                requestId: repository.createRequest({ preferences: clean, now: now() }), model: chosen, state: "running", startedAt: now(),
                turn: 0, tool: null, attempt: 1, attempts, message: null, puzzle: null, controller: new AbortController(),
            };
            job = current;
            run(current).catch((error) => {
                current.state = "failed";
                current.message = `The generator stopped unexpectedly: ${error.message}`;
            });
            return snapshot(current);
        },

        /** Stops the running job (and withdraws the player's request). Returns the job. */
        cancel() {
            if (job?.state === "running") {
                job.controller.abort();
                job.state = "cancelled";
                repository.cancelRequest(job.requestId, now());
            }
            return snapshot(job) ?? { state: "idle" };
        },
    };
}
