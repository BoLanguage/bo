// Tests for the page helpers without a DOM: prompt history and sharing links.
// Usage: node playground/test_helpers.mjs
import assert from "node:assert/strict";
import { createHistory } from "./history.mjs";
import { decodeShare, encodeShare, readShare, shareLink } from "./share.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("history walks back and forward and returns to the draft", () => {
    const history = createHistory();
    history.add("1 2 +");
    history.add("dup *");
    assert.equal(history.previous("par"), "dup *");
    assert.equal(history.previous("ignored"), "1 2 +");
    assert.equal(history.previous("ignored"), null, "nothing older");
    assert.equal(history.next(), "dup *");
    assert.equal(history.next(), "par", "the text typed before comes back");
    assert.equal(history.next(), null);
});

test("history ignores blanks and immediate repeats, and is limited", () => {
    const history = createHistory(null, { limit: 3 });
    for (const text of ["a", "a", "  ", "", "b", "c", "d"]) history.add(text);
    assert.deepEqual(history.entries(), ["b", "c", "d"]);
});

test("history is kept in storage and survives a new page load", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    createHistory(storage).add("1 2 +");
    assert.deepEqual(createHistory(storage).entries(), ["1 2 +"]);
    store.set("bo-prompt-history", "{not json");
    assert.deepEqual(createHistory(storage).entries(), [], "unreadable history is forgotten");
    store.set("bo-prompt-history", JSON.stringify(["ok", 5, null]));
    assert.deepEqual(createHistory(storage).entries(), ["ok"]);
});

test("a shared program survives encoding, with unicode and big text", async () => {
    const content = { program: ";caf\u00e9 \u2713\n\"x\" emits\n" + "(1 2 +)\n".repeat(5000), input: "line one\nline two \u00e8\n" };
    const payload = await encodeShare(content);
    assert.match(payload, /^[zr][A-Za-z0-9_-]+$/);
    assert.ok(payload.length < content.program.length, "compressed");
    assert.deepEqual(await decodeShare(payload), content);
});

test("share links carry the payload in the fragment and read back", async () => {
    const link = await shareLink("http://localhost:8000/playground/index.html?x=1", { program: "1 2 +" });
    assert.match(link, /^http:\/\/localhost:8000\/playground\/index\.html\?x=1#share=z/);
    assert.deepEqual(await readShare(new URL(link).hash), { program: "1 2 +", input: "" });
});

test("invalid or foreign fragments are not shares", async () => {
    assert.equal(await readShare(""), null);
    assert.equal(await readShare("#other=abc"), null);
    assert.equal(await readShare("#share=!!!"), null);
    assert.equal(await readShare("#share=zAAAA"), null, "not a valid deflate stream");
    assert.equal(await decodeShare("x" + "AAAA"), null);
    assert.equal(await decodeShare("r" + Buffer.from('{"p":5}').toString("base64url")), null);
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
