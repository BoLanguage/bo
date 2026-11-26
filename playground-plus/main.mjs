// Starts Playground+: node playground-plus/main.mjs [port] [--no-open]
//   port       default 8777, or $PLAYGROUND_PLUS_PORT
//   --no-open  do not open a browser (also: PLAYGROUND_PLUS_OPEN=0)
// The data is kept in $PLAYGROUND_PLUS_DB, by default playground-plus/data/playground-plus.sqlite.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { openBrowser } from "./open.mjs";
import { ROOT, startServer } from "./server.mjs";

/** The command line: the port, and whether to open the browser. Throws a message-only Error for anything else. */
export function parseArguments(argv, env = process.env) {
    let port = env.PLAYGROUND_PLUS_PORT === undefined ? 8777 : Number(env.PLAYGROUND_PLUS_PORT);
    let open = env.PLAYGROUND_PLUS_OPEN !== "0";
    for (const argument of argv) {
        if (argument === "--no-open") open = false;
        else if (/^\d+$/.test(argument)) port = Number(argument);
        else throw new Error(`unknown argument "${argument}" (usage: main.mjs [port] [--no-open])`);
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`"${port}" is not a port number`);
    return { port, open };
}

/** The text that tells an AI client how to reach this checkout's MCP server. */
export function mcpConfiguration(root = ROOT) {
    const config = { mcpServers: { "playground-plus": { command: "node", args: ["--disable-warning=ExperimentalWarning", join(root, "playground-plus", "mcp.mjs")] } } };
    return JSON.stringify(config, null, 2);
}

async function main() {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
    } catch (error) {
        console.error(`error: ${error.message}`);
        process.exit(1);
    }
    const databasePath = process.env.PLAYGROUND_PLUS_DB ?? join(ROOT, "playground-plus", "data", "playground-plus.sqlite");
    if (!existsSync(join(ROOT, "wasm", "build", "bo-core.wasm"))) {
        console.error("error: wasm/build has no WebAssembly build; run `make wasm` first (it needs Emscripten: `make emsdk`)");
        process.exit(1);
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    const repository = openDatabase(databasePath);
    let server;
    try {
        server = await startServer({ port: options.port, repository, generatorOptions: { transcriptDir: join(dirname(databasePath), "generator") }, agentPlayerOptions: { transcriptDir: join(dirname(databasePath), "agent-play") } });
    } catch (error) {
        repository.close();
        console.error(error.code === "EADDRINUSE"
            ? `error: port ${options.port} is in use. Is Playground+ already running? Try another port: make playground-plus PORT=9000`
            : `error: ${error.message}`);
        process.exit(1);
    }
    console.log(`Playground+ is running at ${server.url} (Ctrl+C to stop)`);
    console.log(`Data: ${databasePath}`);
    console.log("\nTo let an AI assistant write puzzles, add this MCP server to its configuration:");
    console.log(mcpConfiguration());
    console.log("(set PLAYGROUND_PLUS_DB in its \"env\" if you use another data file)\n");
    if (options.open && !(await openBrowser(server.url))) console.log(`Open ${server.url} in a browser.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
