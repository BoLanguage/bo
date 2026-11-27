// Tests for the brief maker. Usage: node playground-plus/test_brief.mjs
import assert from "node:assert/strict";
import { IDEAS, formatBrief, makeBrief } from "./brief.mjs";
import { TAGS, KINDS } from "./compile.mjs";
import { CHANGES, cleanPreferences } from "./taxonomy.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const stats = (solved, revealed = 0) => ({ sessions: solved + revealed, solved, revealed, skipped: 0, abandoned: 0, open: 0, solveRate: solved + revealed ? solved / (solved + revealed) : null });
const newPlayer = { totals: { sessions: 0 }, byDifficulty: {}, byTag: {} };
const first = () => 0; // always the first candidate

test("every idea is for a known topic and an available kind, at a difficulty from 1 to 5", () => {
    for (const [tag, ideas] of Object.entries(IDEAS)) {
        assert.ok(TAGS.includes(tag), tag);
        assert.ok(ideas.length >= 3, `${tag} has a few ideas`);
        for (const entry of ideas) {
            assert.ok(KINDS[entry.kind]?.available, entry.idea);
            assert.ok(entry.difficulty >= 1 && entry.difficulty <= 5);
            assert.match(entry.idea, /^[A-Z].*\.$/);
        }
    }
    assert.deepEqual(Object.keys(IDEAS).sort(), [...TAGS].sort(), "a topic without ideas could never be briefed");
});

test("a new player gets an easy puzzle, and the reason says so", () => {
    const brief = makeBrief({ profile: newPlayer, puzzles: [], random: first });
    assert.equal(brief.difficulty, 1);
    assert.match(brief.why, /the player is new/);
    assert.deepEqual(brief.avoid, []);
    assert.ok(IDEAS[brief.tag].some((entry) => entry.idea === brief.idea && entry.kind === brief.kind));
});

test("difficulty goes one step above what the player solves reliably, and not above 5", () => {
    const solid = { totals: { sessions: 6 }, byDifficulty: { 1: stats(3), 2: stats(3) }, byTag: { shuffle: stats(6) } };
    assert.equal(makeBrief({ profile: solid, puzzles: [], random: first }).difficulty, 3, "100% at level 2");
    const middling = { totals: { sessions: 6 }, byDifficulty: { 1: stats(3), 2: stats(2, 1) }, byTag: { shuffle: stats(5, 1) } };
    assert.equal(makeBrief({ profile: middling, puzzles: [], random: first }).difficulty, 2, "67% at level 2 is not yet reliable enough to move on");
    const strugglingStart = { totals: { sessions: 3 }, byDifficulty: { 1: stats(0, 3) }, byTag: { shuffle: stats(0, 3) } };
    assert.equal(makeBrief({ profile: strugglingStart, puzzles: [], random: first }).difficulty, 1);
    const expert = { totals: { sessions: 6 }, byDifficulty: { 5: stats(6) }, byTag: { list: stats(6) } };
    assert.equal(makeBrief({ profile: expert, puzzles: [], random: first }).difficulty, 5);
    const barelyPlayed = { totals: { sessions: 1 }, byDifficulty: { 3: stats(1) }, byTag: {} };
    assert.equal(makeBrief({ profile: barelyPlayed, puzzles: [], random: first }).difficulty, 1, "one session is not evidence");
});

test("the topic is one the player has not tried, and when all were tried, the one they do worst on", () => {
    const tried = Object.fromEntries(TAGS.filter((tag) => tag !== "recursion").map((tag) => [tag, stats(3)]));
    const profile = { totals: { sessions: 18 }, byDifficulty: { 1: stats(18) }, byTag: tried };
    const fresh = makeBrief({ profile, puzzles: [], random: first });
    assert.equal(fresh.tag, "recursion");
    assert.match(fresh.why, /has not tried recursion/);

    const all = Object.fromEntries(TAGS.map((tag) => [tag, stats(3)]));
    all.list = stats(1, 2);
    const worst = makeBrief({ profile: { totals: { sessions: 21 }, byDifficulty: { 1: stats(21) }, byTag: all }, puzzles: [], random: first });
    assert.equal(worst.tag, "list");
    assert.match(worst.why, /list is where the player does worst \(33% solved\)/);
});

test("what the player asked for wins: topics, easier or harder than the last puzzle, an exact difficulty, a kind", () => {
    // the player solves level 2 reliably (so the brief alone would say 3) and last played a level 2 puzzle
    const profile = { totals: { sessions: 6 }, byDifficulty: { 1: stats(3), 2: stats(3) }, byTag: { shuffle: stats(6) }, recent: [{ difficulty: 2 }, { difficulty: 4 }] };
    const asked = makeBrief({ profile, puzzles: [], random: first, preferences: { tags: ["list", "magic"], change: "harder" } });
    assert.equal(asked.tag, "list");
    assert.equal(asked.difficulty, 3, "one more than the last puzzle, not than the player's level");
    assert.match(asked.why, /asked for something harder than the last puzzle \(difficulty 2\)/);
    assert.equal(makeBrief({ profile, puzzles: [], random: first, preferences: { change: "easier" } }).difficulty, 1);
    assert.equal(makeBrief({ profile, puzzles: [], random: first }).difficulty, 3, "without a wish it is the skill-based step");
    assert.equal(makeBrief({ profile: { ...profile, recent: [{ difficulty: 5 }] }, puzzles: [], random: first, preferences: { change: "harder" } }).difficulty, 5, "never above 5");
    assert.equal(makeBrief({ profile: { ...profile, recent: [{ difficulty: 1 }] }, puzzles: [], random: first, preferences: { change: "easier" } }).difficulty, 1, "never below 1");
    assert.equal(makeBrief({ profile, puzzles: [], random: first, preferences: { difficulty: 9 } }).difficulty, 5);
    const nothingBefore = makeBrief({ profile: newPlayer, puzzles: [], random: first, preferences: { change: "harder" } });
    assert.equal(nothingBefore.difficulty, 1, "no earlier puzzle: the wish cannot be followed");
    assert.match(nothingBefore.why, /has no earlier puzzle to compare with/);
    const arithmeticDefine = makeBrief({ profile: newPlayer, puzzles: [], random: first, preferences: { tags: ["arithmetic"], kind: "define" } });
    assert.equal(arithmeticDefine.kind, "define");
});

test("the idea is the topic's nearest in difficulty that was not used before", () => {
    const base = { profile: newPlayer, random: first, preferences: { tags: ["shuffle"] } };
    const one = makeBrief({ ...base, puzzles: [] });
    assert.equal(one.difficulty, 1);
    assert.equal(IDEAS.shuffle.find((entry) => entry.idea === one.idea).difficulty, 1);
    const used = makeBrief({ ...base, puzzles: [{ goal: "g", tags: ["shuffle"], brief: { idea: one.idea } }] });
    assert.notEqual(used.idea, one.idea);
    const everyIdea = IDEAS.recursion.map((entry) => ({ goal: "g", tags: [], brief: { idea: entry.idea } }));
    const exhausted = makeBrief({ profile: newPlayer, random: first, preferences: { tags: ["recursion"] }, puzzles: everyIdea });
    assert.match(exhausted.why, /every idea for this topic was used/);
});

test("the goals to avoid are the newest ones, and the brief reads as plain text", () => {
    const puzzles = Array.from({ length: 12 }, (_, index) => ({ goal: `goal ${index}`, tags: [] }));
    const brief = makeBrief({ profile: newPlayer, puzzles, random: first });
    assert.deepEqual(brief.avoid, puzzles.slice(-8).map((p) => p.goal));
    const text = formatBrief(brief);
    assert.match(text, /^Brief for your next puzzle/);
    assert.ok(text.includes(`- kind: ${brief.kind}`) && text.includes(`- main tag: ${brief.tag}`) && text.includes("goal 11"));
    assert.doesNotMatch(formatBrief({ ...brief, avoid: [] }), /do not repeat/);
});

test("the ops an idea needs are in the brief, and the brief for a new player is at its level", () => {
    for (const [tag, ideas] of Object.entries(IDEAS))
        for (const entry of ideas) assert.ok(Array.isArray(entry.ops) && entry.ops.length >= 1, `${tag}: ${entry.idea}`);
    const brief = makeBrief({ profile: newPlayer, puzzles: [], random: first });
    assert.ok(brief.ops.length >= 1);
    assert.match(formatBrief(brief), new RegExp(`- Bo ops the solution will probably use: ${brief.ops.map((w) => w.replace(/[-+*/^]/g, "\\$&")).join(" ")} `));
    for (let i = 0; i < 40; i++) assert.equal(IDEAS[makeBrief({ profile: newPlayer, puzzles: [] }).tag].some((e) => e.difficulty === 1), true, "a new player gets a topic that has a level 1 idea");
});

test("a new player is not handed recursion: a topic needs an idea near the difficulty", () => {
    for (let i = 0; i < 80; i++) {
        const brief = makeBrief({ profile: newPlayer, puzzles: [] });
        assert.notEqual(brief.tag, "recursion");
        assert.equal(brief.difficulty, 1);
        assert.ok(IDEAS[brief.tag].some((entry) => entry.idea === brief.idea && entry.difficulty <= 2));
    }
    const tried = Object.fromEntries(["shuffle", "arithmetic", "quotation", "definition"].map((tag) => [tag, stats(3)]));
    const profile = { totals: { sessions: 12 }, byDifficulty: { 1: stats(12) }, byTag: tried };
    for (let i = 0; i < 30; i++) assert.ok(["conditional", "list", "recursion"].includes(makeBrief({ profile, puzzles: [] }).tag));
});

test("what a player may ask for is checked, and only what was asked is kept", () => {
    assert.deepEqual(cleanPreferences(), {});
    assert.deepEqual(cleanPreferences({ tags: [], change: "same" }), {});
    assert.deepEqual(cleanPreferences({ tags: ["list"], change: "harder" }), { tags: ["list"], change: "harder" });
    for (const bad of [{ kind: "define" }, { tags: ["magic"] }, { tags: ["list", "list"] }, { tags: "list" }, { change: "wild" }, null, []])
        assert.throws(() => cleanPreferences(bad), Error, JSON.stringify(bad));
    assert.deepEqual(CHANGES, ["easier", "same", "harder"]);
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
