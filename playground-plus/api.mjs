// Playground+'s JSON API (under /api/). Every request is validated: the body is size-limited,
// POSTs must be application/json (so a cross-origin web page cannot send them without a preflight,
// which this server never answers), and a request that carries an Origin must come from this
// server's own origin.
import { AgentPlayError } from "./agent-player.mjs";
import { OUTCOMES, ROLES } from "./db.mjs";
import { GeneratorError } from "./generator.mjs";
import { cleanPreferences } from "./taxonomy.mjs";

const MAX_BODY = 1024 * 1024;
const MAX_EVENTS = 500;
const TEXT_LIMIT = 100_000;
const JSON_LIMIT = 200_000;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
const bad = (message) => new HttpError(400, message);

const readBody = (req) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                // keep draining without storing, so the 413 reply reaches the client before the socket closes
                if (!tooLarge) reject(new HttpError(413, "request body too large"));
                tooLarge = true;
                chunks.length = 0;
            } else if (!tooLarge) chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });

const readJson = async (req) => {
    if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
    try {
        const value = JSON.parse(await readBody(req));
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw bad("the body must be a JSON object");
    }
};

const optionalText = (value, name, max) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > max) throw bad(`${name} must be text of at most ${max} characters`);
    return value;
};
const optionalJson = (value, name, kind) => {
    if (value === undefined || value === null) return null;
    const ok = kind === "array" ? Array.isArray(value) : typeof value === "object" && !Array.isArray(value);
    if (!ok || JSON.stringify(value).length > JSON_LIMIT) throw bad(`${name} must be a ${kind} of reasonable size`);
    return value;
};

/** Checks one event of a POSTed batch and returns the fields the repository stores. */
export function validateEvent(event) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) throw bad("each event must be an object");
    if (typeof event.type !== "string" || !/^[A-Za-z]{1,40}$/.test(event.type)) throw bad("event type must be a short word");
    if (!Number.isFinite(event.time) || event.time <= 0) throw bad("event time must be a positive number");
    if (event.duration !== undefined && !(Number.isFinite(event.duration) && event.duration >= 0)) throw bad("event duration must be a non-negative number");
    if (event.ok !== undefined && event.ok !== null && typeof event.ok !== "boolean") throw bad("event ok must be true or false");
    return {
        type: event.type,
        time: Math.round(event.time),
        duration: Math.round(event.duration ?? 0),
        code: optionalText(event.code, "event code", TEXT_LIMIT),
        ok: event.ok ?? null,
        error: optionalText(event.error, "event error", 2000),
        stackBefore: optionalJson(event.stackBefore, "stackBefore", "array"),
        stackAfter: optionalJson(event.stackAfter, "stackAfter", "array"),
        output: optionalJson(event.output, "output", "array"),
        puzzleState: optionalJson(event.puzzleState, "puzzleState", "object"),
    };
}

/**
 * @param {ReturnType<import("./db.mjs").openDatabase>} repository
 * @returns {(req, res, pathname: string, origin: string) => Promise<void>}
 */
export function createApi(repository, { now = () => Date.now(), generator = null, service = null, agentPlayer = null } = {}) {
    const reply = (res, status, body) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
    };
    const NO_GENERATOR = { available: false, reason: "This server has no puzzle generator.", models: [], model: null };
    const NO_PLAYER = { available: false, reason: "This server cannot run an agent.", models: [], model: null };
    const IDLE = { state: "idle", steps: [], stepCount: 0 };
    const needService = () => {
        if (!service) throw new HttpError(503, "this server has no statistics");
        return service;
    };
    /** Runs a generator or agent call, turning its refusals into HTTP errors. */
    const generate = async (call) => {
        try {
            return await call();
        } catch (error) {
            if (!(error instanceof GeneratorError) && !(error instanceof AgentPlayError)) throw error;
            throw new HttpError({ busy: 409, unavailable: 503, puzzle: 404, unplayed: 403 }[error.code] ?? 400, error.message);
        }
    };
    // one model at a time: two would fight over the graphics card
    const writing = () => generator?.status().state === "running";
    const playing = () => agentPlayer?.status().state === "running";

    const routes = [
        ["GET", /^\/api\/puzzles$/, () => [200, { puzzles: repository.listPuzzles() }]],
        // what the "New puzzle" dialog needs to know: whether a local model can write the puzzle, which
        // ones, whether the player has played (so "easier than last time" means something), and the running job
        ["GET", /^\/api\/generator$/, async () => [200, {
            ...(generator ? await generator.capabilities() : NO_GENERATOR),
            hasHistory: service ? service.getUserProfile().totals.sessions > 0 : false,
            job: generator ? generator.status() : { state: "idle" },
        }]],
        ["POST", /^\/api\/generate$/, async (req) => {
            const body = await readJson(req);
            if (!generator) throw new HttpError(503, NO_GENERATOR.reason);
            if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 100)) throw bad("model must be a model name");
            if (playing()) throw new HttpError(409, "An agent is playing a puzzle: wait for it to finish, or stop it.");
            return [202, { job: await generate(() => generator.start({ preferences: body.preferences ?? {}, model: body.model })) }];
        }],
        // "Watch an agent play": the models, the puzzles the player has played (the only ones an agent may play), the job
        ["GET", /^\/api\/agent-play$/, async () => [200, {
            ...(agentPlayer ? await agentPlayer.capabilities() : NO_PLAYER),
            limits: agentPlayer?.limits ?? null,
            puzzles: service ? service.listPlayedPuzzles() : [],
            job: agentPlayer ? agentPlayer.status() : IDLE,
        }]],
        ["POST", /^\/api\/agent-play$/, async (req) => {
            const body = await readJson(req);
            if (!agentPlayer) throw new HttpError(503, NO_PLAYER.reason);
            if (typeof body.puzzleId !== "string" || body.puzzleId.length > 100) throw bad("puzzleId must be a puzzle id");
            if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 100)) throw bad("model must be a model name");
            if (writing()) throw new HttpError(409, "A puzzle is being written: wait for it to finish, or stop it.");
            return [202, { job: await generate(() => agentPlayer.start({ puzzleId: body.puzzleId, model: body.model })) }];
        }],
        ["GET", /^\/api\/agent-play\/status$/, (req) => {
            const since = Number(new URL(req.url, "http://localhost").searchParams.get("since") ?? 0);
            return [200, { job: agentPlayer ? agentPlayer.status(Number.isInteger(since) && since >= 0 ? since : 0) : IDLE }];
        }],
        ["GET", /^\/api\/agent-play\/runs$/, () => [200, { runs: needService().listAgentRuns() }]],
        ["GET", /^\/api\/agent-play\/runs\/([0-9a-f-]{36})$/, (req, [id]) => {
            const found = needService().getAgentRun(id);
            if (!found) throw new HttpError(404, "no such run, or its puzzle has not been played by you");
            return [200, found];
        }],
        ["POST", /^\/api\/agent-play\/cancel$/, async (req) => {
            await readJson(req);
            return [200, { job: agentPlayer ? agentPlayer.cancel() : IDLE }];
        }],
        ["GET", /^\/api\/profile$/, () => [200, needService().getStatistics()]],
        ["GET", /^\/api\/profile\/export$/, () => [200, needService().exportMyData()]],
        ["POST", /^\/api\/profile\/erase$/, async (req) => {
            const body = await readJson(req);
            if (body.confirm !== true) throw bad("confirm must be true");
            return [200, needService().eraseMyHistory()];
        }],
        ["GET", /^\/api\/generate\/status$/, () => [200, { job: generator ? generator.status() : { state: "idle" } }]],
        ["POST", /^\/api\/generate\/cancel$/, async (req) => {
            await readJson(req);
            return [200, { job: generator ? generator.cancel() : { state: "idle" } }];
        }],
        ["GET", /^\/api\/requests\/pending$/, () => [200, { request: repository.pendingRequest(now()) }]],
        ["POST", /^\/api\/requests$/, async (req) => {
            const body = await readJson(req);
            let preferences;
            try {
                preferences = cleanPreferences(body.preferences ?? {});
            } catch (error) {
                throw bad(error.message);
            }
            return [201, { id: repository.createRequest({ preferences, now: now() }) }];
        }],
        ["POST", /^\/api\/requests\/([0-9a-f-]{36})\/cancel$/, async (req, [id]) => {
            await readJson(req);
            if (!repository.getRequest(id)) throw new HttpError(404, "unknown request");
            if (!repository.cancelRequest(id, now())) throw new HttpError(409, "the request is already closed");
            return [200, { cancelled: true }];
        }],
        ["POST", /^\/api\/sessions$/, async (req) => {
            const body = await readJson(req);
            if (typeof body.puzzleId !== "string") throw bad("puzzleId is required");
            if (!repository.getPuzzle(body.puzzleId)) throw new HttpError(404, "unknown puzzle");
            const role = body.role ?? "human";
            if (!ROLES.includes(role)) throw bad(`role must be one of ${ROLES.join(", ")}`);
            repository.closeStaleSessions(30 * 60 * 1000, now());
            const id = repository.createSession({
                puzzleId: body.puzzleId, role,
                client: optionalText(body.client, "client", 100),
                boVersion: optionalText(body.boVersion, "boVersion", 40),
                now: now(),
            });
            return [201, { id }];
        }],
        ["POST", /^\/api\/sessions\/([0-9a-f-]{36})\/events$/, async (req, [id]) => {
            const body = await readJson(req);
            if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_EVENTS)
                throw bad(`events must be a list of 1 to ${MAX_EVENTS} events`);
            const events = body.events.map(validateEvent);
            const session = repository.getSession(id);
            if (!session) throw new HttpError(404, "unknown session");
            if (session.ended_at !== null) throw new HttpError(409, "the session has ended");
            return [200, { stored: repository.addEvents(id, events) }];
        }],
        ["POST", /^\/api\/sessions\/([0-9a-f-]{36})\/end$/, async (req, [id]) => {
            const body = await readJson(req);
            if (!OUTCOMES.includes(body.outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(", ")}`);
            if (!repository.getSession(id)) throw new HttpError(404, "unknown session");
            if (!repository.endSession(id, body.outcome, now())) throw new HttpError(409, "the session has ended");
            return [200, { ended: true }];
        }],
    ];

    return async (req, res, pathname, origin) => {
        try {
            const requestOrigin = req.headers.origin;
            if (requestOrigin !== undefined && requestOrigin !== origin) throw new HttpError(403, "foreign origin");
            let known = false;
            for (const [method, pattern, handler] of routes) {
                const match = pattern.exec(pathname);
                if (!match) continue;
                known = true;
                if (method !== req.method) continue;
                const [status, body] = await handler(req, match.slice(1));
                return reply(res, status, body);
            }
            throw known ? new HttpError(405, "method not allowed") : new HttpError(404, "not found");
        } catch (error) {
            if (error instanceof HttpError) return reply(res, error.status, { error: error.message });
            console.error(error);
            reply(res, 500, { error: "internal error" });
        }
    };
}
