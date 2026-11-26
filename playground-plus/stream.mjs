// Tells open pages when a puzzle has been stored (by the MCP server, which is another process, or by
// anything else sharing the database file), using server-sent events at GET /api/stream. The
// database is checked on a timer: that works across processes with no extra machinery, and a check
// is a single indexed query.

const HEARTBEAT_EVERY = 20; // ticks between keep-alive comments

/**
 * @param {{lastPuzzleSeq: () => number, puzzlesAfter: (seq: number) => {seq: number, id: string, title: string}[]}} repository
 * @param {{intervalMs?: number}} [options] `intervalMs` 0 turns the watching off (streams then only get keep-alives)
 */
export function createPuzzleStream(repository, { intervalMs = 1000 } = {}) {
    const streams = new Set();
    let lastSeq = repository.lastPuzzleSeq();
    let ticks = 0;

    const send = (chunk) => {
        for (const res of streams) res.write(chunk);
    };
    const tick = () => {
        try {
            for (const puzzle of repository.puzzlesAfter(lastSeq)) {
                lastSeq = puzzle.seq;
                send(`event: puzzle\ndata: ${JSON.stringify({ id: puzzle.id, title: puzzle.title })}\n\n`);
            }
            if (++ticks % HEARTBEAT_EVERY === 0) send(": keep-alive\n\n");
        } catch (error) {
            console.error("puzzle stream:", error);
        }
    };
    const timer = intervalMs > 0 ? setInterval(tick, intervalMs) : null;
    timer?.unref();

    return {
        /** Serves one GET /api/stream request; the response stays open until the client leaves. */
        handle(req, res) {
            res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
            res.write("retry: 2000\n: connected\n\n");
            streams.add(res);
            res.on("close", () => streams.delete(res));
        },
        /** Checks the database now (what the timer does); for tests. */
        tick,
        get clients() {
            return streams.size;
        },
        close() {
            if (timer) clearInterval(timer);
            for (const res of streams) res.end();
            streams.clear();
        },
    };
}
