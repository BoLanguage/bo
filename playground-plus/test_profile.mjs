// Tests for the pure parts of the profile dialog (the dialog itself is checked in a real browser).
// Usage: node playground-plus/test_profile.mjs
import assert from "node:assert/strict";
import { agentRows, breakdownRows, formatNumber, formatRate, formatSeconds, overviewTiles } from "./client/profile.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("numbers, rates and times read plainly, and a missing value is a dash", () => {
    assert.deepEqual([formatNumber(0), formatNumber(2.5), formatNumber(null), formatNumber(undefined)], ["0", "2.5", "–", "–"]);
    assert.deepEqual([formatRate(0.5), formatRate(1), formatRate(0), formatRate(0.333), formatRate(null)], ["50%", "100%", "0%", "33%", "–"]);
    assert.deepEqual([formatSeconds(5), formatSeconds(59), formatSeconds(60), formatSeconds(125), formatSeconds(3605), formatSeconds(null)], ["5 s", "59 s", "1 min 00 s", "2 min 05 s", "60 min 05 s", "–"]);
});

test("the headline tiles say what the player asked to see, with notes where a number needs one", () => {
    const stats = {
        played: 12, solved: 8, revealed: 1, abandoned: 2, skipped: 1, solveRate: 0.89, meanDifficulty: 2.4, medianSolveSeconds: 75,
        averageHintsOnSolved: 0.5, meanTokensToSolve: 4.2, meanLengthRatio: 1.8,
    };
    const tiles = overviewTiles(stats);
    const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]));
    assert.equal(byLabel["puzzles played"].value, "12");
    assert.deepEqual([byLabel.solved.value, byLabel.solved.note], ["8", "89% of those finished"]);
    assert.equal(byLabel["solution revealed"].value, "1");
    assert.deepEqual([byLabel.abandoned.value, byLabel.abandoned.note], ["3", "1 left for another puzzle"], "abandoned includes the ones left for another");
    assert.equal(byLabel["mean difficulty (1 to 5)"].value, "2.4");
    assert.equal(byLabel["median time to solve"].value, "1 min 15 s");
    assert.equal(byLabel["hints per solved puzzle"].value, "0.5");
    assert.deepEqual([byLabel["tokens typed to solve"].value, byLabel["tokens typed to solve"].note], ["4.2", "1.8× the shortest known answer"]);
    assert.equal(overviewTiles(stats, { subject: "attempts" })[0].label, "attempts played");
});

test("a player with no history gets dashes and zeros, not errors", () => {
    const empty = { played: 0, solved: 0, revealed: 0, abandoned: 0, skipped: 0, solveRate: null, meanDifficulty: null, medianSolveSeconds: null, averageHintsOnSolved: null, meanTokensToSolve: null, meanLengthRatio: null };
    const tiles = overviewTiles(empty);
    assert.deepEqual(tiles.map((t) => t.value), ["0", "0", "0", "0", "–", "–", "–", "–"]);
    assert.ok(tiles.every((t) => !t.note), "no notes without numbers");
});

test("breakdown and agent rows are ready to put in a table", () => {
    const groups = { 1: { played: 3, solved: 3, solveRate: 1, medianSolveSeconds: 20 }, 3: { played: 2, solved: 0, solveRate: 0, medianSolveSeconds: null } };
    assert.deepEqual(breakdownRows(groups), [["1", "3", "3", "100%", "20 s"], ["3", "2", "0", "0%", "–"]]);
    assert.deepEqual(breakdownRows({}), []);
    assert.deepEqual(agentRows([{ model: "gemma4:12b", played: 4, solved: 3, solveRate: 0.75, medianSolveSeconds: 90, meanTokensToSolve: 3 }]), [["gemma4:12b", "4", "3", "75%", "1 min 30 s", "3"]]);
    assert.deepEqual(agentRows([]), []);
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
