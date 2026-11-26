// Tests for starting Playground+ from the terminal: the command line, the MCP configuration it prints, how
// the browser is opened, and the real command (a port in use, a missing build, the output).
// Usage: node playground-plus/test_launch.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpConfiguration, parseArguments } from "./main.mjs";
import { openerCommand } from "./open.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the command line: a port and --no-open, with the environment as defaults", () => {
    assert.deepEqual(parseArguments([], {}), { port: 8777, open: true });
    assert.deepEqual(parseArguments(["9000"], {}), { port: 9000, open: true });
    assert.deepEqual(parseArguments(["--no-open", "9000"], {}), { port: 9000, open: false });
    assert.deepEqual(parseArguments([], { PLAYGROUND_PLUS_PORT: "9100", PLAYGROUND_PLUS_OPEN: "0" }), { port: 9100, open: false });
    assert.deepEqual(parseArguments([], { PLAYGROUND_PLUS_OPEN: "1" }), { port: 8777, open: true });
    assert.deepEqual(parseArguments(["9200"], { PLAYGROUND_PLUS_PORT: "9100" }), { port: 9200, open: true }, "the argument wins");
    assert.throws(() => parseArguments(["--open-please"], {}), /unknown argument "--open-please"/);
    assert.throws(() => parseArguments(["70000"], {}), /not a port number/);
    assert.throws(() => parseArguments([], { PLAYGROUND_PLUS_PORT: "abc" }), /not a port number/);
});

test("the MCP configuration names this checkout's server and is valid JSON", () => {
    const config = JSON.parse(mcpConfiguration("/some/where/bo-lang"));
    const server = config.mcpServers["playground-plus"];
    assert.equal(server.command, "node");
    assert.deepEqual(server.args, ["--disable-warning=ExperimentalWarning", "/some/where/bo-lang/playground-plus/mcp.mjs"]);
});

test("the browser is opened with the platform's command, and not where there is no display", () => {
    const url = "http://127.0.0.1:8777/";
    assert.deepEqual(openerCommand(url, { platform: "darwin", env: {} }), ["open", [url]]);
    assert.deepEqual(openerCommand(url, { platform: "win32", env: {} }), ["cmd", ["/c", "start", "", url]]);
    assert.deepEqual(openerCommand(url, { platform: "linux", env: { DISPLAY: ":0" } }), ["xdg-open", [url]]);
    assert.deepEqual(openerCommand(url, { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }), ["xdg-open", [url]]);
    assert.equal(openerCommand(url, { platform: "linux", env: {} }), null, "a server without a display");
    assert.deepEqual(openerCommand(url, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }), ["cmd.exe", ["/c", "start", "", url]], "WSL without a Linux display opens the Windows browser");
});

/** Runs main.mjs and collects what it prints until `done(output)` is true, the process ends or time runs out. */
function run(args, env, done = () => false) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(here, "main.mjs"), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        const finish = (code) => {
            clearTimeout(timer);
            child.kill();
            resolve({ output, code });
        };
        const timer = setTimeout(() => finish("timeout"), 15_000);
        for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
            output += chunk;
            if (done(output)) finish("done");
        });
        child.on("exit", (code) => finish(code));
    });
}

test("started with --no-open it says where it runs and how to connect an assistant", async () => {
    const result = await run(["0", "--no-open"], { PLAYGROUND_PLUS_DB: ":memory:" }, (text) => text.includes("(set PLAYGROUND_PLUS_DB"));
    if (/wasm\/build has no WebAssembly build/.test(result.output)) return; // the build is optional where this runs
    assert.match(result.output, /Playground\+ is running at http:\/\/127\.0\.0\.1:\d+\/ \(Ctrl\+C to stop\)/);
    assert.match(result.output, /"mcpServers"[\s\S]*"playground-plus"[\s\S]*playground-plus\/mcp\.mjs/);
    assert.doesNotMatch(result.output, /Open http/, "nothing asks for a browser when --no-open is given");
});

test("a port that is in use is explained, and a bad argument is refused", async () => {
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = blocker.address().port;
    try {
        const busy = await run([String(port), "--no-open"], { PLAYGROUND_PLUS_DB: ":memory:" });
        if (!/wasm\/build has no WebAssembly build/.test(busy.output)) {
            assert.equal(busy.code, 1);
            assert.match(busy.output, new RegExp(`error: port ${port} is in use\\. Is Playground\\+ already running\\? Try another port: make playground-plus PORT=9000`));
        }
    } finally {
        blocker.close();
    }
    const bad = await run(["--frobnicate"], {});
    assert.equal(bad.code, 1);
    assert.match(bad.output, /error: unknown argument "--frobnicate"/);
});

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
