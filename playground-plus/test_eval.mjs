// Tests for the LLM experiment runner against a scripted fake Ollama server (so no Ollama is
// needed). The MCP server and the harness are real. Usage: node playground-plus/test_eval.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK, parseTextToolCall, toOllamaTools } from "./agent/agent.mjs";
import { createOllama, modelTraits } from "./agent/ollama.mjs";
import { formatSummary, main, runExperiment, summarize } from "./eval/run.mjs";
import { SAMPLE_SPEC } from "./test_fixtures.mjs";

const spec = SAMPLE_SPEC;
const broken = { ...spec, solution: "swap swap" };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- a fake Ollama

const toolCall = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });
const prose = (content) => ({ role: "assistant", content });
/** What each fake model says on its n-th turn (0-based, counted by the assistant messages already sent). */
const SCRIPTS = {
    "fake-good": [() => toolCall("get_bo_guide", {}), () => toolCall("validate_puzzle", broken), () => toolCall("validate_puzzle", spec), () => toolCall("submit_puzzle", spec)],
    "fake-text": [() => prose('```json\n{"name": "get_bo_guide", "arguments": {}}\n```'), () => prose("I cannot do this.")],
    "fake-nothing": [() => prose("Sure! Here is a puzzle: ...")],
    "fake-empty": [() => prose(""), () => toolCall("get_bo_guide", {}), () => toolCall("submit_puzzle", spec)],
    "fake-badtool": [() => toolCall("write_file", { path: "x" }), () => toolCall("validate_puzzle", { source: 42 }), () => prose("done")],
};
const requests = [];
const fake = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        const send = (body, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        if (req.url === "/api/tags") {
            return send({ models: [
                ...Object.keys(SCRIPTS).map((name) => ({ name, details: { parameter_size: "1B" }, capabilities: ["completion", "tools"] })),
                { name: "fake-notools", details: {}, capabilities: ["completion"] },
            ] });
        }
        if (req.url !== "/api/chat") return send({ error: "not found" }, 404);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        const script = SCRIPTS[body.model];
        if (!script) return send({ error: "model not found" }, 404);
        const turn = body.messages.filter((m) => m.role === "assistant").length;
        const message = (script[turn] ?? (() => prose("(nothing more to say)")))();
        send({ message, done: true, done_reason: "stop", prompt_eval_count: 100 + turn, eval_count: 10 });
    });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const host = `http://127.0.0.1:${fake.address().port}`;
const ollama = createOllama({ host });
const out = mkdtempSync(join(tmpdir(), "plus-eval-test-"));

// ---------------------------------------------------------------- the pieces

test("a model's tool call written as text is recognised only when it names a real tool", () => {
    const names = ["get_bo_guide", "validate_puzzle"];
    assert.deepEqual(parseTextToolCall('```json\n{"name": "get_bo_guide", "arguments": {}}\n```', names), { name: "get_bo_guide", arguments: {} });
    assert.deepEqual(parseTextToolCall('I will call {"name":"validate_puzzle","arguments":{"source":"x"}} now', names), { name: "validate_puzzle", arguments: { source: "x" } });
    assert.deepEqual(parseTextToolCall('{"function": {"name": "get_bo_guide", "parameters": {"a": 1}}}', names), { name: "get_bo_guide", arguments: { a: 1 } });
    assert.equal(parseTextToolCall('{"name": "delete_everything", "arguments": {}}', names), null);
    assert.equal(parseTextToolCall("no json here", names), null);
    assert.equal(parseTextToolCall("{broken json", names), null);
    assert.equal(parseTextToolCall('{"name": "get_bo_guide", "arguments": [1]}', names), null);
    assert.equal(parseTextToolCall(undefined, names), null);
});

test("tools become Ollama tool definitions, and some models get settings others would reject", () => {
    const [tool] = toOllamaTools([{ name: "t", description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } } } }, { name: "u" }]);
    assert.deepEqual(tool, { type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } } });
    assert.deepEqual(toOllamaTools([{ name: "u" }])[0].function.parameters, { type: "object", properties: {} });
    assert.deepEqual(modelTraits("gpt-oss:20b"), { think: "low" });
    assert.deepEqual(modelTraits("qwen3:14b"), { think: false });
    assert.deepEqual(modelTraits("qwen3.5:9b"), { think: false }, "thinking made a 9B model ramble for minutes and answer nothing");
    assert.deepEqual(modelTraits("qwen3-coder:30b"), {});
    assert.deepEqual(modelTraits("qwen2.5-coder:1.5b"), {}, "a model without thinking is not sent the setting");
});

test("the client lists models and reports a failing server clearly", async () => {
    const models = await ollama.listModels();
    assert.deepEqual(models.find((m) => m.name === "fake-good"), { name: "fake-good", parameterSize: "1B", capabilities: ["completion", "tools"] });
    await assert.rejects(() => ollama.chat({ model: "nope", messages: [{ role: "user", content: "x" }] }), /404.*model not found/);
    await assert.rejects(() => createOllama({ host: "127.0.0.1:9" }).listModels());
});

// ---------------------------------------------------------------- the experiment

test("an agent that reads the guide, fixes its draft and submits is accepted, and the run is described", async () => {
    const { results } = await runExperiment({ ollama, models: ["fake-good"], trials: 1, out, log: () => {} });
    const [run] = results;
    assert.equal(run.outcome, "accepted");
    assert.deepEqual(run.metrics.calls, { get_bo_guide: 1, validate_puzzle: 2, submit_puzzle: 1 });
    assert.equal(run.metrics.readGuideFirst, true);
    assert.equal(run.metrics.firstValidateOk, false, "the first draft was invalid");
    assert.equal(run.metrics.attemptsToValid, 2, "the second validate call was the first valid one");
    assert.equal(run.metrics.structuredCalls, 4);
    assert.equal(run.metrics.textCalls, 0);
    assert.equal(run.metrics.toolErrors, 0, "an invalid draft is reported as content, not as a tool failure");
});

test("what the agent is told: the server's instructions, the task, the tools, and room for the guide", async () => {
    const first = requests.find((r) => r.model === "fake-good");
    assert.equal(first.messages[0].role, "system");
    assert.match(first.messages[0].content, /get_bo_guide/);
    assert.deepEqual(first.messages[1], { role: "user", content: TASK });
    assert.deepEqual(first.tools.map((t) => t.function.name).sort(), [
        "get_bo_guide", "get_bo_reference", "get_brief", "get_session_history", "get_user_profile", "list_puzzles", "submit_puzzle", "validate_puzzle",
    ]);
    assert.ok(first.options.num_ctx >= 16384, "Ollama's default context would silently cut the guide");
    assert.equal(first.stream, false);
    assert.equal("think" in first, false, "no think setting for a model that has none");
    const later = requests.filter((r) => r.model === "fake-good").at(-1);
    const toolMessage = later.messages.find((m) => m.role === "tool");
    assert.equal(toolMessage.tool_name, "get_bo_guide");
    assert.match(toolMessage.content, /^# Writing puzzles for Bo Playground\+/);
});

test("the accepted puzzle is kept with the transcript, and transcripts are written", async () => {
    const files = readdirSync(out).sort();
    assert.ok(files.includes("fake-good-1.json") && files.includes("summary.json"));
    const saved = JSON.parse(readFileSync(join(out, "fake-good-1.json"), "utf8"));
    assert.equal(saved.stored.length, 1);
    assert.equal(saved.stored[0].title, "Shuffle #1 · fake-good", "the model's name is the author");
    assert.ok(saved.stored[0].source.startsWith(";@puzzle"));
    assert.ok(saved.steps.length === 4 && saved.messages.length > 8);
});

test("text tool calls are counted apart from structured ones, and they work unless the runner is strict", async () => {
    const lenient = await runExperiment({ ollama, models: ["fake-text"], trials: 1, out: join(out, "lenient"), log: () => {} });
    assert.deepEqual([lenient.results[0].metrics.textCalls, lenient.results[0].metrics.structuredCalls, lenient.results[0].metrics.calls], [1, 0, { get_bo_guide: 1 }]);
    assert.equal(lenient.results[0].outcome, "no-tool-call", "it then gave up in prose");
    const strict = await runExperiment({ ollama, models: ["fake-text"], trials: 1, lenient: false, out: join(out, "strict"), log: () => {} });
    assert.deepEqual([strict.results[0].metrics.textCalls, strict.results[0].metrics.turns], [0, 1], "a strict client sees no tool call at all");
});

test("an empty reply is answered with a nudge when the runner is told to, and ends the run when not", async () => {
    const without = await runExperiment({ ollama, models: ["fake-empty"], trials: 1, out: join(out, "empty0"), log: () => {} });
    assert.deepEqual([without.results[0].outcome, without.results[0].metrics.emptyRetries], ["no-tool-call", 0]);
    const retried = await runExperiment({ ollama, models: ["fake-empty"], trials: 1, agentOptions: { retryEmpty: 1 }, out: join(out, "empty1"), log: () => {} });
    assert.deepEqual([retried.results[0].outcome, retried.results[0].metrics.emptyRetries], ["accepted", 1]);
    const nudge = requests.filter((r) => r.model === "fake-empty").at(-1).messages.find((m) => m.role === "user" && m.content.startsWith("Please continue"));
    assert.ok(nudge, "the model was asked to carry on");
});

test("a model that only talks, and one that calls tools that do not exist or with bad arguments", async () => {
    const { results } = await runExperiment({ ollama, models: ["fake-nothing", "fake-badtool"], trials: 1, out: join(out, "bad"), log: () => {} });
    const [nothing, badtool] = results;
    assert.deepEqual([nothing.outcome, nothing.metrics.turns, nothing.metrics.readGuideFirst], ["no-tool-call", 1, null]);
    assert.equal(badtool.metrics.unknownTools, 1);
    assert.ok(badtool.metrics.toolErrors >= 2, "an unknown tool and a bad argument are both errors");
    assert.match(badtool.steps[0].calls[0].result, /no tool named "write_file"/);
    assert.equal(badtool.outcome, "no-tool-call");
});

test("the turn limit and an unreachable model server end a run without crashing", async () => {
    const endless = { ...SCRIPTS };
    SCRIPTS["fake-loop"] = [...Array(20)].map(() => () => toolCall("list_puzzles", {}));
    const { results } = await runExperiment({ ollama, models: ["fake-loop"], trials: 1, maxTurns: 3, out: join(out, "loop"), log: () => {} });
    delete SCRIPTS["fake-loop"];
    assert.deepEqual([results[0].outcome, results[0].metrics.turns, results[0].metrics.calls], ["max-turns", 3, { list_puzzles: 3 }]);
    const down = await runExperiment({ ollama: createOllama({ host: "127.0.0.1:9" }), models: ["fake-good"], trials: 1, out: join(out, "down"), log: () => {} });
    assert.equal(down.results[0].outcome, "error");
    assert.match(down.results[0].finalText, /fetch failed|ECONNREFUSED|connect/i);
    assert.deepEqual(Object.keys(endless), Object.keys(SCRIPTS));
});

test("the summary has a row per model and reads as a table", async () => {
    const rows = summarize([
        { model: "a", outcome: "accepted", metrics: { firstValidateOk: true, readGuideFirst: true, turns: 4, validateCalls: 1, attemptsToValid: 1, structuredCalls: 3, textCalls: 0, toolErrors: 0, ms: 10_000, outputTokens: 500 } },
        { model: "a", outcome: "max-turns", metrics: { firstValidateOk: false, readGuideFirst: false, turns: 14, validateCalls: 5, attemptsToValid: null, structuredCalls: 10, textCalls: 2, toolErrors: 4, ms: 30_000, outputTokens: 1500 } },
        { model: "b", outcome: "error", metrics: { firstValidateOk: null, readGuideFirst: null, turns: 0, validateCalls: 0, attemptsToValid: null, structuredCalls: 0, textCalls: 0, toolErrors: 0, ms: 0, outputTokens: 0 } },
    ]);
    assert.deepEqual(rows.map((r) => [r.model, r.trials, r.accepted, r.firstTryValid, r.avgTurns, r.avgAttemptsToValid, r.avgSeconds]), [["a", 2, 1, 1, 9, 1, 20], ["b", 1, 0, 0, 0, null, 0]]);
    assert.deepEqual(rows[0].outcomes, { accepted: 1, "max-turns": 1 });
    const table = formatSummary(rows);
    assert.match(table, /^model +ok +1st/);
    assert.match(table, /a +1\/2 +1\/2/);
});

// ---------------------------------------------------------------- the command

test("the command lists models, and fails with a clear message when Ollama or a model is missing", async () => {
    const lines = [];
    const log = console.log;
    const error = console.error;
    const warn = console.warn;
    console.log = (...args) => lines.push(args.join(" "));
    console.error = (...args) => lines.push(args.join(" "));
    console.warn = (...args) => lines.push(`warning: ${args.join(" ")}`);
    try {
        assert.equal(await main(["--host", host, "--list"], {}), 0);
        assert.ok(lines.some((l) => l.startsWith("fake-good")));
        lines.length = 0;
        assert.equal(await main(["--host", "127.0.0.1:9"], {}), 2);
        assert.match(lines.join("\n"), /Ollama is not reachable.*Nothing else in this project needs it/s);
        lines.length = 0;
        assert.equal(await main(["--host", host, "--models", "no-such-model"], {}), 2);
        assert.match(lines.join("\n"), /not installed: no-such-model[\s\S]*ollama pull no-such-model/);
        lines.length = 0;
        assert.equal(await main(["--host", host, "--models", "fake-good", "--trials", "0"], {}), 2);
        assert.match(lines.join("\n"), /--trials must be/);
        lines.length = 0;
        assert.equal(await main(["--host", host, "--models", "fake-good", "--think", "maybe"], {}), 2);
        assert.match(lines.join("\n"), /--think must be on, off, low, medium or high/);
    } finally {
        Object.assign(console, { log, error, warn });
    }
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (caught) {
        failed++;
        console.log(`FAIL ${name}\n${caught.stack.split("\n").slice(0, 8).join("\n")}`);
    }
}
fake.close();
fake.closeAllConnections();
rmSync(out, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
