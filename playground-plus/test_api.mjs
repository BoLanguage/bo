// Tests for Playground+'s API. Usage: node playground-plus/test_api.mjs
import assert from "node:assert/strict";
import { request } from "node:http";
import { AgentPlayError } from "./agent-player.mjs";
import { createOllama } from "./agent/ollama.mjs";
import { openDatabase } from "./db.mjs";
import { GeneratorError } from "./generator.mjs";
import { startServer } from "./server.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const running = await startServer();
const { url, repository } = running;
repository.addPuzzle({ id: "p1", title: "T", goal: "G", source: "1 2 +", hints: 1, package: {} });

const json = { "content-type": "application/json" };
const call = async (method, path, body, headers = json) => {
    const res = await fetch(url + path.slice(1), { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
};
/** A raw request, to control headers fetch would not let us set. */
const raw = (method, path, headers, body = "", base = url) =>
    new Promise((resolve, reject) => {
        const { hostname, port } = new URL(base);
        const req = request({ hostname, port, path, method, headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        req.end(body);
    });
const newSession = async (extra = {}) => (await call("POST", "/api/sessions", { puzzleId: "p1", client: "test", boVersion: "0.7.0", ...extra })).body.id;
const ev = (type, extra = {}) => ({ type, time: Date.now(), duration: 3, ...extra });

test("puzzles are listed without their package", async () => {
    const { status, body } = await call("GET", "/api/puzzles");
    assert.equal(status, 200);
    assert.deepEqual(body.puzzles, [{ id: "p1", title: "T", goal: "G", description: "", hints: 1, source: "1 2 +", played: false }]);
    // once the player has a session on it, it is a past puzzle
    const session = repository.createSession({ puzzleId: "p1" });
    assert.equal((await call("GET", "/api/puzzles")).body.puzzles[0].played, true);
    repository.endSession(session, "abandoned");
    repository.addPuzzle({ id: "p9", title: "N", goal: "G", source: "x", package: {} });
    repository.createSession({ puzzleId: "p9", role: "agent" });
    assert.equal((await call("GET", "/api/puzzles")).body.puzzles.find((p) => p.id === "p9").played, false, "an agent's session does not make it a past puzzle");
});

test("a session is created for a known puzzle with a valid role", async () => {
    const created = await call("POST", "/api/sessions", { puzzleId: "p1", client: "page", boVersion: "0.7.0" });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^[0-9a-f-]{36}$/);
    const session = repository.getSession(created.body.id);
    assert.deepEqual([session.puzzle_id, session.role, session.client, session.bo_version], ["p1", "human", "page", "0.7.0"]);
    assert.equal((await call("POST", "/api/sessions", { puzzleId: "nope" })).status, 404);
    assert.equal((await call("POST", "/api/sessions", {})).status, 400);
    assert.equal((await call("POST", "/api/sessions", { puzzleId: "p1", role: "alien" })).status, 400);
    assert.equal((await call("POST", "/api/sessions", { puzzleId: "p1", client: "x".repeat(101) })).status, 400);
});

test("events are validated and stored in order", async () => {
    const id = await newSession();
    const stored = await call("POST", `/api/sessions/${id}/events`, {
        events: [ev("setup"), ev("evaluate", { code: "rot guess", ok: true, stackAfter: [{ name: "", depth: 3 }], puzzleState: { guesses: 1, last: 2 } })],
    });
    assert.deepEqual([stored.status, stored.body.stored], [200, 2]);
    await call("POST", `/api/sessions/${id}/events`, { events: [ev("evaluate", { code: "1", ok: false, error: "x" })] });
    const rows = repository.listEvents(id);
    assert.deepEqual(rows.map((r) => [r.seq, r.type, r.code]), [[1, "setup", null], [2, "evaluate", "rot guess"], [3, "evaluate", "1"]]);
    assert.deepEqual(rows[1].puzzle_state, { guesses: 1, last: 2 });
    assert.equal(rows[2].ok, false);
});

test("malformed events are rejected and nothing is stored", async () => {
    const id = await newSession();
    const post = (events) => call("POST", `/api/sessions/${id}/events`, { events });
    for (const events of [
        [], "x", [1], [{ type: "evaluate" }], [ev("not a word")], [ev("evaluate", { time: -1 })], [ev("evaluate", { duration: -5 })],
        [ev("evaluate", { ok: "yes" })], [ev("evaluate", { code: 5 })], [ev("evaluate", { stackAfter: {} })],
        [ev("evaluate", { puzzleState: [] })], [ev("evaluate", { code: "x".repeat(100_001) })],
        Array.from({ length: 501 }, () => ev("evaluate")),
    ]) assert.equal((await post(events)).status, 400, JSON.stringify(events).slice(0, 80));
    assert.equal(repository.listEvents(id).length, 0);
    assert.equal((await call("POST", `/api/sessions/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/events`, { events: [ev("setup")] })).status, 404);
});

test("a session ends once, with any known outcome the client reports", async () => {
    const id = await newSession();
    assert.equal((await call("POST", `/api/sessions/${id}/end`, { outcome: "won" })).status, 400);
    assert.equal((await call("POST", `/api/sessions/${id}/end`, { outcome: "solved" })).status, 200);
    assert.equal(repository.getSession(id).outcome, "solved");
    assert.equal((await call("POST", `/api/sessions/${id}/end`, { outcome: "skipped" })).status, 409);
    assert.equal((await call("POST", `/api/sessions/${id}/events`, { events: [ev("evaluate")] })).status, 409);
    for (const outcome of ["abandoned", "revealed", "skipped"]) {
        const other = await newSession();
        assert.equal((await call("POST", `/api/sessions/${other}/end`, { outcome })).status, 200, outcome);
        assert.equal(repository.getSession(other).outcome, outcome);
    }
});

test("the generator endpoints: what is available, start, progress, cancel, and each refusal as an HTTP error", async () => {
    const calls = [];
    const refusals = { busy: "busy", unavailable: "unavailable", model: "model", preferences: "preferences" };
    const generator = {
        capabilities: async () => ({ available: true, reason: null, models: [{ name: "m1", parameterSize: "9B" }], model: "m1" }),
        status: () => ({ state: "idle" }),
        start: async (options) => {
            calls.push(options);
            if (refusals[options.model]) throw new GeneratorError(refusals[options.model], `refused: ${options.model}`);
            return { state: "running", model: options.model ?? "m1" };
        },
        cancel: () => ({ state: "cancelled" }),
    };
    const own = await startServer({ generator });
    const ask = async (method, path, body) => {
        const res = await fetch(own.url + path.slice(1), { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    try {
        const state = await ask("GET", "/api/generator");
        assert.deepEqual(state.body, { available: true, reason: null, models: [{ name: "m1", parameterSize: "9B" }], model: "m1", hasHistory: false, job: { state: "idle" } });
        own.repository.addPuzzle({ id: "p", title: "T", goal: "G", source: "x", package: { tags: [], difficulty: 1 } });
        own.repository.endSession(own.repository.createSession({ puzzleId: "p" }), "solved");
        assert.equal((await ask("GET", "/api/generator")).body.hasHistory, true, "the player has played");

        const started = await ask("POST", "/api/generate", { preferences: { tags: ["list"] }, model: "m1" });
        assert.equal(started.status, 202);
        assert.deepEqual(calls.at(-1), { preferences: { tags: ["list"] }, model: "m1" });
        assert.equal((await ask("POST", "/api/generate", {})).status, 202, "everything is optional");
        for (const [model, status] of [["busy", 409], ["unavailable", 503], ["model", 400], ["preferences", 400]]) {
            const refused = await ask("POST", "/api/generate", { model });
            assert.deepEqual([refused.status, refused.body.error], [status, `refused: ${model}`]);
        }
        assert.equal((await ask("POST", "/api/generate", { model: 5 })).status, 400);
        assert.equal((await ask("POST", "/api/generate", { model: "x".repeat(101) })).status, 400);
        assert.equal((await ask("GET", "/api/generate/status")).body.job.state, "idle");
        assert.equal((await ask("POST", "/api/generate/cancel", {})).body.job.state, "cancelled");
        assert.equal((await ask("GET", "/api/generate")).status, 405);
        assert.equal((await ask("POST", "/api/generate", "x")).status, 400, "the body must be an object");
        const foreign = await raw("POST", "/api/generate", { ...json, origin: "http://evil.example" }, "{}", own.url);
        assert.equal(foreign.status, 403, "another web page cannot start generation");
        assert.equal((await fetch(own.url + "api/generate", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    } finally {
        await own.close();
    }
    // a server without a generator says so, and does nothing
    const bare = await startServer({ generator: null });
    try {
        const res = await fetch(bare.url + "api/generator");
        assert.deepEqual((await res.json()).available, false);
        const start = await fetch(bare.url + "api/generate", { method: "POST", headers: json, body: "{}" });
        assert.equal(start.status, 503);
    } finally {
        await bare.close();
    }
});

test("the agent-play endpoints: the played puzzles, start, steps from a point, cancel, refusals, and one model at a time", async () => {
    const calls = [];
    let writing = "idle";
    let playing = "idle";
    const generator = {
        capabilities: async () => ({ available: true, reason: null, models: [{ name: "m1", parameterSize: "9B" }], model: "m1" }),
        status: () => ({ state: writing }),
        start: async () => ({ state: "running" }),
        cancel: () => ({ state: "cancelled" }),
    };
    const agentPlayer = {
        capabilities: async () => ({ available: true, reason: null, models: [{ name: "m1", parameterSize: "9B" }], model: "m1" }),
        status: (since) => ({ state: playing, since, steps: [], stepCount: 0 }),
        start: async (options) => {
            calls.push(options);
            if (options.puzzleId === "new") throw new AgentPlayError("unplayed", "play it first");
            if (options.puzzleId === "gone") throw new AgentPlayError("puzzle", "no such puzzle");
            if (options.puzzleId === "busy") throw new AgentPlayError("busy", "busy");
            return { state: "running", model: options.model ?? "m1" };
        },
        cancel: () => ({ state: "cancelled" }),
    };
    const own = await startServer({ generator, agentPlayer });
    const ask = async (method, path, body) => {
        const res = await fetch(own.url + path.slice(1), { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    try {
        own.repository.addPuzzle({ id: "played", title: "Played", goal: "G", source: "x", package: { tags: ["list"], difficulty: 2 } });
        own.repository.addPuzzle({ id: "new", title: "New", goal: "G", source: "x", package: { tags: [], difficulty: 1 } });
        own.repository.endSession(own.repository.createSession({ puzzleId: "played" }), "solved");
        const state = (await ask("GET", "/api/agent-play")).body;
        assert.deepEqual(state.puzzles, [{ id: "played", title: "Played", tags: ["list"], difficulty: 2, agentAttempts: 0 }], "only a played puzzle is offered, without its source");
        assert.deepEqual([state.available, state.model, state.job.state], [true, "m1", "idle"]);

        assert.equal((await ask("POST", "/api/agent-play", { puzzleId: "played", model: "m1" })).status, 202);
        assert.deepEqual(calls.at(-1), { puzzleId: "played", model: "m1" });
        for (const [puzzleId, status] of [["new", 403], ["gone", 404], ["busy", 409]]) assert.equal((await ask("POST", "/api/agent-play", { puzzleId })).status, status);
        assert.equal((await ask("POST", "/api/agent-play", {})).status, 400, "a puzzle is needed");
        assert.equal((await ask("POST", "/api/agent-play", { puzzleId: "played", model: 5 })).status, 400);
        assert.equal((await ask("GET", "/api/agent-play/status?since=4")).body.job.since, 4);
        assert.equal((await ask("GET", "/api/agent-play/status?since=-1")).body.job.since, 0);
        assert.equal((await ask("GET", "/api/agent-play/status?since=abc")).body.job.since, 0);
        assert.equal((await ask("POST", "/api/agent-play/cancel", {})).body.job.state, "cancelled");

        writing = "running";
        const refused = await ask("POST", "/api/agent-play", { puzzleId: "played" });
        assert.deepEqual([refused.status, refused.body.error], [409, "A puzzle is being written: wait for it to finish, or stop it."]);
        writing = "idle";
        playing = "running";
        assert.equal((await ask("POST", "/api/generate", {})).status, 409, "and the other way round");
        playing = "idle";
        const foreign = await raw("POST", "/api/agent-play", { ...json, origin: "http://evil.example" }, JSON.stringify({ puzzleId: "played" }), own.url);
        assert.equal(foreign.status, 403, "another web page cannot start an agent");
    } finally {
        await own.close();
    }
    const bare = await startServer({ generator: null });
    try {
        const res = await (await fetch(bare.url + "api/agent-play")).json();
        assert.deepEqual([res.available, res.job.state], [false, "idle"]);
        assert.equal((await fetch(bare.url + "api/agent-play", { method: "POST", headers: json, body: JSON.stringify({ puzzleId: "x" }) })).status, 503);
    } finally {
        await bare.close();
    }
    // the player the server makes itself answers with the generator's capabilities (here: no Ollama)
    const offline = await startServer({ ollama: createOllama({ host: "http://127.0.0.1:9" }) });
    try {
        const res = await (await fetch(offline.url + "api/agent-play")).json();
        assert.deepEqual([res.available, res.job.state, res.limits], [false, "idle", { maxTurns: 20, timeoutMs: 300000 }]);
        assert.match(res.reason, /Ollama was not found/);
    } finally {
        await offline.close();
    }
});

test("recorded agent runs are listed and served for replay, and only for puzzles the player has played", async () => {
    const own = await startServer({ generator: null });
    const ask = async (path) => {
        const res = await fetch(own.url + path.slice(1));
        return { status: res.status, body: await res.json() };
    };
    try {
        const { repository: repo } = own;
        repo.addPuzzle({ id: "pp", title: "Played", goal: "G", source: "x", package: { tags: [], difficulty: 1 } });
        repo.addPuzzle({ id: "np", title: "Never played", goal: "G", source: "x", package: { tags: [], difficulty: 1 } });
        repo.endSession(repo.createSession({ puzzleId: "pp", role: "human" }), "solved");
        const run = (puzzleId, outcome) => {
            const id = repo.createSession({ puzzleId, role: "agent", client: "m1" });
            repo.addEvents(id, [{ type: "setup", time: 1 }, { type: "evaluate", time: 2, code: "swap", ok: true }, { type: "evaluate", time: 3, code: "guess", ok: true }]);
            repo.endSession(id, outcome);
            return id;
        };
        const good = run("pp", "solved");
        const spoiler = run("np", "solved");
        const listed = (await ask("/api/agent-play/runs")).body.runs;
        assert.deepEqual(listed.map((r) => [r.id, r.model, r.outcome, r.title]), [[good, "m1", "solved", "Played"]]);
        const served = await ask(`/api/agent-play/runs/${good}`);
        assert.deepEqual([served.status, served.body.run.puzzleId, served.body.steps], [200, "pp", [
            { kind: "run", code: "swap", error: null, at: 1, output: "", stack: "", solved: false },
            { kind: "guess", code: "guess", error: null, at: 2, output: "", stack: "", solved: false },
        ]]);
        assert.equal((await ask(`/api/agent-play/runs/${spoiler}`)).status, 404, "its puzzle is new to the player");
        assert.equal((await ask("/api/agent-play/runs/00000000-0000-0000-0000-000000000000")).status, 404);
    } finally {
        await own.close();
    }
});

test("a player's request for a puzzle is validated, replaces the one before, and can be cancelled once", async () => {
    assert.equal((await call("GET", "/api/requests/pending")).body.request, null);
    const made = await call("POST", "/api/requests", { preferences: { tags: ["list", "recursion"], change: "harder" } });
    assert.equal(made.status, 201);
    assert.match(made.body.id, /^[0-9a-f-]{36}$/);
    const pending = (await call("GET", "/api/requests/pending")).body.request;
    assert.deepEqual([pending.id, pending.preferences], [made.body.id, { tags: ["list", "recursion"], change: "harder" }]);
    const replaced = await call("POST", "/api/requests", {});
    assert.equal(replaced.status, 201, "no preferences is fine");
    assert.equal(repository.getRequest(made.body.id).status, "cancelled");
    assert.deepEqual((await call("GET", "/api/requests/pending")).body.request.preferences, {});
    for (const preferences of [{ tags: ["magic"] }, { tags: "list" }, { change: "wild" }, { kind: "define" }, [], "x", { tags: ["list", "list"] }, { tags: ["list", "shuffle", "recursion", "arithmetic"] }])
        assert.equal((await call("POST", "/api/requests", { preferences })).status, 400, JSON.stringify(preferences));
    assert.equal((await call("POST", "/api/requests", "{}", { "content-type": "text/plain" })).status, 415);
    assert.equal(repository.pendingRequest().id, replaced.body.id, "bad requests changed nothing");
    assert.equal((await call("POST", `/api/requests/${replaced.body.id}/cancel`, {})).status, 200);
    assert.equal((await call("POST", `/api/requests/${replaced.body.id}/cancel`, {})).status, 409);
    assert.equal((await call("POST", "/api/requests/00000000-0000-0000-0000-000000000000/cancel", {})).status, 404);
    assert.equal((await call("GET", "/api/requests/pending")).body.request, null);
    assert.equal((await raw("POST", "/api/requests", { ...json, origin: "http://evil.example" }, "{}")).status, 403);
});

test("the profile: statistics, the player's data, and erasing it only with a confirmation", async () => {
    const stats = await call("GET", "/api/profile");
    assert.equal(stats.status, 200);
    assert.deepEqual(Object.keys(stats.body).sort(), ["agents", "data", "you"]);
    assert.ok(stats.body.you.played >= 1, "the sessions made by the tests above");
    const exported = await call("GET", "/api/profile/export");
    assert.equal(exported.status, 200);
    assert.match(exported.body.about, /Nothing else is stored about you/);
    assert.ok(exported.body.sessions.length >= 1);
    assert.equal((await call("POST", "/api/profile/erase", {})).status, 400, "no confirmation, no erasing");
    assert.equal((await call("POST", "/api/profile/erase", { confirm: "yes" })).status, 400);
    assert.equal(repository.humanHistoryCounts().sessions >= 1, true);
    assert.equal((await raw("POST", "/api/profile/erase", { ...json, origin: "http://evil.example" }, '{"confirm":true}')).status, 403, "another web page cannot erase it");
    const erased = await call("POST", "/api/profile/erase", { confirm: true });
    assert.equal(erased.status, 200);
    assert.ok(erased.body.sessions >= 1);
    assert.deepEqual((await call("GET", "/api/profile/export")).body.sessions, []);
    assert.equal((await call("GET", "/api/profile")).body.you.played, 0);
});

test("requests must be JSON objects of reasonable size", async () => {
    const id = await newSession();
    assert.equal((await call("POST", "/api/sessions", { puzzleId: "p1" }, {})).status, 415);
    assert.equal((await call("POST", "/api/sessions", { puzzleId: "p1" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await call("POST", "/api/sessions", "{not json")).status, 400);
    assert.equal((await call("POST", "/api/sessions", "[]")).status, 400);
    assert.equal((await call("POST", `/api/sessions/${id}/events`, { events: [ev("evaluate", { code: "x".repeat(900_000), stackAfter: [] })], pad: "y".repeat(300_000) })).status, 413);
});

test("a request from another origin is refused, one from this origin or without an Origin is served", async () => {
    const { host } = new URL(url);
    const body = JSON.stringify({ puzzleId: "p1" });
    const headers = (origin) => ({ host, "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(origin ? { origin } : {}) });
    assert.equal((await raw("POST", "/api/sessions", headers("http://evil.example"), body)).status, 403);
    assert.equal((await raw("GET", "/api/puzzles", { host, origin: "http://evil.example" })).status, 403);
    assert.equal((await raw("POST", "/api/sessions", headers(`http://${host}`), body)).status, 201);
    assert.equal((await raw("POST", "/api/sessions", headers(), body)).status, 201);
});

test("the stream announces puzzles stored by anyone sharing the database, and only to same-origin readers", async () => {
    const repository = openDatabase();
    repository.addPuzzle({ id: "before", title: "Before", goal: "g", source: "s", package: {} });
    const own = await startServer({ watchMs: 20, repository });
    try {
        const res = await fetch(`${own.url}api/stream`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /^text\/event-stream/);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let received = "";
        const until = async (pattern) => {
            const deadline = Date.now() + 3000;
            while (!pattern.test(received)) {
                const chunk = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now())))]);
                if (chunk.timeout || chunk.done) break;
                received += decoder.decode(chunk.value);
            }
            return pattern.test(received);
        };
        assert.ok(await until(/: connected/), "it greets the client");
        assert.equal(own.stream.clients, 1);
        own.repository.addPuzzle({ id: "streamed-1", title: "Streamed", goal: "g", source: "s", package: {} });
        assert.ok(await until(/event: puzzle\ndata: \{"id":"streamed-1","title":"Streamed"\}\n\n/), received);
        assert.doesNotMatch(received, /"before"/, "puzzles stored before the connection are not announced");
        await reader.cancel();

        const { host } = new URL(own.url);
        assert.equal((await raw("GET", "/api/stream", { host, origin: "http://evil.example" }, "", own.url)).status, 403);
        assert.equal((await raw("POST", "/api/stream", { host }, "", own.url)).status, 405);
    } finally {
        await own.close();
        repository.close();
    }
});

test("unknown API paths are 404, wrong methods 405, and there is no cross-origin preflight", async () => {
    assert.equal((await call("GET", "/api/nothing")).status, 404);
    assert.equal((await call("DELETE", "/api/puzzles")).status, 405);
    assert.equal((await call("GET", "/api/sessions")).status, 405);
    const { host } = new URL(url);
    const preflight = await raw("OPTIONS", "/api/sessions", { host, origin: "http://evil.example", "access-control-request-method": "POST" });
    assert.equal(preflight.status, 403);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`FAIL ${name}\n${error.stack.split("\n").slice(0, 6).join("\n")}`);
    }
}
await running.close();
process.exit(failed ? 1 : 0);
