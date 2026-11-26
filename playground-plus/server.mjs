// Playground+'s backend: serves the playground (playground/, wasm/, examples/, images/) from the repository with
// Playground+'s own boot script in place of the playground's, and hosts the JSON API (api.mjs). It
// binds to the loopback interface only, and refuses requests whose Host is not a loopback name
// (which blocks DNS-rebinding from web pages).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentPlayer } from "./agent-player.mjs";
import { createOllama } from "./agent/ollama.mjs";
import { createApi } from "./api.mjs";
import { createGenerator } from "./generator.mjs";
import { createService } from "./service.mjs";
import { createPuzzleStream } from "./stream.mjs";
import { openDatabase } from "./db.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ABANDONED_AFTER = 30 * 60 * 1000; // ms without activity before a session counts as abandoned

const PG_ENTRY = '<script type="module" src="app.mjs"></script>';
const PLUS_ENTRY = '<script type="module" src="/playground-plus/client/boot.mjs"></script>';
// what the page may read: the playground's files, the page-side scripts, and the vocabulary they share with the server
const PUBLIC_DIRS = ["playground", "wasm", "examples", "images", join("playground-plus", "client"), join("playground-plus", "taxonomy.mjs")];
// the same exclusions as the Pages build of the playground
const HIDDEN = [/^playground[\\/]vendor-src([\\/]|$)/, /^(playground|wasm)[\\/]test_[^\\/]*\.mjs$/];
const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".bo": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
};

/**
 * Starts the server. `port` 0 picks a free port. Resolves to `{url, repository, stream, close}`.
 * @param {{root?: string, host?: string, port?: number, repository?: object, watchMs?: number, generator?: object|null}} [options]
 *   `repository` is an open database (see db.mjs); by default a volatile in-memory one, closed with the
 *   server. `watchMs` is how often the database is checked for new puzzles to tell open pages about.
 *   `generator` writes puzzles with a local model (generator.mjs) and `agentPlayer` lets one play the
 *   puzzles the player has played (agent-player.mjs); by default both are made, and they only work if
 *   Ollama is installed. They share one Ollama client (`ollama`).
 */
export async function startServer({
    root = ROOT, host = "127.0.0.1", port = 0, repository = null, watchMs = 1000, generator = undefined, generatorOptions = {},
    agentPlayer = undefined, agentPlayerOptions = {}, ollama = createOllama(),
} = {}) {
    const ownRepository = !repository;
    repository ??= openDatabase();
    repository.closeStaleSessions(ABANDONED_AFTER);
    const service = createService({ repository });
    generator = generator === undefined ? createGenerator({ repository, service, ollama, ...generatorOptions }) : generator;
    agentPlayer = agentPlayer === undefined && generator
        ? createAgentPlayer({ repository, service, ollama, capabilities: () => generator.capabilities(), ...agentPlayerOptions })
        : agentPlayer ?? null;
    const api = createApi(repository, { generator, service, agentPlayer });
    const stream = createPuzzleStream(repository, { intervalMs: watchMs });
    const indexPath = join(root, "playground", "index.html");
    if (!(await readFile(indexPath, "utf8")).includes(PG_ENTRY))
        throw new Error(`${indexPath} no longer contains ${PG_ENTRY}, which Playground+ replaces with its own boot script`);

    const send = (res, status, body, type = "text/plain; charset=utf-8", headers = {}) => {
        res.writeHead(status, { "content-type": type, "cache-control": "no-cache", ...headers });
        res.end(body);
    };

    const serveFile = async (res, urlPath) => {
        let path;
        try {
            path = decodeURIComponent(urlPath);
        } catch {
            return send(res, 400, "bad request");
        }
        const file = resolve(root, `.${path}`);
        const name = relative(root, file);
        const inPublic = PUBLIC_DIRS.some((dir) => name === dir || name.startsWith(dir + sep));
        if (path.includes("\0") || !inPublic || HIDDEN.some((hidden) => hidden.test(name))) return send(res, 404, "not found");
        try {
            send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
        } catch {
            send(res, 404, "not found");
        }
    };

    const server = createServer(async (req, res) => {
        try {
            const { port: actual } = server.address();
            if (![`127.0.0.1:${actual}`, `localhost:${actual}`, `[::1]:${actual}`].includes(req.headers.host ?? ""))
                return send(res, 403, "forbidden host");
            const { pathname } = new URL(req.url, "http://localhost");
            if (pathname === "/api/stream") {
                const origin = req.headers.origin;
                if (req.method !== "GET") return send(res, 405, "method not allowed");
                if (origin !== undefined && origin !== `http://${req.headers.host}`) return send(res, 403, "foreign origin");
                return stream.handle(req, res);
            }
            if (pathname.startsWith("/api/")) return await api(req, res, pathname, `http://${req.headers.host}`);
            if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
            if (pathname === "/") return send(res, 302, "", "text/plain", { location: "/playground/index.html" });
            if (pathname === "/playground/index.html")
                return send(res, 200, (await readFile(indexPath, "utf8")).replace(PG_ENTRY, PLUS_ENTRY), TYPES[".html"]);
            await serveFile(res, pathname);
        } catch (error) {
            console.error(error);
            send(res, 500, "internal error");
        }
    });
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolveListen);
    });
    const { port: actual } = server.address();
    return {
        url: `http://${host === "::1" ? "[::1]" : host}:${actual}/`,
        repository,
        stream,
        generator,
        agentPlayer,
        close: () => new Promise((resolveClose) => {
            generator?.cancel();
            agentPlayer?.cancel();
            stream.close();
            server.close(() => {
                if (ownRepository) repository.close();
                resolveClose();
            });
            server.closeAllConnections();
        }),
    };
}
