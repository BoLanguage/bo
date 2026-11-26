// Runs the experiment: for each model and trial, an agent (agent.mjs) tries to get a valid puzzle
// accepted by a fresh Playground+ MCP server on a throwaway database. Transcripts and a summary are
// written under playground-plus/data/eval/ (git-ignored). Needs the WebAssembly build (`make wasm`),
// because every puzzle is checked by the harness, and an Ollama server with the models.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase } from "../db.mjs";
import { runAgent } from "../agent/agent.mjs";
import { createOllama, modelTraits } from "../agent/ollama.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_MODELS = ["qwen3.5:9b", "gemma4:12b"];

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (value, digits = 1) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/** One row per model from its trials' results. */
export function summarize(results) {
    const byModel = new Map();
    for (const result of results) byModel.set(result.model, [...(byModel.get(result.model) ?? []), result]);
    return [...byModel].map(([model, runs]) => {
        const accepted = runs.filter((r) => r.outcome === "accepted");
        const m = (pick) => runs.map((r) => pick(r.metrics)).filter((v) => v !== null && v !== undefined);
        return {
            model,
            trials: runs.length,
            accepted: accepted.length,
            firstTryValid: runs.filter((r) => r.metrics.firstValidateOk === true).length,
            outcomes: Object.fromEntries([...new Set(runs.map((r) => r.outcome))].map((o) => [o, runs.filter((r) => r.outcome === o).length])),
            readGuideFirst: runs.filter((r) => r.metrics.readGuideFirst === true).length,
            avgTurns: round(mean(m((x) => x.turns))),
            avgValidateCalls: round(mean(m((x) => x.validateCalls))),
            avgAttemptsToValid: round(mean(m((x) => x.attemptsToValid))),
            structuredCalls: m((x) => x.structuredCalls).reduce((a, b) => a + b, 0),
            textCalls: m((x) => x.textCalls).reduce((a, b) => a + b, 0),
            toolErrors: m((x) => x.toolErrors).reduce((a, b) => a + b, 0),
            contextFull: runs.filter((r) => r.metrics.contextNearlyFull === true).length,
            avgSeconds: round(mean(m((x) => x.ms)) / 1000),
            avgOutputTokens: Math.round(mean(m((x) => x.outputTokens)) ?? 0),
        };
    });
}

export function formatSummary(rows) {
    const header = ["model", "ok", "1st", "guide", "turns", "valid.calls", "to valid", "calls s/t", "errors", "ctx full", "sec", "tokens"];
    const lines = rows.map((r) => [
        r.model, `${r.accepted}/${r.trials}`, `${r.firstTryValid}/${r.trials}`, `${r.readGuideFirst}/${r.trials}`, r.avgTurns, r.avgValidateCalls,
        r.avgAttemptsToValid ?? "-", `${r.structuredCalls}/${r.textCalls}`, r.toolErrors, `${r.contextFull}/${r.trials}`, r.avgSeconds, r.avgOutputTokens,
    ].map(String));
    const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
    const row = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
    return [row(header), row(widths.map((w) => "-".repeat(w))), ...lines.map(row)].join("\n");
}

/**
 * @param {{
 *   ollama: ReturnType<typeof createOllama>, models: string[], trials?: number, maxTurns?: number, lenient?: boolean,
 *   out?: string, root?: string, log?: (line: string) => void, agentOptions?: object,
 * }} config
 * @returns {Promise<{rows: object[], results: object[], out: string}>}
 */
export async function runExperiment({ ollama, models, trials = 3, maxTurns, lenient = true, think, out, root = ROOT, log = console.log, agentOptions = {} }) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = out ?? join(root, "playground-plus", "data", "eval", stamp);
    mkdirSync(outDir, { recursive: true });
    const results = [];

    for (const model of models) {
        for (let trial = 1; trial <= trials; trial++) {
            const label = `${model} #${trial}`;
            const dir = mkdtempSync(join(tmpdir(), "plus-eval-"));
            const databasePath = join(dir, "plus.sqlite");
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: ["--disable-warning=ExperimentalWarning", join(root, "playground-plus", "mcp.mjs")],
                env: { ...process.env, PLAYGROUND_PLUS_DB: databasePath },
                stderr: "ignore",
            });
            const mcp = new Client({ name: model, version: "1" });
            let result;
            try {
                await mcp.connect(transport);
                log(`${label}: started`);
                result = await runAgent({
                    ollama, model, mcp, lenient, ...(maxTurns ? { maxTurns } : {}), ...agentOptions, ...modelTraits(model), ...(think !== undefined ? { think } : {}),
                    options: { seed: 7 + trial, ...agentOptions.options },
                    onStep: (step) => log(`${label}: turn ${step.turn} (${(step.ms / 1000).toFixed(1)}s, ${step.outputTokens} tokens) ${step.calls.map((c) => `${c.name}${c.isError ? "!" : ""}${c.structured ? "" : "~"}`).join(", ") || "no tool call"}`),
                });
            } catch (error) {
                result = { model, outcome: "error", finalText: String(error.message ?? error), metrics: { turns: 0, ms: 0 }, steps: [], messages: [], accepted: null };
            } finally {
                await mcp.close().catch(() => {});
            }
            // what ended up in the database: the accepted puzzle, if any
            if (existsSync(databasePath)) {
                const database = openDatabase(databasePath);
                try {
                    result.stored = database.listPuzzleSummaries().map((p) => ({ ...p, source: database.getPuzzle(p.id).source, warnings: database.getPuzzle(p.id).package.warnings }));
                } finally {
                    database.close();
                }
            }
            rmSync(dir, { recursive: true, force: true });
            result.trial = trial;
            results.push(result);
            writeFileSync(join(outDir, `${model.replace(/[^\w.-]/g, "_")}-${trial}.json`), JSON.stringify(result, null, 2));
            log(`${label}: ${result.outcome} in ${(result.metrics.ms / 1000).toFixed(0)}s${result.stored?.length ? ` ("${result.stored[0].title}")` : ""}`);
        }
    }
    const rows = summarize(results);
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(rows, null, 2));
    return { rows, results, out: outDir };
}

/** Command-line entry: node playground-plus/eval/run.mjs [--models a,b] [--trials N] [--max-turns N] [--no-lenient] [--list] [--out DIR] */
export async function main(argv = process.argv.slice(2), env = process.env) {
    const option = (name, fallback) => {
        const at = argv.indexOf(`--${name}`);
        return at >= 0 ? argv[at + 1] : fallback;
    };
    const ollama = createOllama({ host: option("host", env.OLLAMA_HOST ?? undefined) });
    let installed;
    try {
        installed = await ollama.listModels();
    } catch (error) {
        console.error(`Ollama is not reachable at ${ollama.base} (${error.message}).\nInstall and start it (https://ollama.com), or set OLLAMA_HOST. Nothing else in this project needs it.`);
        return 2;
    }
    if (argv.includes("--list")) {
        for (const m of installed) console.log(`${m.name}  ${m.parameterSize ?? ""}  ${m.capabilities.join(",")}`);
        return 0;
    }
    if (!existsSync(join(ROOT, "wasm", "build", "bo-core.wasm"))) {
        console.error("The WebAssembly build is missing (run `make wasm`): puzzles cannot be checked without it.");
        return 2;
    }
    const models = (option("models", env.MODELS ?? "") || DEFAULT_MODELS.join(",")).split(",").map((m) => m.trim()).filter(Boolean);
    const missing = models.filter((m) => !installed.some((i) => i.name === m));
    if (missing.length) {
        console.error(`These models are not installed: ${missing.join(", ")}.\nInstalled: ${installed.map((m) => m.name).join(", ")}.\nTry: ${missing.map((m) => `ollama pull ${m}`).join("; ")}`);
        return 2;
    }
    for (const model of models) {
        const info = installed.find((m) => m.name === model);
        if (info.capabilities.length && !info.capabilities.includes("tools")) console.warn(`warning: ${model} does not advertise tool support`);
    }
    const trials = Number(option("trials", env.TRIALS ?? "3"));
    const maxTurns = option("max-turns") ? Number(option("max-turns")) : undefined;
    if (!Number.isInteger(trials) || trials < 1) {
        console.error("--trials must be a positive whole number");
        return 2;
    }
    const thinkArgument = option("think");
    const think = thinkArgument === undefined ? undefined : { on: true, off: false }[thinkArgument] ?? thinkArgument;
    if (thinkArgument !== undefined && ![true, false, "low", "medium", "high"].includes(think)) {
        console.error("--think must be on, off, low, medium or high");
        return 2;
    }
    const { rows, out } = await runExperiment({ ollama, models, trials, maxTurns, think, lenient: !argv.includes("--no-lenient"), out: option("out") });
    console.log(`\n${formatSummary(rows)}\n\nTranscripts: ${out}`);
    return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
