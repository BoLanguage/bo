// Tests for the agent player, against a scripted fake Ollama (the machine, the service and the database are real).
// Usage: node playground-plus/test_agent_player.mjs (after `make wasm`)
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOllama } from "./agent/ollama.mjs";
import { AgentPlayError, boPrimer, createAgentPlayer } from "./agent-player.mjs";
import { openDatabase } from "./db.mjs";
import { createService } from "./service.mjs";
import { SAMPLE_SPEC } from "./test_fixtures.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const call = (name, args = {}) => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });
const prose = (content) => ({ role: "assistant", content });
const run = (line) => call("run_bo", { line });
const SCRIPTS = {
    solver: [() => run("-rot"), () => call("guess")],
    hinter: [() => call("hint"), () => call("hint"), () => run("-rot"), () => call("guess")],
    quitter: [() => call("give_up")],
    looper: () => run("1"),
    cheater: [() => run("(puzzle.last) TOP"), () => run("reveal"), () => run("-rot (puzzle.reveal) TOP"), () => call("give_up")],
    chatty: () => prose("I think the answer is -rot."),
    slow: [() => run("-rot"), () => call("guess")],
    talker: [() => ({ role: "assistant", content: "I will look up rot.", tool_calls: [{ function: { name: "look_up", arguments: { query: "rot" } } }] }), () => ({ role: "assistant", content: "Now try it.", tool_calls: [{ function: { name: "run_bo", arguments: { line: "-rot" } } }] }), () => call("guess")],
    thinker: [() => ({ ...run("-rot"), thinking: "The top value has to go to the bottom.\nSo it is -rot, not rot." }), () => call("guess")],
    looker: [() => call("look_up", { query: "rot" }), () => call("look_up", { query: "swap" }), () => call("look_up", { query: "over" }), () => call("look_up", { query: "nip" }), () => call("look_up", { query: "pick" }), () => call("give_up")],
    texter: [() => prose('{"name": "run_bo", "arguments": {"line": "-rot"}}'), () => prose('```json\n{"name": "guess", "arguments": {}}\n```')],
    endless: [() => run("(again) (again) PUSH again"), () => run("-rot"), () => call("guess")],
    leaver: [() => run("exit")],
    wrong: [() => run("swap"), () => call("guess"), () => call("give_up")],
    unknown: [() => call("fly"), () => call("run_bo", {}), () => run("-rot"), () => call("guess")],
    stumbler: [() => run("bogus"), () => call("give_up")],
};
const DELAYS = { slow: 500, talker: 80 };
const seen = [];
const fake = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        seen.push(body);
        const turn = body.messages.filter((m) => m.role === "assistant").length;
        if (DELAYS[body.model]) await new Promise((r) => setTimeout(r, DELAYS[body.model]));
        const script = SCRIPTS[body.model];
        const message = (typeof script === "function" ? script(turn) : script[turn]?.()) ?? prose("(nothing more)");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 5 }));
    });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const host = `http://127.0.0.1:${fake.address().port}`;

const MODELS = Object.keys(SCRIPTS).map((name) => ({ name, parameterSize: "9B" }));
const capabilities = async () => ({ available: true, reason: null, models: MODELS, model: "solver" });

/** A player over a database with one puzzle the person has played (`played: false` leaves it unplayed). */
async function create({ played = true, ...options } = {}) {
    const repository = openDatabase();
    const service = createService({ repository });
    const { id } = await service.submitSpec(SAMPLE_SPEC, { client: "test" });
    if (played) repository.endSession(repository.createSession({ puzzleId: id, role: "human" }), "solved");
    const player = createAgentPlayer({ repository, service, ollama: createOllama({ host }), capabilities, ...options });
    return { repository, service, player, id };
}
const finished = async (player, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const status = player.status();
        if (status.state !== "running") return status;
        if (Date.now() > deadline) throw new Error("the job did not finish");
        await new Promise((r) => setTimeout(r, 20));
    }
};
const agentSessions = (repository) => repository.sessionSummaries(100).filter((s) => s.role === "agent");
const rejects = async (promise, code, pattern) => {
    const error = await promise.then(() => null, (e) => e);
    assert.ok(error instanceof AgentPlayError, `an AgentPlayError, got ${error}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
};

test("the primer is the guide's Bo section, without the authoring tools", () => {
    const primer = boPrimer(createService({ repository: openDatabase() }).getGuide());
    assert.match(primer, /^## Bo in one minute/);
    assert.match(primer, /ifte/);
    assert.doesNotMatch(primer, /get_bo_reference|validate_puzzle|submit_puzzle/);
});

test("only a puzzle the person has played can be played by an agent, and only by an installed model", async () => {
    const fresh = await create({ played: false });
    await rejects(fresh.player.start({ puzzleId: fresh.id }), "unplayed", /Play that puzzle yourself first/);
    await rejects(fresh.player.start({ puzzleId: "nope" }), "puzzle", /does not exist/);
    await rejects(fresh.player.start({}), "puzzle", /does not exist/);
    const { player, id } = await create();
    await rejects(player.start({ puzzleId: id, model: "no-such-model" }), "model", /"no-such-model" is not installed/);
    const offline = await create({ capabilities: async () => ({ available: false, reason: "Ollama was not found.", models: [], model: null }) });
    await rejects(offline.player.start({ puzzleId: offline.id }), "unavailable", /Ollama was not found/);
    assert.equal(player.status().state, "idle");
    assert.equal(agentSessions(fresh.repository).length, 0);
});

test("the played puzzles are listed with how often an agent tried them", async () => {
    const { service, player, id } = await create();
    assert.deepEqual(service.listPlayedPuzzles().map((p) => [p.id, p.agentAttempts]), [[id, 0]]);
    await player.start({ puzzleId: id });
    await finished(player);
    assert.equal(service.listPlayedPuzzles()[0].agentAttempts, 1);
    const other = await create({ played: false });
    assert.deepEqual(other.service.listPlayedPuzzles(), [], "a new puzzle is not offered");
});

test("a model that solves it is recorded as an agent session, step by step, like a person's", async () => {
    const { player, repository, service, id } = await create();
    const started = await player.start({ puzzleId: id });
    assert.deepEqual([started.state, started.model, started.puzzle.id, started.maxTurns, started.timeoutMs], ["running", "solver", id, 20, 300000]);
    assert.deepEqual(player.limits, { maxTurns: 20, timeoutMs: 300000 });
    const done = await finished(player);
    assert.deepEqual([done.state, done.outcome], ["finished", "solved"]);
    assert.match(done.message, /^Solved it with 1 guess and 0 hints\.$/);
    assert.deepEqual(done.steps.map((s) => [s.kind, s.code]), [["run", "-rot"], ["guess", "guess"]]);
    assert.equal(done.steps[0].stack, "Stack: (1 2 3)");
    assert.equal(done.steps[1].solved, true);

    const [session] = agentSessions(repository);
    assert.deepEqual([session.client, session.outcome, session.guesses, session.hints, session.puzzleId], ["solver", "solved", 1, 0, id]);
    const events = repository.listEvents(repository.listSessions(id).find((s) => s.role === "agent").id);
    assert.deepEqual(events.map((e) => [e.type, e.code]), [["setup", null], ["evaluate", "-rot"], ["evaluate", "guess"]]);
    assert.equal(events[0].stack_after[0].items.length, 3, "the opening stacks are recorded, the puzzle's own are not");
    assert.ok(!events.some((e) => /puzzle\./.test(JSON.stringify(e.stack_after))));

    const stats = service.getStatistics();
    assert.equal(stats.you.played, 1, "the person's own statistics do not include the agent");
    assert.deepEqual(stats.agents.map((a) => [a.model, a.played, a.solved, a.solveRate]), [["solver", 1, 1, 1]]);
    assert.equal(stats.agents[0].meanWordsToSolve, 1);
    assert.equal(repository.listPuzzles()[0].played, true);
});

test("the model is told the goal and the stacks, never the source, and its first message is the puzzle", async () => {
    const { player, id } = await create();
    seen.length = 0;
    await player.start({ puzzleId: id });
    await finished(player);
    const first = seen.find((r) => r.model === "solver" && r.messages.length === 2);
    const [system, user] = first.messages;
    assert.match(user.content, /Goal: Reorder the stack so that 3 is on top/);
    assert.match(user.content, /Run `guess` to check your solution\./);
    assert.match(user.content, /Stack: \(2 3 1\)/);
    assert.doesNotMatch(user.content, /-rot|puzzle\./, "the answer is not in what the model reads");
    assert.match(system.content, /run_bo.*guess.*hint.*look_up.*give_up/s);
    assert.match(system.content, /at most 20 turns and 5 minutes/);
    assert.deepEqual(first.tools.map((t) => t.function.name), ["run_bo", "guess", "hint", "look_up", "give_up"]);
});

test("hints are used and counted against the model", async () => {
    const { player, repository, id } = await create();
    await player.start({ puzzleId: id, model: "hinter" });
    const done = await finished(player);
    assert.equal(done.outcome, "solved");
    assert.equal(done.steps[0].output, "The top value has to go down to the bottom.");
    const [session] = agentSessions(repository);
    assert.equal(session.hints, 2);
    assert.match(done.message, /2 hints/);
});

test("giving up, a wrong guess and a limit of turns are failures, and are recorded as such", async () => {
    const quitter = await create();
    await quitter.player.start({ puzzleId: quitter.id, model: "quitter" });
    const gave = await finished(quitter.player);
    assert.deepEqual([gave.outcome, gave.message, gave.steps.map((s) => s.kind)], ["revealed", "Gave up and asked for the answer.", ["give-up"]]);
    const [session] = agentSessions(quitter.repository);
    assert.equal(session.outcome, "revealed");
    assert.equal(session.revealed, true);

    const wrong = await create();
    await wrong.player.start({ puzzleId: wrong.id, model: "wrong" });
    const missed = await finished(wrong.player);
    assert.equal(missed.steps[1].output, "Not solved yet.");
    assert.equal(missed.steps[1].solved, false);
    assert.equal(missed.outcome, "revealed");

    const looping = await create({ limits: { maxTurns: 3 } });
    await looping.player.start({ puzzleId: looping.id, model: "looper" });
    const out = await finished(looping.player);
    assert.deepEqual([out.outcome, out.message, out.turn], ["abandoned", "Used all its turns without solving it.", 3]);
    const stats = looping.service.getStatistics().agents[0];
    assert.deepEqual([stats.played, stats.solved, stats.abandoned, stats.solveRate], [1, 0, 1, 0], "running out of turns counts against the model's solve rate");
    assert.equal(looping.service.getStatistics().you.solveRate, 1, "while a person who walks away does not");
});

test("the puzzle's inner workings and `reveal` are refused, and refused lines are not run", async () => {
    const { player, repository, id } = await create();
    seen.length = 0;
    await player.start({ puzzleId: id, model: "cheater" });
    const done = await finished(player);
    assert.equal(done.outcome, "revealed");
    assert.deepEqual(done.steps.map((s) => s.kind), ["give-up"], "only the give-up reached the machine");
    const replies = seen.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(replies[0], /part of the puzzle's own machinery/);
    assert.match(replies[1], /Call give_up/);
    assert.match(replies[2], /part of the puzzle's own machinery/);
    const events = repository.listEvents(repository.listSessions(id).find((s) => s.role === "agent").id);
    assert.deepEqual(events.map((e) => e.type), ["setup", "reveal"]);
});

test("a model that only talks is nudged a few times, then counted as having stopped", async () => {
    const { player, id } = await create();
    seen.length = 0;
    await player.start({ puzzleId: id, model: "chatty" });
    const done = await finished(player);
    assert.deepEqual([done.outcome, done.message], ["abandoned", "Stopped using the tools."]);
    assert.equal(seen.filter((r) => r.model === "chatty").length, 4, "the first reply and three nudges");
    assert.ok(done.steps.every((s) => s.kind === "say"));
});

test("a model that runs out of time is a failure; a limit also cuts a turn that is taking too long", async () => {
    const { player, repository, id } = await create({ limits: { timeoutMs: 700, turnTimeoutMs: 5000 } });
    await player.start({ puzzleId: id, model: "slow" });
    const done = await finished(player);
    assert.deepEqual([done.outcome, done.message], ["abandoned", "Ran out of time."]);
    assert.equal(agentSessions(repository).length, 1);
    const stuck = await create({ limits: { timeoutMs: 10_000, turnTimeoutMs: 100 } });
    await stuck.player.start({ puzzleId: stuck.id, model: "slow" });
    assert.equal((await finished(stuck.player)).message, "Got stuck: one move took too long.");
});

test("lookups are limited, and a tool call written as text works", async () => {
    const { player, id } = await create();
    seen.length = 0;
    await player.start({ puzzleId: id, model: "looker" });
    const done = await finished(player);
    assert.deepEqual(done.steps.map((s) => s.kind), ["lookup", "lookup", "lookup", "lookup", "give-up"]);
    assert.match(seen.at(-1).messages.filter((m) => m.role === "tool").at(4).content, /no more lookups/);
    const text = await create();
    await text.player.start({ puzzleId: text.id, model: "texter" });
    assert.equal((await finished(text.player)).outcome, "solved");
});

test("an endless line is stopped, and mistakes in a call are answered without ending the run", async () => {
    const { player, id } = await create({ budget: 3000 });
    await player.start({ puzzleId: id, model: "endless" });
    const done = await finished(player);
    assert.equal(done.outcome, "solved");
    assert.match(done.steps[0].error, /did not finish within 3000 steps/);
    const sloppy = await create();
    seen.length = 0;
    await sloppy.player.start({ puzzleId: sloppy.id, model: "unknown" });
    assert.equal((await finished(sloppy.player)).outcome, "solved");
    const replies = seen.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(replies[0], /there is no tool named "fly"/);
    assert.match(replies[1], /give the line of Bo to run/);
});

test("a finished run can be replayed from its record, but only while its puzzle is one the person has played", async () => {
    const { player, service, repository, id } = await create();
    await player.start({ puzzleId: id, model: "hinter" });
    const done = await finished(player);
    assert.equal(done.sessionId, repository.listSessions(id).find((s) => s.role === "agent").id);
    const [run] = service.listAgentRuns();
    assert.deepEqual([run.id, run.puzzleId, run.model, run.outcome, run.hints], [done.sessionId, id, "hinter", "solved", 2]);
    const replay = service.getAgentRun(run.id);
    assert.deepEqual(replay.steps.map((s) => [s.kind, s.code, s.error]), [
        ["hint", "hint", null], ["hint", "hint", null], ["run", "-rot", null], ["guess", "guess", null],
    ]);
    assert.ok(replay.steps.every((s, i) => i === 0 || s.at >= replay.steps[i - 1].at), "the steps are in time order, with their own times");
    assert.ok(replay.steps.every((s) => s.modelMs >= 0 && s.outputTokens === 5), "each step a model turn led to says how long the turn took");
    assert.deepEqual(replay.steps.map((s) => [s.output.startsWith("Solved") ? "Solved" : s.output, s.stack, s.solved]), [
        ["The top value has to go down to the bottom.", "Stack: (2 3 1)", false], ["`-rot` moves the top value down to third place.", "Stack: (2 3 1)", false],
        ["", "Stack: (1 2 3)", false], ["Solved", "Stack: (1 2 3)", true],
    ], "what each line printed and the stacks after it are there for a transcript");
    const gave = await create();
    await gave.player.start({ puzzleId: gave.id, model: "quitter" });
    await finished(gave.player);
    assert.deepEqual(gave.service.getAgentRun(gave.service.listAgentRuns()[0].id).steps.map((s) => s.kind), ["give-up"]);
    service.eraseMyHistory();
    assert.deepEqual(service.listAgentRuns(), [], "the puzzle is new again: a replay would show how to solve it");
    assert.equal(service.getAgentRun(run.id), null);
    assert.equal(service.getAgentRun("nope"), null);
});

test("what the model says and looks up is recorded with the time each turn took, so a replay has the talk and the pace", async () => {
    const { player, service, repository, id } = await create();
    await player.start({ puzzleId: id, model: "talker" });
    const done = await finished(player);
    assert.equal(done.outcome, "solved");
    const events = repository.listEvents(repository.listSessions(id).find((s) => s.role === "agent").id);
    assert.deepEqual(events.map((e) => [e.type, e.code]), [["setup", null], ["say", "I will look up rot."], ["lookup", "rot"], ["say", "Now try it."], ["evaluate", "-rot"], ["evaluate", "guess"]]);
    assert.deepEqual(events.map((e) => e.meta !== null), [false, true, false, true, false, true], "a turn's timing is kept once, with the first event it led to");
    assert.ok(events[1].meta.modelMs >= 70 && events[1].meta.turn === 1 && events[1].meta.promptTokens === 50);
    assert.ok(events.every((e) => e.puzzle_state !== null), "every event carries the play state, so the session's totals do not change");
    const { steps } = service.getAgentRun(done.sessionId);
    assert.deepEqual(steps.map((s) => [s.kind, s.code]), [["say", "I will look up rot."], ["lookup", "rot"], ["say", "Now try it."], ["run", "-rot"], ["guess", "guess"]]);
    assert.ok(steps[0].at >= 70, "the first remark came after the model's first turn");
    assert.equal(agentSessions(repository)[0].guesses, 1);
});

test("what a model thought before acting is recorded too, since it is often all it says", async () => {
    const { player, service, repository, id } = await create();
    await player.start({ puzzleId: id, model: "thinker" });
    const done = await finished(player);
    assert.equal(done.outcome, "solved");
    assert.deepEqual(done.steps.map((s) => [s.kind, s.text ?? s.code]), [["think", "The top value has to go to the bottom.\nSo it is -rot, not rot."], ["run", "-rot"], ["guess", "guess"]]);
    const events = repository.listEvents(repository.listSessions(id).find((s) => s.role === "agent").id);
    assert.deepEqual(events.map((e) => e.type), ["setup", "think", "evaluate", "evaluate"]);
    assert.ok(events[1].meta !== null, "the turn's timing is kept with the thought, the first event of the turn");
    assert.deepEqual(service.getAgentRun(done.sessionId).steps.map((s) => s.kind), ["think", "run", "guess"]);
});

test("an error is reported by its message, without the machine's error stack", async () => {
    const { player, id } = await create();
    seen.length = 0;
    await player.start({ puzzleId: id, model: "stumbler" });
    const done = await finished(player);
    assert.match(done.steps[0].error, /Existence-Error/);
    assert.equal(done.steps[0].stack, "Stack: (2 3 1)");
    assert.doesNotMatch(seen.at(-1).messages.filter((m) => m.role === "tool")[0].content, /DIAGNOSTICS/);
});

test("leaving the puzzle (exit) ends the run as abandoned", async () => {
    const { player, id } = await create();
    await player.start({ puzzleId: id, model: "leaver" });
    const done = await finished(player);
    assert.deepEqual([done.outcome, done.message], ["abandoned", "Left the puzzle (the machine was reset)."]);
});

test("one agent at a time; stopping one records nothing; a model that cannot be reached is not blamed", async () => {
    const { player, repository, id } = await create();
    await player.start({ puzzleId: id, model: "slow" });
    await rejects(player.start({ puzzleId: id }), "busy", /already playing/);
    const stopped = player.cancel();
    assert.equal(stopped.state, "cancelled");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(player.status().state, "cancelled");
    assert.equal(agentSessions(repository).length, 0, "a stopped run leaves no session");
    assert.equal((await player.start({ puzzleId: id })).state, "running", "a new job can follow");
    assert.equal((await finished(player)).outcome, "solved");

    const down = await create({ ollama: createOllama({ host: "http://127.0.0.1:9" }) });
    await down.player.start({ puzzleId: down.id });
    const failed = await finished(down.player);
    assert.equal(failed.state, "failed");
    assert.match(failed.message, /could not be used/);
    assert.equal(agentSessions(down.repository).length, 0);
    assert.equal(createAgentPlayer({ repository: down.repository, service: down.service, capabilities }).cancel().state, "idle");
});

test("the status can be read from a step on, and transcripts are kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plus-play-"));
    try {
        const { player, id } = await create({ transcriptDir: dir });
        await player.start({ puzzleId: id });
        const done = await finished(player);
        assert.equal(done.stepCount, 2);
        const later = player.status(1);
        assert.deepEqual([later.steps.length, later.steps[0].n, later.stepCount], [1, 2, 2]);
        const files = readdirSync(dir);
        assert.equal(files.length, 1);
        const saved = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
        assert.deepEqual([saved.model, saved.outcome, saved.steps.length], ["solver", "solved", 2]);
        assert.ok(saved.messages.length > 3, "what the model was told is kept, to see why it failed");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
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
