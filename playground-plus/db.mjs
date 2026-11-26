// Playground+'s storage: one SQLite file behind a small repository. Nothing outside this module
// knows about SQL, so the storage can be replaced. Times are milliseconds since the epoch.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const ROLES = ["human", "agent"];
export const OUTCOMES = ["solved", "revealed", "skipped", "abandoned"];

// Each entry upgrades the database by one version (PRAGMA user_version).
const MIGRATIONS = [
    `CREATE TABLE puzzles (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        hints INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        package TEXT NOT NULL
    ) STRICT;
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        puzzle_id TEXT NOT NULL REFERENCES puzzles(id),
        role TEXT NOT NULL CHECK (role IN ('human', 'agent')),
        client TEXT,
        bo_version TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT CHECK (outcome IN ('solved', 'revealed', 'skipped', 'abandoned'))
    ) STRICT;
    CREATE INDEX sessions_by_puzzle ON sessions(puzzle_id);
    CREATE TABLE events (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        time INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        type TEXT NOT NULL,
        code TEXT,
        ok INTEGER,
        error TEXT,
        stack_before TEXT,
        stack_after TEXT,
        output TEXT,
        puzzle_state TEXT,
        PRIMARY KEY (session_id, seq)
    ) STRICT, WITHOUT ROWID;`,
    // a player's request for a new puzzle, waiting for an agent to answer it
    `CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        preferences TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
        puzzle_id TEXT REFERENCES puzzles(id),
        closed_at INTEGER
    ) STRICT;`,
    // what the writer of an event knows about it beyond what happened: for an agent, how long its model took to
    // decide (and the tokens), as JSON; events from a page have none
    `ALTER TABLE events ADD COLUMN meta TEXT;`,
];

const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const parse = (text) => (text === null ? null : JSON.parse(text));

/** Opens (and, if needed, creates or upgrades) the database at `path`; ":memory:" is volatile. */
export function openDatabase(path = ":memory:") {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL");
    let version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > MIGRATIONS.length) throw new Error(`${path} was made by a newer version (schema ${version})`);
    for (; version < MIGRATIONS.length; version++) {
        db.exec("BEGIN");
        try {
            db.exec(MIGRATIONS[version]);
            db.exec(`PRAGMA user_version = ${version + 1}`);
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }

    const statements = {
        addPuzzle: db.prepare(
            "INSERT OR IGNORE INTO puzzles (id, created_at, title, goal, description, hints, source, package) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
        // `played`: the player has a session on it, so it is a "past" puzzle and its play is no longer recorded
        listPuzzles: db.prepare(
            `SELECT id, title, goal, description, hints, source,
                    EXISTS (SELECT 1 FROM sessions s WHERE s.puzzle_id = puzzles.id AND s.role = 'human') AS played
             FROM puzzles ORDER BY created_at, id`),
        listPuzzleRows: db.prepare("SELECT rowid AS seq, id, created_at, title, goal, package FROM puzzles ORDER BY rowid"),
        puzzlesAfter: db.prepare("SELECT rowid AS seq, id, title, goal, description, hints, source FROM puzzles WHERE rowid > ? ORDER BY rowid"),
        lastPuzzleSeq: db.prepare("SELECT COALESCE(MAX(rowid), 0) AS seq FROM puzzles"),
        sessionSummaries: db.prepare(
            `SELECT s.id, s.puzzle_id, s.role, s.client, s.started_at, s.ended_at, s.outcome, p.title, p.package,
                    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'evaluate') AS prompts,
                    (SELECT puzzle_state FROM events e WHERE e.session_id = s.id AND e.puzzle_state IS NOT NULL ORDER BY seq DESC LIMIT 1) AS state,
                    (SELECT MAX(time + duration) FROM events e WHERE e.session_id = s.id) AS last_active
             FROM sessions s JOIN puzzles p ON p.id = s.puzzle_id
             ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?`),
        getPuzzle: db.prepare("SELECT id, title, goal, description, hints, source, package FROM puzzles WHERE id = ?"),
        createSession: db.prepare(
            "INSERT INTO sessions (id, puzzle_id, role, client, bo_version, started_at) VALUES (?, ?, ?, ?, ?, ?)"),
        getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
        listSessions: db.prepare("SELECT * FROM sessions WHERE puzzle_id = ? ORDER BY started_at, rowid"),
        endSession: db.prepare("UPDATE sessions SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL"),
        lastSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?"),
        addEvent: db.prepare(
            `INSERT INTO events (session_id, seq, time, duration, type, code, ok, error, stack_before, stack_after, output, puzzle_state, meta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        listEvents: db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq"),
        promptLines: db.prepare("SELECT session_id, code FROM events WHERE type = 'evaluate' AND code IS NOT NULL ORDER BY session_id, seq"),
        humanEvents: db.prepare(
            `SELECT e.session_id, e.seq, e.time, e.code, e.ok FROM events e JOIN sessions s ON s.id = e.session_id
             WHERE s.role = 'human' AND e.type = 'evaluate' ORDER BY s.started_at, e.session_id, e.seq`),
        humanSessions: db.prepare(
            `SELECT s.id, s.started_at, s.ended_at, s.outcome, p.title, p.package FROM sessions s JOIN puzzles p ON p.id = s.puzzle_id
             WHERE s.role = 'human' ORDER BY s.started_at, s.rowid`),
        eraseHumanEvents: db.prepare("DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE role = 'human')"),
        eraseHumanSessions: db.prepare("DELETE FROM sessions WHERE role = 'human'"),
        countHuman: db.prepare(
            `SELECT (SELECT COUNT(*) FROM sessions WHERE role = 'human') AS sessions,
                    (SELECT COUNT(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.role = 'human' AND e.type = 'evaluate') AS prompts,
                    (SELECT MIN(started_at) FROM sessions WHERE role = 'human') AS since`),
        openSessions: db.prepare(
            `SELECT s.id, s.started_at, COALESCE(MAX(e.time + e.duration), s.started_at) AS last_active
             FROM sessions s LEFT JOIN events e ON e.session_id = s.id
             WHERE s.ended_at IS NULL GROUP BY s.id`),
        cancelPending: db.prepare("UPDATE requests SET status = 'cancelled', closed_at = ? WHERE status = 'pending'"),
        addRequest: db.prepare("INSERT INTO requests (id, created_at, preferences, status) VALUES (?, ?, ?, 'pending')"),
        pendingRequest: db.prepare("SELECT id, created_at, preferences FROM requests WHERE status = 'pending' AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
        getRequest: db.prepare("SELECT id, created_at, preferences, status, puzzle_id, closed_at FROM requests WHERE id = ?"),
        closeRequest: db.prepare("UPDATE requests SET status = ?, puzzle_id = ?, closed_at = ? WHERE id = ? AND status = 'pending'"),
    };
    const transaction = (fn) => {
        db.exec("BEGIN");
        try {
            const result = fn();
            db.exec("COMMIT");
            return result;
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    };

    return {
        /** Stores a puzzle (ignored if its id is already there). `puzzle.package` is kept verbatim. */
        addPuzzle({ id, title, goal, description = "", hints = 0, source, package: pack = {}, now = Date.now() }) {
            statements.addPuzzle.run(id, now, title, goal, description, hints, source, JSON.stringify(pack));
            return id;
        },
        listPuzzles: () => statements.listPuzzles.all().map((row) => ({ ...row, played: Boolean(row.played) })),
        /** Puzzles with what is known about them, without their source or answers, oldest first. */
        listPuzzleSummaries: () => statements.listPuzzleRows.all().map((row) => {
            const pack = JSON.parse(row.package);
            return {
                id: row.id, title: row.title, goal: row.goal, createdAt: row.created_at,
                tags: pack.tags ?? [], difficulty: pack.difficulty ?? null, bestKnownLength: pack.bestKnownLength ?? null,
                brief: pack.brief ?? null,
            };
        }),
        /** Puzzles stored after position `seq` (see `lastPuzzleSeq`), in the order they were stored. */
        puzzlesAfter: (seq) => statements.puzzlesAfter.all(seq),
        /** The position of the newest puzzle (0 if there are none): a marker for `puzzlesAfter`. */
        lastPuzzleSeq: () => statements.lastPuzzleSeq.get().seq,
        /**
         * The newest sessions with the puzzle they were on and how they went: prompts typed, guesses,
         * hints, whether the solution was revealed, and the time spent (to the end, or to the last event).
         */
        sessionSummaries: (limit = 50) => statements.sessionSummaries.all(limit).map((row) => {
            const pack = JSON.parse(row.package);
            const state = row.state ? JSON.parse(row.state) : {};
            const end = row.ended_at ?? row.last_active ?? row.started_at;
            return {
                id: row.id, puzzleId: row.puzzle_id, title: row.title, tags: pack.tags ?? [], difficulty: pack.difficulty ?? null,
                bestKnownLength: pack.bestKnownLength ?? null,
                role: row.role, client: row.client, outcome: row.outcome, startedAt: row.started_at, endedAt: row.ended_at,
                durationMs: Math.max(0, end - row.started_at), prompts: row.prompts,
                guesses: state.guesses ?? 0, hints: state.hints ?? 0, revealed: Boolean(state.revealed),
            };
        }),
        getPuzzle(id) {
            const row = statements.getPuzzle.get(id);
            return row && { ...row, package: JSON.parse(row.package) };
        },

        /** Starts a session on a stored puzzle and returns its id. */
        createSession({ puzzleId, role = "human", client = null, boVersion = null, now = Date.now() }) {
            const id = randomUUID();
            statements.createSession.run(id, puzzleId, role, client, boVersion, now);
            return id;
        },
        getSession: (id) => statements.getSession.get(id) ?? null,
        /** The sessions on a puzzle, oldest first. */
        listSessions: (puzzleId) => statements.listSessions.all(puzzleId),
        /** Ends an open session; false if it does not exist or has already ended. */
        endSession(id, outcome, now = Date.now()) {
            return statements.endSession.run(now, outcome, id).changes > 0;
        },

        /** Appends events to a session, numbering them after its last one. Returns how many were stored. */
        addEvents(sessionId, events) {
            return transaction(() => {
                let seq = statements.lastSeq.get(sessionId).seq;
                for (const event of events) {
                    statements.addEvent.run(
                        sessionId, ++seq, event.time, event.duration ?? 0, event.type, event.code ?? null,
                        event.ok === undefined || event.ok === null ? null : event.ok ? 1 : 0, event.error ?? null,
                        json(event.stackBefore), json(event.stackAfter), json(event.output), json(event.puzzleState), json(event.meta));
                }
                return events.length;
            });
        },
        listEvents: (sessionId) => statements.listEvents.all(sessionId).map((row) => ({
            ...row,
            ok: row.ok === null ? null : row.ok === 1,
            stack_before: parse(row.stack_before),
            stack_after: parse(row.stack_after),
            output: parse(row.output),
            puzzle_state: parse(row.puzzle_state),
            meta: parse(row.meta),
        })),

        /**
         * Marks sessions that have had no activity for `idleMs` as abandoned, dated at their last
         * activity. Abandonment cannot be recorded when it happens (a closed tab sends nothing), so
         * it is inferred later. Returns how many sessions were closed.
         */
        closeStaleSessions(idleMs, now = Date.now()) {
            let closed = 0;
            for (const { id, last_active: lastActive } of statements.openSessions.all()) {
                if (now - lastActive >= idleMs && statements.endSession.run(lastActive, "abandoned", id).changes > 0) closed++;
            }
            return closed;
        },

        /**
         * Records that the player wants a new puzzle, with what they asked for. Only one request waits at a
         * time: a new one replaces the one before.
         */
        createRequest({ preferences = {}, now = Date.now() } = {}) {
            const id = randomUUID();
            transaction(() => {
                statements.cancelPending.run(now);
                statements.addRequest.run(id, now, JSON.stringify(preferences));
            });
            return id;
        },
        /** The request still waiting for a puzzle, if it is no older than `maxAgeMs`: `{id, createdAt, preferences}` or null. */
        pendingRequest(now = Date.now(), maxAgeMs = 30 * 60 * 1000) {
            const row = statements.pendingRequest.get(now - maxAgeMs);
            return row ? { id: row.id, createdAt: row.created_at, preferences: JSON.parse(row.preferences) } : null;
        },
        getRequest(id) {
            const row = statements.getRequest.get(id);
            return row ? { id: row.id, createdAt: row.created_at, preferences: JSON.parse(row.preferences), status: row.status, puzzleId: row.puzzle_id, closedAt: row.closed_at } : null;
        },
        /** Gives up waiting. Returns whether the request was still pending. */
        cancelRequest: (id, now = Date.now()) => statements.closeRequest.run("cancelled", null, now, id).changes > 0,
        /** Marks a pending request as answered by `puzzleId`. Returns whether it was still pending. */
        fulfilRequest: (id, puzzleId, now = Date.now()) => statements.closeRequest.run("fulfilled", puzzleId, now, id).changes > 0,
        /** Every prompt line recorded, as `{sessionId, code}`, in order (for counting the words a player typed). */
        listPromptLines: () => statements.promptLines.all().map((row) => ({ sessionId: row.session_id, code: row.code })),
        /** What the human player's history holds, for showing and exporting it: sessions, each with its prompt lines. */
        exportHumanHistory() {
            const lines = new Map();
            for (const row of statements.humanEvents.all()) lines.set(row.session_id, [...(lines.get(row.session_id) ?? []), { time: row.time, code: row.code, ok: row.ok === null ? null : Boolean(row.ok) }]);
            return statements.humanSessions.all().map((row) => ({
                puzzle: row.title, startedAt: row.started_at, endedAt: row.ended_at, outcome: row.outcome, promptLines: lines.get(row.id) ?? [],
            }));
        },
        /** How much of the human player's history there is: `{sessions, promptLines, since}`. */
        humanHistoryCounts() {
            const row = statements.countHuman.get();
            return { sessions: row.sessions, promptLines: row.prompts, since: row.since };
        },
        /** Deletes the human player's sessions and what they typed (agents' sessions stay). Returns how many sessions and prompt lines went. */
        eraseHumanHistory() {
            const counts = this.humanHistoryCounts();
            transaction(() => {
                statements.eraseHumanEvents.run();
                statements.eraseHumanSessions.run();
            });
            return { sessions: counts.sessions, promptLines: counts.promptLines };
        },
        close: () => db.close(),
    };
}
