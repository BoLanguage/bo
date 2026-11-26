// Tests for Playground+'s server. Usage: node playground-plus/test_server.mjs
import assert from "node:assert/strict";
import { request } from "node:http";
import { ROOT, startServer } from "./server.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A raw request, so the path and the Host header are sent exactly as given. */
const raw = (url, path, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
        const { hostname, port } = new URL(url);
        const req = request({ hostname, port, path, method, headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        req.end();
    });

const running = await startServer({ root: ROOT });
const { url } = running;

test("the root redirects to the playground page", async () => {
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/playground/index.html");
});

test("the playground page boots through Playground+'s script instead of the playground's", async () => {
    const res = await fetch(`${url}playground/index.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    const html = await res.text();
    assert.match(html, /<script type="module" src="\/playground-plus\/client\/boot\.mjs"><\/script>/);
    assert.doesNotMatch(html, /src="app\.mjs"/);
});

test("the playground's files, the examples and Playground+'s client are served with their types", async () => {
    for (const [path, type] of [
        ["playground/app.mjs", /javascript/],
        ["playground/style.css", /css/],
        ["wasm/bo.mjs", /javascript/],
        ["examples/puzzles/lib.bo", /text\/plain/],
        ["playground-plus/client/boot.mjs", /javascript/],
        ["playground-plus/taxonomy.mjs", /javascript/],
    ]) {
        const res = await fetch(url + path);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get("content-type"), type, path);
    }
});

test("the WebAssembly build is served as application/wasm when it exists", async () => {
    const res = await fetch(`${url}wasm/build/bo-core.wasm`);
    if (res.status === 404) return; // the build is optional here
    assert.equal(res.headers.get("content-type"), "application/wasm");
});

test("only the playground's public files are served", async () => {
    for (const path of [
        "/playground-plus/server.mjs",
        "/playground-plus/compile.mjs",
        "/playground-plus/db.mjs",
        "/playground-plus/package.json",
        "/playground/test_store.mjs",
        "/wasm/test_examples.mjs",
        "/playground/vendor-src/package.json",
        "/TODO.txt",
        "/.git/config",
        "/playground/../TODO.txt",
        "/playground/%2e%2e/TODO.txt",
        "/playground/..%2fTODO.txt",
        "/playground/index.html%00.png",
        "/playground/does-not-exist.mjs",
    ]) {
        const res = await raw(url, path);
        assert.ok(res.status === 404 || res.status === 400, `${path} gave ${res.status}`);
    }
});

test("requests for another Host are refused, and only GET is allowed", async () => {
    assert.equal((await raw(url, "/playground/app.mjs", { host: "evil.example" })).status, 403);
    assert.equal((await raw(url, "/playground/app.mjs", { host: `localhost:${new URL(url).port}` })).status, 200);
    assert.equal((await raw(url, "/playground/app.mjs", {}, "POST")).status, 405);
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
