// Tests for Playground+'s database. Usage: node playground-plus/test_db.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const puzzle = (id = "p1") => ({ id, title: "T", goal: "G", source: "1 2 +", hints: 2, package: { tags: ["shuffle"] }, now: 1000 });
const event = (type, time, extra = {}) => ({ type, time, duration: 5, ...extra });

test("a puzzle is stored once, with its package kept verbatim", () => {
    const db = openDatabase();
    db.addPuzzle(puzzle());
    db.addPuzzle({ ...puzzle(), title: "changed" });
    assert.equal(db.listPuzzles().length, 1);
    assert.equal(db.getPuzzle("p1").title, "T");
    assert.deepEqual(db.getPuzzle("p1").package, { tags: ["shuffle"] });
    assert.equal(db.getPuzzle("nope"), undefined);
});

test("sessions need an existing puzzle, a known role, and end only once", () => {
    const db = openDatabase();
    assert.throws(() => db.createSession({ puzzleId: "missing" }));
    db.addPuzzle(puzzle());
    assert.throws(() => db.createSession({ puzzleId: "p1", role: "alien" }));
    const id = db.createSession({ puzzleId: "p1", client: "page", boVersion: "0.7.0", now: 2000 });
    assert.deepEqual(
        [db.getSession(id).role, db.getSession(id).client, db.getSession(id).started_at, db.getSession(id).outcome],
        ["human", "page", 2000, null]);
    assert.equal(db.endSession(id, "solved", 3000), true);
    assert.equal(db.endSession(id, "skipped", 4000), false, "the first outcome stands");
    assert.deepEqual([db.getSession(id).ended_at, db.getSession(id).outcome], [3000, "solved"]);
    assert.throws(() => db.endSession(db.createSession({ puzzleId: "p1" }), "won"));
    assert.equal(db.getSession("nope"), null);
});

test("events are numbered in arrival order across batches and round-trip their structure", () => {
    const db = openDatabase();
    db.addPuzzle(puzzle());
    const id = db.createSession({ puzzleId: "p1" });
    db.addEvents(id, [event("setup", 10), event("evaluate", 20, {
        code: "1 2 +", ok: true, stackBefore: [{ name: "", depth: 0 }], stackAfter: [{ name: "", depth: 1 }],
        output: [{ stream: "stdout", text: "x" }], puzzleState: { guesses: 0 },
    })]);
    db.addEvents(id, [event("evaluate", 30, { code: "bad", ok: false, error: "boom" })]);
    const events = db.listEvents(id);
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[1, "setup"], [2, "evaluate"], [3, "evaluate"]]);
    assert.equal(events[0].ok, null);
    assert.equal(events[1].ok, true);
    assert.equal(events[2].ok, false);
    assert.deepEqual(events[1].stack_after, [{ name: "", depth: 1 }]);
    assert.deepEqual(events[1].output, [{ stream: "stdout", text: "x" }]);
    assert.deepEqual(events[1].puzzle_state, { guesses: 0 });
    assert.equal(events[2].error, "boom");
});

test("a bad event rolls back its whole batch, and events need a session", () => {
    const db = openDatabase();
    db.addPuzzle(puzzle());
    const id = db.createSession({ puzzleId: "p1" });
    assert.throws(() => db.addEvents(id, [event("setup", 1), { time: 2 }]));
    assert.equal(db.listEvents(id).length, 0);
    assert.throws(() => db.addEvents("missing", [event("setup", 1)]));
});

test("sessions idle for long enough are closed as abandoned, dated at their last activity", () => {
    const db = openDatabase();
    db.addPuzzle(puzzle());
    const quiet = db.createSession({ puzzleId: "p1", now: 1000 });
    db.addEvents(quiet, [event("setup", 1000), event("evaluate", 2000)]);
    const fresh = db.createSession({ puzzleId: "p1", now: 9000 });
    const never = db.createSession({ puzzleId: "p1", now: 100 });
    const solved = db.createSession({ puzzleId: "p1", now: 100 });
    db.endSession(solved, "solved", 150);
    assert.equal(db.closeStaleSessions(5000, 10000), 2);
    assert.deepEqual([db.getSession(quiet).outcome, db.getSession(quiet).ended_at], ["abandoned", 2005]);
    assert.deepEqual([db.getSession(never).outcome, db.getSession(never).ended_at], ["abandoned", 100]);
    assert.equal(db.getSession(fresh).outcome, null);
    assert.equal(db.getSession(solved).outcome, "solved");
});

test("a request for a puzzle waits, is replaced by a newer one, expires, and closes once", () => {
    const db = openDatabase();
    assert.equal(db.pendingRequest(1000), null);
    const first = db.createRequest({ preferences: { tags: ["list"] }, now: 1000 });
    assert.deepEqual(db.pendingRequest(2000), { id: first, createdAt: 1000, preferences: { tags: ["list"] } });
    const second = db.createRequest({ preferences: { change: "harder" }, now: 3000 });
    assert.equal(db.pendingRequest(4000).id, second, "only the newest request waits");
    assert.equal(db.getRequest(first).status, "cancelled");
    assert.equal(db.pendingRequest(3000 + 30 * 60 * 1000 + 1), null, "an old request is not waiting any more");
    assert.equal(db.pendingRequest(3000 + 30 * 60 * 1000 + 1, 60 * 60 * 1000).id, second, "unless it is allowed to wait longer");

    db.addPuzzle(puzzle());
    assert.equal(db.fulfilRequest(second, "p1", 5000), true);
    assert.deepEqual([db.getRequest(second).status, db.getRequest(second).puzzleId, db.getRequest(second).closedAt], ["fulfilled", "p1", 5000]);
    assert.equal(db.fulfilRequest(second, "p1", 6000), false, "it closes once");
    assert.equal(db.cancelRequest(second), false);
    assert.equal(db.pendingRequest(5000), null);
    const third = db.createRequest({ now: 7000 });
    assert.equal(db.cancelRequest(third, 7500), true);
    assert.equal(db.getRequest(third).status, "cancelled");
    assert.equal(db.getRequest("missing"), null);
    assert.deepEqual(db.getRequest(third).preferences, {}, "no preferences means anything goes");
});

test("an event can carry meta (what its writer knows beyond what happened), and an older database gains the column", () => {
    const db = openDatabase();
    db.addPuzzle(puzzle());
    const session = db.createSession({ puzzleId: "p1", role: "agent", client: "m", now: 1 });
    db.addEvents(session, [event("evaluate", 10, { code: "1", meta: { turnMs: 1200, outputTokens: 40 } }), event("evaluate", 20, { code: "2" })]);
    assert.deepEqual(db.listEvents(session).map((e) => e.meta), [{ turnMs: 1200, outputTokens: 40 }, null]);

    const dir = mkdtempSync(join(tmpdir(), "plus-db-"));
    try {
        const path = join(dir, "old.sqlite");
        const first = openDatabase(path);
        first.addPuzzle(puzzle());
        const old = first.createSession({ puzzleId: "p1", now: 1 });
        first.addEvents(old, [event("evaluate", 10, { code: "kept" })]);
        first.close();
        const raw = new DatabaseSync(path);
        raw.exec("ALTER TABLE events DROP COLUMN meta; PRAGMA user_version = 2");
        raw.close();
        const upgraded = openDatabase(path);
        assert.deepEqual(upgraded.listEvents(old).map((e) => [e.code, e.meta]), [["kept", null]], "what was stored is kept");
        upgraded.addEvents(old, [event("evaluate", 20, { code: "new", meta: { turnMs: 5 } })]);
        assert.deepEqual(upgraded.listEvents(old).at(-1).meta, { turnMs: 5 });
        upgraded.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a file database persists, and one from a newer version is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "plus-db-"));
    try {
        const path = join(dir, "x.sqlite");
        const first = openDatabase(path);
        first.addPuzzle(puzzle());
        first.close();
        const second = openDatabase(path);
        assert.equal(second.listPuzzles().length, 1);
        second.close();
        const raw = new DatabaseSync(path);
        raw.exec("PRAGMA user_version = 99");
        raw.close();
        assert.throws(() => openDatabase(path), /newer version/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
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
process.exit(failed ? 1 : 0);
