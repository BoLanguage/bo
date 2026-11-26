// Tests for the in-app puzzle generator, against a scripted fake Ollama (the MCP server, the service and the
// harness are real). Usage: node playground-plus/test_generator.mjs (after `make wasm`)
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOllama } from "./agent/ollama.mjs";
import { openDatabase } from "./db.mjs";
import { GeneratorError, chooseModel, createGenerator } from "./generator.mjs";
import { createService } from "./service.mjs";
import { SAMPLE_SPEC } from "./test_fixtures.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const toolCall = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });
const prose = (content) => ({ role: "assistant", content });
const GOOD = [() => toolCall("get_bo_guide", {}), () => toolCall("get_brief", {}), () => toolCall("submit_puzzle", SAMPLE_SPEC)];
/** A model's script: by turn, or a function of (turn, how many conversations it has started). */
const SCRIPTS = {
    "gemma4:12b": GOOD,
    "qwen3.5:9b": GOOD,
    "fake-nothing": [() => prose("I would rather not.")],
    "fake-flaky": (turn, conversation) => (conversation === 0 ? prose("Hmm.") : GOOD[turn]?.() ?? prose("done")),
    "fake-empty": [() => prose(""), ...GOOD],
    "fake-slow": GOOD,
    "fake-sluggish": GOOD,
    "big-model": GOOD,
};
const DELAYS = { "fake-slow": 400, "fake-sluggish": (conversation) => (conversation < 2 ? 800 : 0) };
const conversations = new Map();
const seen = [];
const fake = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
        const send = (body, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        if (req.url === "/api/tags") {
            return send({ models: [
                { name: "big-model", details: { parameter_size: "70B" }, capabilities: ["completion", "tools"] },
                { name: "qwen3.5:9b", details: { parameter_size: "9.0B" }, capabilities: ["completion", "tools", "thinking"] },
                { name: "gemma4:12b", details: { parameter_size: "11.9B" }, capabilities: ["completion", "tools"] },
                { name: "embedder", details: {}, capabilities: ["embedding"] },
                { name: "tiny-model", details: { parameter_size: "1.5B" }, capabilities: ["completion", "tools"] },
                ...["fake-nothing", "fake-flaky", "fake-empty", "fake-slow", "fake-sluggish"].map((name) => ({ name, details: { parameter_size: "9B" }, capabilities: ["completion", "tools"] })),
            ] });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        seen.push(body);
        const turn = body.messages.filter((m) => m.role === "assistant").length;
        if (turn === 0) conversations.set(body.model, (conversations.get(body.model) ?? -1) + 1);
        if (DELAYS[body.model]) await new Promise((r) => setTimeout(r, typeof DELAYS[body.model] === "function" ? DELAYS[body.model](conversations.get(body.model)) : DELAYS[body.model]));
        const script = SCRIPTS[body.model];
        const message = (typeof script === "function" ? script(turn, conversations.get(body.model)) : script[turn]?.()) ?? prose("(nothing more)");
        send({ message, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 5 });
    });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const host = `http://127.0.0.1:${fake.address().port}`;

const create = (options = {}) => {
    const repository = openDatabase();
    const service = createService({ repository });
    return { repository, service, generator: createGenerator({ repository, service, ollama: createOllama({ host }), ...options }) };
};
const finished = async (generator, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const status = generator.status();
        if (status.state !== "running") return status;
        if (Date.now() > deadline) throw new Error("the job did not finish");
        await new Promise((r) => setTimeout(r, 25));
    }
};
const rejects = async (promise, code, pattern) => {
    const error = await promise.then(() => null, (e) => e);
    assert.ok(error instanceof GeneratorError, `a GeneratorError, got ${error}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
};

test("the model to use: a measured one if installed, else a tool-capable one that fits a common GPU", () => {
    const m = (name, parameterSize) => ({ name, parameterSize });
    assert.equal(chooseModel([m("a", "70B"), m("qwen3.5:9b", "9B"), m("gemma4:12b", "11.9B")]), "gemma4:12b");
    assert.equal(chooseModel([m("a", "70B"), m("qwen3.5:9b", "9B")]), "qwen3.5:9b");
    assert.equal(chooseModel([m("huge", "70B"), m("mid", "13B"), m("small", "3B")]), "mid", "the biggest that fits 16 GB");
    assert.equal(chooseModel([m("huge", "70B"), m("bigger", "120B")]), "huge", "nothing fits: the first");
    assert.equal(chooseModel([m("unknown", null)]), "unknown");
    assert.equal(chooseModel([]), null);
});

test("what is available: the models that can use tools, the default, and why not when nothing is", async () => {
    const { generator } = create();
    const caps = await generator.capabilities();
    assert.equal(caps.available, true);
    assert.equal(caps.model, "gemma4:12b");
    assert.ok(!caps.models.some((m) => m.name === "embedder"), "a model without tools is not offered");
    assert.ok(!caps.models.some((m) => m.name === "tiny-model"), "nor is one too small to write puzzles (under 7B)");
    await rejects(create().generator.start({ model: "tiny-model" }), "model", /"tiny-model" is not installed/);
    assert.deepEqual(caps.models.map((m) => m.name).slice(0, 3), ["gemma4:12b", "qwen3.5:9b", "big-model"], "measured models first, then the rest by name");
    const none = await create({ ollama: createOllama({ host: "http://127.0.0.1:9" }) }).generator.capabilities();
    assert.deepEqual([none.available, none.models, none.model], [false, [], null]);
    assert.match(none.reason, /Ollama was not found at http:\/\/127\.0\.0\.1:9\. Install it from https:\/\/ollama\.com.*ollama pull gemma4:12b/);
    const noBuild = await create({ buildExists: () => false }).generator.capabilities();
    assert.match(noBuild.reason, /WebAssembly build is missing/);
});

test("a puzzle is written in the background: the job reports progress, the puzzle is stored and the request answered", async () => {
    const { generator, repository } = create();
    assert.deepEqual(generator.status(), { state: "idle" });
    const started = await generator.start({ preferences: { tags: ["shuffle"] } });
    assert.deepEqual([started.state, started.model, started.attempt, started.attempts], ["running", "gemma4:12b", 1, 3]);
    assert.equal(repository.pendingRequest().id, started.requestId, "the player's request waits while it runs");
    const done = await finished(generator);
    assert.equal(done.state, "done");
    assert.equal(done.puzzle.title, "Shuffle #1 · gemma4:12b", "the model's name is the author");
    assert.equal(repository.listPuzzleSummaries().length, 1);
    const request = repository.getRequest(started.requestId);
    assert.deepEqual([request.status, request.puzzleId, request.preferences], ["fulfilled", done.puzzle.id, { tags: ["shuffle"] }]);
    assert.equal(done.tool, "submit_puzzle");
    assert.ok(done.turn >= 3);
    assert.equal(repository.getPuzzle(done.puzzle.id).package.provenance.client, "gemma4:12b");
});

test("only one puzzle is written at a time, and the player may choose the model", async () => {
    const { generator } = create();
    await generator.start({ model: "fake-slow" });
    await rejects(generator.start({}), "busy", /already being written/);
    assert.equal((await finished(generator)).model, "fake-slow");
    assert.equal((await generator.start({ model: "qwen3.5:9b" })).model, "qwen3.5:9b", "a new job can start once the last one ended");
    await finished(generator);
});

test("bad requests are refused before anything starts", async () => {
    const { generator, repository } = create();
    await rejects(generator.start({ model: "no-such-model" }), "model", /"no-such-model" is not installed\. Installed: .*gemma4:12b/);
    await rejects(generator.start({ model: "embedder" }), "model", /not installed/);
    await rejects(generator.start({ preferences: { tags: ["magic"] } }), "preferences", /tags must be/);
    await rejects(generator.start({ preferences: { kind: "define" } }), "preferences", /unknown preference/);
    const offline = create({ ollama: createOllama({ host: "http://127.0.0.1:9" }) });
    await rejects(offline.generator.start({}), "unavailable", /Ollama was not found/);
    assert.equal(repository.pendingRequest(), null, "nothing was recorded");
    assert.equal(generator.status().state, "idle");
});

test("a failed try is repeated, up to three times, and a last failure is reported with the request withdrawn", async () => {
    const flaky = create();
    await flaky.generator.start({ model: "fake-flaky" });
    const recovered = await finished(flaky.generator);
    assert.deepEqual([recovered.state, recovered.attempt], ["done", 2]);

    const { generator, repository } = create();
    const job = await generator.start({ model: "fake-nothing" });
    const failed = await finished(generator);
    assert.deepEqual([failed.state, failed.attempt, failed.attempts, failed.message], ["failed", 3, 3, "The model stopped without writing a puzzle."]);
    assert.equal(repository.getRequest(job.requestId).status, "cancelled", "nobody will answer it");
    assert.equal(repository.listPuzzleSummaries().length, 0);
    // another job can follow
    await generator.start({ model: "gemma4:12b" });
    assert.equal((await finished(generator)).state, "done");
});

test("a try that gets stuck is given up on and restarted quietly, one level easier each time, and tried in a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plus-gen-"));
    try {
        for (let i = 0; i < 40; i++) writeFileSync(join(dir, `0000-old-${String(i).padStart(2, "0")}.json`), "{}");
        const { generator } = create({ turnTimeoutMs: 250, transcriptDir: dir });
        await generator.start({ model: "fake-sluggish" });
        const done = await finished(generator);
        assert.deepEqual([done.state, done.attempt], ["done", 3], "two stuck tries, then a good one");
        const briefs = seen.filter((r) => r.model === "fake-sluggish").flatMap((r) => r.messages).filter((m) => m.role === "tool" && m.content.startsWith("Brief for your next puzzle")).map((m) => m.content);
        assert.ok(briefs.length >= 1 && briefs.every((text) => /an earlier try at a harder puzzle did not work out/.test(text)), "the retries were told to make it easier");

        const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        assert.ok(files.length <= 30, "only the newest transcripts are kept");
        const mine = files.filter((f) => f.includes("fake-sluggish"));
        assert.equal(mine.length, 3, "one file per try");
        const last = JSON.parse(readFileSync(join(dir, mine.sort().at(-1)), "utf8"));
        assert.deepEqual([last.model, last.attempt, last.outcome], ["fake-sluggish", 3, "accepted"]);
        const first = JSON.parse(readFileSync(join(dir, mine.sort()[0]), "utf8"));
        assert.equal(first.outcome, "error", "a turn that timed out");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    // when every try is stuck the player is told so
    const stuck = create({ turnTimeoutMs: 100, attempts: 2 });
    await stuck.generator.start({ model: "fake-slow" });
    const failed = await finished(stuck.generator);
    assert.deepEqual([failed.state, failed.message], ["failed", "The model got stuck and took too long."]);
});

test("an empty reply is answered with a nudge instead of ending the run", async () => {
    const { generator } = create();
    await generator.start({ model: "fake-empty" });
    const done = await finished(generator);
    assert.deepEqual([done.state, done.attempt], ["done", 1], "no second try was needed");
    const nudged = seen.filter((r) => r.model === "fake-empty").some((r) => r.messages.some((m) => m.role === "user" && m.content.startsWith("Please continue")));
    assert.ok(nudged);
});

test("cancelling stops the job, withdraws the request and stores nothing", async () => {
    const { generator, repository } = create();
    const job = await generator.start({ model: "fake-slow" });
    const cancelled = generator.cancel();
    assert.equal(cancelled.state, "cancelled");
    assert.equal(repository.getRequest(job.requestId).status, "cancelled");
    await new Promise((r) => setTimeout(r, 1500)); // the run notices and stops
    assert.equal(generator.status().state, "cancelled");
    assert.equal(repository.listPuzzleSummaries().length, 0);
    assert.equal(generator.cancel().state, "cancelled", "cancelling again changes nothing");
    assert.equal(create().generator.cancel().state, "idle");
});

test("the model gets the settings it needs, and the puzzle's author is its name", async () => {
    const { generator } = create();
    await generator.start({ model: "qwen3.5:9b" });
    await finished(generator);
    const request = seen.filter((r) => r.model === "qwen3.5:9b").at(-1);
    assert.equal(request.think, false, "thinking is off for qwen3.5");
    assert.ok(request.options.num_ctx >= 16384);
    assert.ok(request.tools.some((t) => t.function.name === "get_brief"));
});

fake.unref();
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
