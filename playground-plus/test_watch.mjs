// Tests for the pure parts of "Watch an agent play" (the dialogs themselves are checked in a real browser).
// Usage: node playground-plus/test_watch.mjs
import assert from "node:assert/strict";
import { describeAgentJob, describeOutcome, describePuzzle, describeRun, liveStep, replayClock, runAsJob, statusParts, stepLines } from "./client/watch.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const job = { model: "gemma4:12b", puzzle: { id: "p", title: "Shuffle #1" }, startedAt: 1_000_000, endedAt: null, turn: 3, maxTurns: 20, state: "running" };

test("the puzzle list says how hard each puzzle is and whether agents tried it", () => {
    assert.equal(describePuzzle({ title: "Shuffle #1", difficulty: 2, agentAttempts: 0 }), "Shuffle #1 · difficulty 2");
    assert.equal(describePuzzle({ title: "Shuffle #1", difficulty: 2, agentAttempts: 3 }), "Shuffle #1 · difficulty 2 · agents tried it 3×");
    assert.equal(describePuzzle({ title: "Odd", difficulty: null, agentAttempts: 0 }), "Odd");
});

test("what the agent is doing, with the time and the turn", () => {
    assert.equal(describeAgentJob(job, 1_042_000), "gemma4:12b is playing “Shuffle #1” · 0:42 · turn 3 of 20");
    assert.match(describeAgentJob({ ...job, turn: 0 }, 1_005_000), /^gemma4:12b is getting ready .* · 0:05$/);
    assert.equal(describeAgentJob({ ...job, state: "finished", endedAt: 1_083_000 }, 2_000_000), "gemma4:12b on “Shuffle #1” · 1:23");
    assert.equal(describeAgentJob({ ...job, state: "cancelled", endedAt: 1_010_000 }, 2_000_000), "gemma4:12b was stopped on “Shuffle #1” · 0:10");
    assert.equal(describeAgentJob({ ...job, state: "failed" }, 2_000_000), "gemma4:12b could not play “Shuffle #1”");
});

test("the result is one sentence, and a failure says it counts as one", () => {
    assert.equal(describeOutcome({ state: "finished", outcome: "solved", message: "Solved it with 1 guess and 2 hints." }), "Solved it. It used 1 guess and 2 hints.");
    assert.equal(describeOutcome({ state: "finished", outcome: "abandoned", message: "Ran out of time." }), "Not solved: ran out of time. This counts as a failure.");
    assert.equal(describeOutcome({ state: "finished", outcome: "revealed", message: "Gave up and asked for the answer." }), "Not solved: gave up and asked for the answer. This counts as a failure.");
    assert.equal(describeOutcome({ state: "cancelled" }), "Stopped. Nothing was recorded.");
    assert.equal(describeOutcome({ state: "failed", message: "The model could not be used: x." }), "The model could not be used: x. Nothing was recorded.");
});

test("a replay shows the time of what is being played, and only that time is bold", () => {
    const replay = { replay: true, model: "gemma4:12b", puzzle: { title: "Shuffle #1" }, startedAt: 1_000_000, endedAt: null, state: "running", shownMs: 7000 };
    assert.equal(describeAgentJob(replay), "Replaying gemma4:12b on “Shuffle #1” · 0:07");
    assert.deepEqual(statusParts({ ...replay, shownMs: 65_000 }), [["Replaying gemma4:12b on “Shuffle #1” · ", false], ["1:05", true]]);
    assert.deepEqual(statusParts({ ...replay, state: "finished", shownMs: 37_000 }), [["gemma4:12b on “Shuffle #1” · ", false], ["0:37", true]]);
    assert.deepEqual(statusParts({ ...job, turn: 3 }, 1_042_000).filter(([, bold]) => bold), [["0:42", true]], "the live status has one bold part too");
});

test("the replay's clock ticks at real time, and stays at the time of the step at the other speeds", () => {
    const mark = { at: 34_000, since: 5_000_000 };
    assert.equal(replayClock({ speed: "real", ...mark }, 5_003_000), 37_000);
    assert.equal(replayClock({ speed: "real", ...mark }, 4_000_000), 34_000, "never backwards");
    assert.equal(replayClock({ speed: "compressed", ...mark }, 5_003_000), 34_000);
    assert.equal(replayClock({ speed: "fast", ...mark }, 5_900_000), 34_000);
});

test("a recorded run is listed and described like a live one, so a replay ends the same way", () => {
    assert.equal(describeRun({ model: "gemma4:12b", title: "Shuffle #1", outcome: "solved", seconds: 74 }), "gemma4:12b on “Shuffle #1” · solved · 1:14");
    assert.equal(describeRun({ model: "m", title: "T", outcome: "revealed", seconds: 5 }), "m on “T” · gave up · 0:05");
    assert.equal(describeRun({ model: "m", title: "T", outcome: "abandoned", seconds: 300 }), "m on “T” · not solved · 5:00");
    assert.equal(describeOutcome(runAsJob({ outcome: "solved", guesses: 1, hints: 2 })), "Solved it. It used 1 guess and 2 hints.");
    assert.equal(describeOutcome(runAsJob({ outcome: "solved", guesses: 3, hints: 1 })), "Solved it. It used 3 guesses and 1 hint.");
    assert.match(describeOutcome(runAsJob({ outcome: "revealed" })), /^Not solved: gave up and asked for the answer\./);
    assert.match(describeOutcome(runAsJob({ outcome: "abandoned" })), /^Not solved: did not finish: it ran out of time or turns/);
});

test("a step of a recorded run is read like a live one", () => {
    assert.deepEqual(liveStep({ kind: "say", code: "Let me try rot.", at: 5 }), { kind: "say", code: "Let me try rot.", at: 5, text: "Let me try rot." });
    assert.deepEqual(liveStep({ kind: "think", code: "Hmm.", at: 5 }), { kind: "think", code: "Hmm.", at: 5, text: "Hmm." });
    assert.deepEqual(liveStep({ kind: "run", code: "-rot" }), { kind: "run", code: "-rot" });
    assert.deepEqual(stepLines({ kind: "think", text: "Hmm." }), [{ kind: "think", text: "Hmm." }]);
});

test("a step becomes lines: the typed line, what it printed, the error, the stack", () => {
    assert.deepEqual(stepLines({ kind: "run", code: "-rot", output: "", error: null, stack: "Stack: (1 2 3)" }), [{ kind: "code", text: "› -rot" }, { kind: "stack", text: "Stack: (1 2 3)" }]);
    assert.deepEqual(stepLines({ kind: "guess", code: "guess", output: "Solved.", stack: "Stack: (1 2 3)", solved: true }).map((l) => l.kind), ["code", "out", "stack"]);
    assert.deepEqual(stepLines({ kind: "run", code: "bogus", output: "", error: "Existence-Error", stack: "Stack: ()" }).map((l) => l.kind), ["code", "err", "stack"]);
    assert.deepEqual(stepLines({ kind: "say", text: "Let me try rot." }), [{ kind: "say", text: "Let me try rot." }]);
    assert.deepEqual(stepLines({ kind: "lookup", code: "foldl" }), [{ kind: "note", text: "looked up “foldl” in the documentation" }]);
    assert.deepEqual(stepLines({ kind: "give-up" }), [{ kind: "note", text: "gave up and asked for the answer" }]);
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
