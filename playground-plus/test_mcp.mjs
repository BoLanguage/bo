// Tests the MCP server through the protocol itself: a real client, the real server process over
// stdio, a real database file. Usage: node playground-plus/test_mcp.mjs (after `make wasm`)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase } from "./db.mjs";

import { SAMPLE_PUZZLE, SAMPLE_SPEC } from "./test_fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const spec = SAMPLE_SPEC;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const dir = mkdtempSync(join(tmpdir(), "plus-mcp-"));
const databasePath = join(dir, "plus.sqlite");
const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", join(here, "mcp.mjs")],
    env: { ...process.env, PLAYGROUND_PLUS_DB: databasePath },
    stderr: "pipe",
});
const client = new Client({ name: "test-agent", version: "1.2.3" });
await client.connect(transport);
const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, text: result.content.map((c) => c.text).join("\n") };
};

test("the server describes itself and offers exactly the intended tools", async () => {
    assert.equal(client.getServerVersion().name, "playground-plus");
    assert.match(client.getInstructions(), /get_bo_guide/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
        "get_bo_guide", "get_bo_reference", "get_brief", "get_session_history", "get_user_profile", "list_puzzles", "submit_puzzle", "validate_puzzle",
    ]);
    for (const tool of tools) assert.ok(tool.description.length > 40, tool.name);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.validate_puzzle.annotations.readOnlyHint, true);
    assert.equal(byName.submit_puzzle.annotations.readOnlyHint, false);
    assert.equal(byName.submit_puzzle.annotations.destructiveHint, false);
    assert.deepEqual(byName.submit_puzzle.inputSchema.required.sort(), ["goal", "hints", "inputs", "kind", "solution", "tags"]);
    assert.deepEqual(byName.submit_puzzle.inputSchema.properties.kind.enum, ["arrange", "define"], "placeholder kinds are not offered");
    assert.ok(byName.submit_puzzle.inputSchema.properties.tags.items.enum.includes("shuffle"));
    assert.equal(byName.submit_puzzle.inputSchema.properties.hints.maxItems, 3);
});

test("the guide and the references are readable as tools and as resources", async () => {
    const guide = await call("get_bo_guide");
    assert.match(guide.text, /^# Writing puzzles for Bo Playground\+/);
    assert.match(guide.text, /"kind": "arrange"/);
    const reference = await call("get_bo_reference", { topic: "language" });
    assert.match(reference.text, /^# The language/);
    const outline = await call("get_bo_reference", { topic: "library" });
    assert.ok(outline.text.length < 8000, "a long document is not dumped");
    const looked = await call("get_bo_reference", { topic: "library", query: "foldl" });
    assert.match(looked.text, /\| `foldl` \|/);
    const searched = await call("get_bo_reference", { query: "swap" });
    assert.match(searched.text, /=== library/, "a query alone searches every document");
    assert.equal((await call("get_bo_reference", { topic: "nonsense" })).error, true);
    assert.equal((await call("get_bo_reference", { topic: "library", query: "x".repeat(101) })).error, true, "the query is limited");
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri).sort(), [
        "bo://guide", "bo://reference/examples", "bo://reference/language", "bo://reference/library", "bo://reference/primitives",
    ]);
    const read = await client.readResource({ uri: "bo://guide" });
    assert.equal(read.contents[0].text, guide.text);
});

test("a new player has no history, and there are no puzzles yet", async () => {
    assert.match((await call("get_user_profile")).text, /"sessions": 0/);
    assert.equal((await call("get_session_history", { limit: 5 })).text, "[]");
    assert.equal((await call("list_puzzles")).text, "[]");
    assert.equal((await call("get_session_history", { limit: 0 })).error, true, "the limit is validated");
});

test("an invalid puzzle is explained and not stored; a valid one is validated, then stored under the client's name", async () => {
    const broken = { ...spec, solution: "swap swap" };
    const bad = await call("validate_puzzle", broken);
    assert.equal(bad.error, false, "validation reports problems as content, not as a failure");
    assert.match(bad.text, /PROBLEM the solution leaves the stack as it started/);
    assert.match(bad.text, /Fix these and validate again/);
    const refused = await call("submit_puzzle", broken);
    assert.equal(refused.error, true);
    assert.match(refused.text, /Not stored/);
    assert.equal((await call("list_puzzles")).text, "[]");

    const good = await call("validate_puzzle", spec);
    assert.match(good.text, /Title: Shuffle #1 · test-agent; tags: shuffle; difficulty 1/);
    assert.match(good.text, /turns the start stack \(2 3 1\) into \(1 2 3\)/, "the agent is shown what its solution produced");
    assert.match(good.text, /: valid/);
    const stored = await call("submit_puzzle", spec);
    assert.equal(stored.error, false);
    assert.match(stored.text, /Stored: "Shuffle #1 · test-agent"/);
    assert.match((await call("submit_puzzle", spec)).text, /already submitted/);

    const listed = JSON.parse((await call("list_puzzles")).text);
    assert.deepEqual(listed.map((p) => [p.title, p.tags, p.difficulty, p.plays]), [["Shuffle #1 · test-agent", ["shuffle"], 1, 0]]);
    assert.ok(!JSON.stringify(listed).includes("-rot"), "the answer is not listed");
    const database = openDatabase(databasePath);
    try {
        assert.equal(database.listPuzzles().length, 1, "the puzzle is in the file the server reads");
        assert.equal(database.getPuzzle(listed[0].id).package.provenance.client, "test-agent");
    } finally {
        database.close();
    }
});

test("the brief says what to write next, and is kept with the puzzle that follows it", async () => {
    const brief = await call("get_brief");
    assert.equal(brief.error, false);
    assert.match(brief.text, /^Brief for your next puzzle/);
    const idea = /- idea: (.*) Make the numbers your own\./.exec(brief.text)[1];
    assert.ok(idea.length > 10);
    assert.match(brief.text, /- do not repeat these goals:\n  \* Reorder the stack so that 3 is on top/, "the existing puzzle is listed");
    const next = { ...spec, goal: "Leave the middle of three values on top.", inputs: [[4, 9, 6]], solution: "swap", hints: ["Swap."] };
    const stored = await call("submit_puzzle", next);
    assert.equal(stored.error, false, stored.text);
    const database = openDatabase(databasePath);
    try {
        const puzzle = database.listPuzzleSummaries().at(-1);
        assert.equal(database.getPuzzle(puzzle.id).package.brief.idea, idea);
        assert.equal(puzzle.brief.idea, idea);
    } finally {
        database.close();
    }
});

test("a run of lookups without a draft gets a nudge, then a refusal, and validating resets the count", async () => {
    await call("validate_puzzle", spec); // earlier tests made lookups; start the count again
    const lookup = async (query) => call("get_bo_reference", { query });
    assert.doesNotMatch((await lookup("swap")).text, /\[Note:/);
    assert.doesNotMatch((await lookup("rot")).text, /\[Note:/);
    const third = await lookup("nip");
    assert.match(third.text, /\[Note: that was lookup number 3 and you have not validated a draft yet/);
    assert.match(third.text, /of your own/, "it asks for the agent's own puzzle, not a copy");
    assert.match((await lookup("pick")).text, /lookup number 4/);
    const refused = await lookup("over");
    assert.equal(refused.error, true);
    assert.match(refused.text, /Lookup limit reached: you have looked things up 4 times without validating a draft/);
    assert.equal((await lookup("drop")).error, true, "it stays refused until a draft is validated");
    await call("validate_puzzle", spec);
    const again = await lookup("over");
    assert.equal(again.error, false);
    assert.doesNotMatch(again.text, /\[Note:/, "validating starts the count again");
});

test("bad arguments are rejected, or explained when the shape is right but the content is not", async () => {
    for (const args of [{}, { kind: "nope" }, { ...spec, tags: ["magic"] }, { ...spec, kind: "predict" }, { ...spec, hints: [] }, { ...spec, goal: 5 }]) {
        const outcome = await client.callTool({ name: "validate_puzzle", arguments: args }).then((r) => r.isError === true, () => true);
        assert.equal(outcome, true, JSON.stringify(args));
    }
    const explained = await call("validate_puzzle", { ...spec, goal: "short", inputs: [[1, 2.5]] });
    assert.equal(explained.error, false);
    assert.match(explained.text, /PROBLEM goal must be a sentence/);
    assert.match(explained.text, /PROBLEM inputs\[0\] must be a list of up to 12 whole numbers/);
});

test("the same puzzle validated twice in a row is pointed out, and a valid one is not", async () => {
    const same = { ...spec, solution: "swap swap" };
    const first = await call("validate_puzzle", same);
    assert.doesNotMatch(first.text, /exactly the same puzzle/);
    const second = await call("validate_puzzle", same);
    assert.match(second.text, /^\[You sent exactly the same puzzle as your last validate_puzzle call/);
    assert.match(second.text, /PROBLEM the solution leaves the stack as it started/);
    const fresh = { ...spec, goal: "Reorder the three values so that the smallest ends up on top.", inputs: [[8, 5, 6]] };
    const fixed = await call("validate_puzzle", fresh);
    assert.doesNotMatch(fixed.text, /exactly the same puzzle/);
    assert.match(fixed.text, /\nValid\.$/);
    assert.doesNotMatch((await call("validate_puzzle", fresh)).text, /exactly the same puzzle/, "a valid puzzle repeated is just valid");
});

test("the advanced tools that take a whole puzzle file exist only when asked for", async () => {
    const raw = new Client({ name: "raw-agent", version: "1" });
    const rawTransport = new StdioClientTransport({
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", join(here, "mcp.mjs")],
        env: { ...process.env, PLAYGROUND_PLUS_DB: join(dir, "raw.sqlite"), PLAYGROUND_PLUS_RAW: "1" },
        stderr: "pipe",
    });
    await raw.connect(rawTransport);
    try {
        const names = (await raw.listTools()).tools.map((t) => t.name);
        assert.ok(names.includes("validate_bo_puzzle") && names.includes("submit_bo_puzzle") && names.includes("submit_puzzle"));
        const send = async (name, source) => (await raw.callTool({ name, arguments: { source } })).content[0].text;
        assert.match(await send("validate_bo_puzzle", SAMPLE_PUZZLE.replace(";@solution -rot guess", ";@solution swap guess")), /ERROR +solution:1/);
        assert.match(await send("submit_bo_puzzle", SAMPLE_PUZZLE), /Stored: "Put three in order"/);
        assert.match(await send("submit_bo_puzzle", SAMPLE_PUZZLE), /already existed/);
    } finally {
        await raw.close();
    }
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
await client.close();
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
