// A small client of Playground+'s API. `base` is the server's origin; in the page it defaults to
// the page's own origin. `EventSource` is injectable for tests (Node has none by default).
export function createApi(base = globalThis.location?.origin, { EventSource = globalThis.EventSource } = {}) {
    const call = async (method, path, body) => {
        const res = await fetch(new URL(path, base), {
            method,
            headers: body === undefined ? {} : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const error = new Error(`${method} ${path}: ${res.status} ${data.error ?? ""}`.trim());
            error.detail = data.error; // what the server said, without the request: for the player
            throw error;
        }
        return data;
    };
    return {
        listPuzzles: async () => (await call("GET", "/api/puzzles")).puzzles,
        /** The player asks for a puzzle (`preferences`: {tags?, change?}); returns the request's id. */
        createRequest: async (preferences = {}) => (await call("POST", "/api/requests", { preferences })).id,
        /** The request still waiting for a puzzle, as {id, preferences}, or null. */
        pendingRequest: async () => (await call("GET", "/api/requests/pending")).request,
        cancelRequest: (id) => call("POST", `/api/requests/${id}/cancel`, {}),
        /** What the "New puzzle" dialog needs: {available, reason, models, model, hasHistory, job}. */
        generatorState: () => call("GET", "/api/generator"),
        /** Starts writing a puzzle with a local model; returns the job. */
        generate: async ({ preferences = {}, model } = {}) => (await call("POST", "/api/generate", { preferences, ...(model ? { model } : {}) })).job,
        generatorStatus: async () => (await call("GET", "/api/generate/status")).job,
        cancelGeneration: async () => (await call("POST", "/api/generate/cancel", {})).job,
        /** What "Watch an agent play" needs: {available, reason, models, model, limits, puzzles (the played ones), job}. */
        agentPlayState: () => call("GET", "/api/agent-play"),
        /** Starts a model on a puzzle the player has played; returns the job. */
        startAgentPlay: async ({ puzzleId, model }) => (await call("POST", "/api/agent-play", { puzzleId, ...(model ? { model } : {}) })).job,
        /** The agent's job, with its steps from number `since` on. */
        agentPlayStatus: async (since = 0) => (await call("GET", `/api/agent-play/status?since=${since}`)).job,
        cancelAgentPlay: async () => (await call("POST", "/api/agent-play/cancel", {})).job,
        /** The recorded agent runs that can be replayed: `[{id, puzzleId, title, model, outcome, seconds, ...}]`. */
        agentRuns: async () => (await call("GET", "/api/agent-play/runs")).runs,
        /** One of them with its steps: `{run, steps: [{kind, code, error}]}`. */
        agentRun: (id) => call("GET", `/api/agent-play/runs/${id}`),
        /** The player's statistics, the agents', and what is stored: {you, agents, data}. */
        profile: () => call("GET", "/api/profile"),
        /** Everything the player's history holds, readable. */
        exportProfile: () => call("GET", "/api/profile/export"),
        /** Deletes the player's history; returns how many sessions and prompt lines went. */
        eraseProfile: () => call("POST", "/api/profile/erase", { confirm: true }),
        createSession: (session) => call("POST", "/api/sessions", session),
        addEvents: (id, events) => call("POST", `/api/sessions/${id}/events`, { events }),
        endSession: (id, outcome) => call("POST", `/api/sessions/${id}/end`, { outcome }),
        /**
         * Calls `callback` whenever the server says a puzzle was stored (the browser reconnects by itself
         * if the connection drops). Returns a function that stops listening; does nothing without EventSource.
         */
        onNewPuzzle(callback) {
            if (!EventSource) return () => {};
            const source = new EventSource(new URL("/api/stream", base));
            source.addEventListener("puzzle", () => callback());
            return () => source.close();
        },
    };
}
