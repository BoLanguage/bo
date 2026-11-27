// Tests for Playground+'s service layer. Usage: node playground-plus/test_service.mjs (after `make wasm`)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBo } from "../wasm/bo.mjs";
import { parsePuzzle } from "../playground/puzzles.mjs";
import { compileSpec } from "./compile.mjs";
import { openDatabase } from "./db.mjs";
import { validatePuzzle } from "./harness.mjs";
import { REFERENCES, REFERENCE_LIMIT, createService, essence } from "./service.mjs";
import { OTHER_PUZZLE, SAMPLE_PUZZLE, SAMPLE_SPEC } from "./test_fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const puzzleFile = (name) => readFileSync(join(root, "examples", "puzzles", name), "utf8");
const builtInOrderThree = puzzleFile("07-order-three.bo");
const orderThree = SAMPLE_PUZZLE;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const create = (options = {}) => {
    const repository = openDatabase();
    return { repository, service: createService({ repository, ...options }) };
};

test("a valid puzzle is stored with what is known about it, and never listed with its answers", async () => {
    const { repository, service } = create({ now: () => 5000 });
    const result = await service.submitPuzzle(orderThree, { client: "claude", model: "some-model" });
    assert.equal(result.accepted, true);
    assert.equal(result.alreadyExisted, false);
    assert.match(result.id, /^[0-9a-f]{64}$/);
    const stored = repository.getPuzzle(result.id);
    assert.equal(stored.title, "Put three in order");
    assert.equal(stored.hints, 1);
    assert.deepEqual(stored.package.tags, ["shuffle"]);
    assert.equal(stored.package.difficulty, 1);
    assert.deepEqual(stored.package.solutions, ["-rot guess"]);
    assert.equal(stored.package.bestKnownLength, 1);
    assert.deepEqual(stored.package.provenance, { client: "claude", model: "some-model", submittedAt: 5000 });
    assert.match(stored.package.warnings[0], /typing the final stack/);
    assert.equal(stored.source.endsWith("\n"), true);
    assert.deepEqual(service.listPuzzles(), [
        { id: result.id, title: "Put three in order", goal: "Reorder the stack so that 3 is on top, then 2, then 1.", tags: ["shuffle"], difficulty: 1, bestKnownLength: 1, plays: 0 },
    ]);
    // the list the page gets has no package, so no reference solutions
    assert.ok(repository.listPuzzles().every((row) => !("package" in row)));
});

test("what makes a puzzle that puzzle: its solutions and setup code, not its wording", () => {
    const base = ";@puzzle\n;@title A\n;@goal G\n;@solution rot guess\n;@end\n\"include/std.bo\" require ; setup\n3 1 2\n(\"hint one\") (puzzle.hints) PUSH\n";
    const wording = base.replace("title A", "title B").replace("goal G", "goal H").replace("hint one", "another hint").replace("; setup", "; different comment");
    assert.equal(essence(base), essence(wording));
    assert.equal(essence(base), essence(base.replace(/\n/g, "\r\n")));
    assert.notEqual(essence(base), essence(base.replace("3 1 2", "3 2 1")), "other starting values");
    assert.notEqual(essence(base), essence(base.replace("rot guess", "swap guess")), "another solution");
    assert.notEqual(essence(base), essence(`${base}1 2 +\n`), "extra setup code");
    assert.doesNotThrow(() => essence(`${base}(unclosed`), "unreadable Bo is still compared");
});

test("copying an existing puzzle, a built-in one or a guide example is refused, and the reason is given", async () => {
    const { repository, service } = create();
    const copyOfBuiltIn = await service.submitPuzzle(builtInOrderThree);
    assert.equal(copyOfBuiltIn.accepted, false);
    const novelty = copyOfBuiltIn.report.checks.find((c) => c.id === "novelty");
    assert.equal(novelty.ok, false);
    assert.match(novelty.message, /its title or goal is the same as in the playground's puzzle "Order three values"/);
    assert.match(novelty.message, /examples only show the structure/);

    const guide = service.getGuide();
    const specExample = JSON.parse(/```spec\n([\s\S]*?)```/.exec(guide)[1]);
    const copyOfExample = await service.validateSpec(specExample);
    assert.equal(copyOfExample.ok, false);
    assert.match(copyOfExample.report.checks.find((c) => c.id === "novelty").message, /the guide's arrange example "Put the three values in ascending order/);
    // rewording is not enough: the same inputs and solution under a new goal and new hints
    const reworded = { ...specExample, goal: "Arrange the numbers from the smallest at the bottom up.", hints: ["Think of a rotation."] };
    const rewordedResult = await service.validateSpec(reworded);
    assert.equal(rewordedResult.ok, false);
    assert.match(rewordedResult.report.checks.find((c) => c.id === "novelty").message, /inputs and solution are the same as in the guide's arrange example/);
    // another start stack is a new puzzle, but the same goal is not
    assert.equal((await service.validateSpec({ ...reworded, inputs: [[8, 4, 6]] })).ok, true);
    assert.equal((await service.validateSpec({ ...specExample, inputs: [[8, 4, 6]] })).ok, false, "the goal is copied");
    assert.equal(repository.listPuzzleSummaries().length, 0);

    // a stored puzzle is protected too, but sending the very same text again is only a repeat
    const mine = await service.submitPuzzle(orderThree);
    assert.equal(mine.accepted, true);
    const again = await service.submitPuzzle(orderThree);
    assert.deepEqual([again.accepted, again.alreadyExisted], [true, true]);
    const clash = await service.submitPuzzle(orderThree.replace(";@hints 1", ";@hints 1\n;@wrong guess"));
    assert.equal(clash.accepted, false, "another text with the same title and goal");
    assert.match(clash.report.checks.find((c) => c.id === "novelty").message, /the existing puzzle "Put three in order"/);
    assert.equal(repository.listPuzzleSummaries().length, 1);
    // a genuinely different puzzle is fine, and the check passes visibly
    const different = OTHER_PUZZLE;
    const fine = await service.submitPuzzle(different);
    assert.equal(fine.accepted, true);
    assert.equal(fine.report.checks.find((c) => c.id === "novelty").ok, true);
});

test("a spec is built, validated and stored with its spec, title, tags and difficulty; a retry is a repeat", async () => {
    const { repository, service } = create({ now: () => 7000 });
    const spec = {
        kind: "define", tags: ["definition", "arithmetic"], op: "thrice-minus-one",
        goal: "Define `thrice-minus-one` so that it triples the number on top and then subtracts one.",
        inputs: [[0], [3], [10], [-4]], solution: "3 * 1 -", hints: ["Triple first, then subtract one."],
    };
    const result = await service.submitSpec(spec, { client: "some-client", model: "gemma4:12b" });
    assert.equal(result.accepted, true);
    assert.equal(result.alreadyExisted, false);
    const stored = repository.getPuzzle(result.id);
    assert.equal(stored.title, "Definition #1 · gemma4:12b");
    assert.equal(stored.hints, 2);
    assert.deepEqual([stored.package.tags, stored.package.difficulty, stored.package.freeHints], [["definition", "arithmetic"], 2, 1]);
    assert.deepEqual(stored.package.spec.inputs, spec.inputs);
    assert.deepEqual(stored.package.provenance, { client: "some-client", model: "gemma4:12b", submittedAt: 7000 });
    assert.match(service.describeSpecResult(result.result), /Title: Definition #1 · gemma4:12b; tags: definition, arithmetic; difficulty 2 \(estimated\)\.\n.*\n  0 thrice-minus-one -> \(-1\)\n  3 thrice-minus-one -> \(8\)/);

    const retry = await service.submitSpec({ ...spec, solution: "3 * 1 - guess" }, { client: "other" });
    assert.deepEqual([retry.accepted, retry.alreadyExisted, retry.id], [true, true, result.id], "the same spec is stored once");
    assert.equal(repository.listPuzzleSummaries().length, 1);

    // the client's name is the author when the model is unknown, and the numbers go on
    const second = await service.submitSpec({ kind: "arrange", tags: ["shuffle"], goal: "Move the bottom value to the top of the stack.", inputs: [[1, 2, 3]], solution: "rot", hints: ["Rotate."] }, { client: "claude-desktop" });
    assert.equal(repository.getPuzzle(second.id).title, "Shuffle #2 · claude-desktop");
});

test("a spec with problems is not stored, and the report says what to fix; novelty works on specs", async () => {
    const { repository, service } = create();
    const bad = await service.submitSpec({ kind: "arrange", tags: ["shuffle"], goal: "Put the three values in ascending order.", inputs: [[7, 3, 5]], solution: "swap swap", hints: ["Hmm."] });
    assert.equal(bad.accepted, false);
    assert.match(service.describeSpecResult(bad.result), /PROBLEM the solution leaves the stack as it started/);
    assert.equal(repository.listPuzzleSummaries().length, 0);

    const spec = { kind: "arrange", tags: ["shuffle"], goal: "Put the three values in ascending order.", inputs: [[6, 2, 4]], solution: "rot", hints: ["Rotate."] };
    assert.equal((await service.submitSpec(spec)).accepted, true);
    // the same idea in other words is refused; so is the same goal with another idea
    const reworded = await service.submitSpec({ ...spec, goal: "Arrange the values from small to large.", hints: ["Think of rotating."] });
    assert.equal(reworded.accepted, false);
    assert.match(service.describeSpecResult(reworded.result), /ERROR   novelty: .*same.*only the \w+ differ.*the existing puzzle "Shuffle #1 · agent"/);
    const sameGoal = await service.submitSpec({ ...spec, inputs: [[9, 2, 4]] });
    assert.equal(sameGoal.accepted, false);
    assert.match(service.describeSpecResult(sameGoal.result), /its title or goal is the same as in the existing puzzle/);
    assert.equal((await service.submitSpec({ ...spec, goal: "Rotate the three values.", inputs: [[9, 2, 4]] })).accepted, true);
    assert.equal(repository.listPuzzleSummaries().length, 2);
});

test("a copy of the guide's example is refused: the goal alone is enough, and so are the inputs and solution", async () => {
    const { service } = create();
    const guide = service.getGuide();
    const examples = [...guide.matchAll(/```spec\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    for (const example of examples) {
        const result = await service.validateSpec(example);
        assert.equal(result.ok, false, example.goal);
        assert.match(result.report.checks.find((c) => c.id === "novelty").message, /the guide's (arrange|define) example/);
    }
});

test("a puzzle file is stored once, however its line endings are written", async () => {
    const { repository, service } = create();
    const first = await service.submitPuzzle(orderThree);
    const again = await service.submitPuzzle(orderThree.replace(/\n/g, "\r\n"));
    assert.deepEqual([again.accepted, again.alreadyExisted, again.id], [true, true, first.id]);
    assert.equal(repository.listPuzzleSummaries().length, 1);
});

test("an invalid puzzle is not stored, and the report says why", async () => {
    const { repository, service } = create();
    const broken = orderThree.replace(";@solution -rot guess", ";@solution swap guess");
    const result = await service.submitPuzzle(broken);
    assert.equal(result.accepted, false);
    assert.equal(result.id, null);
    assert.equal(result.report.checks.find((c) => c.id === "solution:1").ok, false);
    assert.equal(repository.listPuzzleSummaries().length, 0);
    assert.equal((await service.submitPuzzle("not a puzzle")).accepted, false);
    await assert.rejects(() => service.submitPuzzle(""), /source must be/);
    await assert.rejects(() => service.submitPuzzle(42), /source must be/);
});

test("an oversized file is refused before anything is parsed or run", async () => {
    let calls = 0;
    const { service } = create({ validate: async () => (calls++, { ok: true }) });
    const result = await service.submitPuzzle(`${orderThree}\n;${"x".repeat(200_000)}`);
    assert.equal(result.accepted, false);
    assert.equal(calls, 0);
    assert.match(result.report.checks[0].message, /far longer/);
});

test("the profile counts outcomes, by difficulty and by tag, and the history lists the newest first", async () => {
    const { repository, service } = create({ now: () => 10 * 86_400_000 });
    const add = (id, tags, difficulty) => repository.addPuzzle({ id, title: id, goal: "g", source: "s", package: { tags, difficulty } });
    add("a", ["shuffle"], 1);
    add("b", ["shuffle", "list"], 2);
    const play = ({ puzzleId, start, end, outcome, state, role = "human", prompts = 2 }) => {
        const id = repository.createSession({ puzzleId, role, now: start });
        repository.addEvents(id, [
            { type: "setup", time: start, duration: 1, puzzleState: { guesses: 0, hints: 0, revealed: false } },
            ...Array.from({ length: prompts }, (_, i) => ({ type: "evaluate", time: start + 100 * (i + 1), duration: 1, code: "x", ok: true, puzzleState: state })),
        ]);
        if (outcome) repository.endSession(id, outcome, end);
        return id;
    };
    play({ puzzleId: "a", start: 1_000_000, end: 1_030_000, outcome: "solved", state: { guesses: 2, hints: 1, revealed: false } });
    play({ puzzleId: "a", start: 2_000_000, end: 2_060_000, outcome: "solved", state: { guesses: 1, hints: 0, revealed: false } });
    play({ puzzleId: "b", start: 3_000_000, end: 3_100_000, outcome: "revealed", state: { guesses: 3, hints: 2, revealed: true } });
    play({ puzzleId: "b", start: 4_000_000, end: 4_010_000, outcome: "skipped", state: { guesses: 0, hints: 0, revealed: false } });
    play({ puzzleId: "b", start: 5_000_000, end: 5_020_000, outcome: "abandoned", state: { guesses: 0, hints: 0, revealed: false } });
    play({ puzzleId: "a", start: 9 * 86_400_000, end: null, outcome: null, state: { guesses: 0, hints: 0, revealed: false }, prompts: 1 });
    play({ puzzleId: "a", start: 9_500_000, end: 9_600_000, outcome: "solved", state: { guesses: 1, hints: 0, revealed: false }, role: "agent" });

    const profile = service.getUserProfile();
    // only the first time each puzzle was played counts (a: solved at 1,000,000; b: revealed at 3,000,000);
    // the later plays, the open one and the agent's session are not the player's first
    assert.deepEqual(
        [profile.totals.sessions, profile.totals.solved, profile.totals.revealed, profile.totals.skipped, profile.totals.abandoned, profile.totals.open],
        [2, 1, 1, 0, 0, 0], "agent sessions are not the player's, and neither are replays");
    assert.equal(profile.totals.solveRate, 0.5, "solved over finished: 1 of 2");
    assert.equal(profile.totals.medianSolveSeconds, 30, "the one solve took 30 seconds");
    assert.equal(profile.byDifficulty[1].sessions, 1);
    assert.equal(profile.byDifficulty[2].sessions, 1);
    assert.equal(profile.byTag.shuffle.sessions, 2);
    assert.equal(profile.byTag.list.sessions, 1);
    assert.equal(profile.byTag.list.solveRate, 0, "nothing solved among the finished list puzzles");
    assert.equal(profile.byDifficulty[1].averageHintsOnSolved, 1);
    assert.equal(profile.byDifficulty[1].averageGuessesOnSolved, 2);
    assert.equal(profile.sessionsInTheLastWeek, 0);
    assert.equal(profile.recent.length, 2);
    assert.deepEqual(profile.recent.map((r) => r.outcome), ["revealed", "solved"], "newest first, first plays only");
    assert.equal(profile.note, undefined);

    const history = service.getSessionHistory({ limit: 3 });
    assert.equal(history.length, 3);
    assert.deepEqual(history.map((h) => h.startedAt), [9 * 86_400_000, 9_500_000, 5_000_000].map((ms) => new Date(ms).toISOString()), "the history lists every session, replays too");
    assert.equal(profile.lastPlayedAt, new Date(3_000_000).toISOString());
    assert.equal(history[2].outcome, "abandoned");
    assert.equal(service.getSessionHistory({ limit: 0 }).length, 1, "the limit is kept between 1 and 100");
    assert.equal(service.getSessionHistory({ limit: 1000 }).length, 7);
    assert.equal(service.listPuzzles().find((p) => p.id === "a").plays, 4, "plays count every session");
});

test("the statistics: first plays only for the player, every attempt for an agent, tokens typed against the best known answer", async () => {
    const { repository, service } = create({ now: () => 10 * 86_400_000 });
    repository.addPuzzle({ id: "a", title: "A", goal: "g", source: "s", package: { tags: ["shuffle"], difficulty: 1, bestKnownLength: 2 } });
    repository.addPuzzle({ id: "b", title: "B", goal: "g", source: "s", package: { tags: ["list"], difficulty: 3, bestKnownLength: 1 } });
    const play = ({ puzzleId, start, outcome, lines, role = "human", client = null, hints = 0 }) => {
        const id = repository.createSession({ puzzleId, role, client, now: start });
        repository.addEvents(id, [
            { type: "setup", time: start, duration: 1, puzzleState: { guesses: 0, hints: 0, revealed: false } },
            ...lines.map((code, i) => ({ type: "evaluate", time: start + 1000 * (i + 1), duration: 1, code, ok: true, puzzleState: { guesses: 1, hints, revealed: false } })),
        ]);
        if (outcome) repository.endSession(id, outcome, start + 30_000);
    };
    // the player: a solved in 5 tokens (best 2), then replayed (not counted); b abandoned
    play({ puzzleId: "a", start: 1_000_000, outcome: "solved", lines: ["swap dup", "rot guess", "hint"], hints: 1 });
    play({ puzzleId: "a", start: 2_000_000, outcome: "solved", lines: ["swap guess"] });
    play({ puzzleId: "b", start: 3_000_000, outcome: "abandoned", lines: ["1 2 +"] });
    // two agents: gemma solved a once and failed it once, and solved b; qwen failed b
    play({ puzzleId: "a", start: 4_000_000, outcome: "solved", lines: ["swap guess"], role: "agent", client: "gemma" });
    play({ puzzleId: "a", start: 5_000_000, outcome: "abandoned", lines: ["x"], role: "agent", client: "gemma" });
    play({ puzzleId: "b", start: 6_000_000, outcome: "solved", lines: ["(1 +) (inc) PUSH guess"], role: "agent", client: "gemma" });
    play({ puzzleId: "b", start: 7_000_000, outcome: "abandoned", lines: [], role: "agent", client: "qwen" });

    const stats = service.getStatistics();
    assert.deepEqual([stats.you.played, stats.you.solved, stats.you.abandoned], [2, 1, 1], "the replay of a is not counted");
    assert.equal(stats.you.meanDifficulty, 2, "difficulties 1 and 3");
    assert.equal(stats.you.meanTokensToSolve, 3, "swap dup, rot; guess and hint are not tokens that try an answer");
    assert.equal(stats.you.meanLengthRatio, 1.5, "3 tokens against a best known answer of 2");
    assert.equal(stats.you.solveRate, 1, "solved over finished: the abandoned one is not finished");
    assert.deepEqual(Object.keys(stats.you.byDifficulty), ["1", "3"]);
    assert.equal(stats.you.byTag.list.played, 1);

    assert.deepEqual(stats.agents.map((a) => [a.model, a.played, a.solved]), [["gemma", 3, 2], ["qwen", 1, 0]], "every attempt of an agent counts, by model");
    assert.equal(stats.agents[0].meanTokensToSolve, 2, "swap (1 token) and (1 +) (inc) PUSH (3 tokens)");
    assert.equal(stats.agents[0].meanLengthRatio, 1.8, "0.5 of the best known answer of a and 3 times that of b: 1.75, shown to one decimal");
    assert.deepEqual([stats.data.sessions, stats.data.promptLines, stats.data.replays, stats.data.puzzles], [3, 5, 1, 2], "the data panel counts the player's own history, replays included");
    assert.equal(stats.data.since, new Date(1_000_000).toISOString());
    assert.equal(create().service.getStatistics().you.played, 0);
    assert.deepEqual(create().service.getStatistics().agents, []);
});

test("the player's data can be shown and erased, and erasing keeps the agents' sessions", async () => {
    const { repository, service } = create({ now: () => 5000 });
    repository.addPuzzle({ id: "a", title: "A", goal: "g", source: "SECRET SOURCE", package: { tags: [], difficulty: 1 } });
    const mine = repository.createSession({ puzzleId: "a", now: 1000 });
    repository.addEvents(mine, [{ type: "setup", time: 1000, duration: 1 }, { type: "evaluate", time: 2000, duration: 1, code: "swap", ok: true }, { type: "evaluate", time: 3000, duration: 1, code: "oops", ok: false }]);
    repository.endSession(mine, "solved", 4000);
    const agent = repository.createSession({ puzzleId: "a", role: "agent", client: "gemma", now: 1500 });
    repository.addEvents(agent, [{ type: "evaluate", time: 1600, duration: 1, code: "swap", ok: true }]);

    const data = service.exportMyData();
    assert.deepEqual(data.sessions.map((s) => [s.puzzle, s.outcome, s.promptLines.map((l) => [l.code, l.ok])]), [["A", "solved", [["swap", true], ["oops", false]]]]);
    assert.equal(data.sessions[0].startedAt, new Date(1000).toISOString());
    assert.doesNotMatch(JSON.stringify(data), /SECRET SOURCE|gemma/, "neither the puzzle's source nor the agents' runs are in the player's data");
    assert.deepEqual(Object.keys(data.sessions[0]).sort(), ["endedAt", "outcome", "promptLines", "puzzle", "startedAt"], "nothing else is kept about a session");

    assert.deepEqual(service.eraseMyHistory(), { sessions: 1, promptLines: 2 });
    assert.deepEqual(service.exportMyData().sessions, []);
    assert.equal(service.getStatistics().you.played, 0);
    assert.equal(service.getStatistics().agents[0].played, 1, "the agent's session stays");
    assert.equal(repository.listPuzzles()[0].played, false, "the puzzle is new again");
    assert.deepEqual(service.eraseMyHistory(), { sessions: 0, promptLines: 0 });
});

test("a new player's profile says so", () => {
    const { service } = create();
    const profile = service.getUserProfile();
    assert.equal(profile.totals.sessions, 0);
    assert.match(profile.note, /new/);
    assert.deepEqual(service.getSessionHistory(), []);
});

test("a waiting request shapes the brief and is answered by the puzzle that follows it", async () => {
    const { repository, service } = create({ now: () => 10_000 });
    const id = repository.createRequest({ preferences: { tags: ["recursion"], change: "harder" }, now: 9000 });
    const brief = service.getBrief({ random: () => 0 });
    assert.deepEqual([brief.requestId, brief.tag, brief.difficulty], [id, "recursion", 1]);
    assert.match(brief.why, /the player is new; the player asked for something harder, but has no earlier puzzle to compare with; the player asked for recursion/);
    assert.equal(service.getBrief({ preferences: {} }).requestId, undefined, "explicit preferences do not use the request");

    const submitted = await service.submitSpec(SAMPLE_SPEC, { client: "c", brief });
    assert.equal(submitted.accepted, true);
    assert.deepEqual([repository.getRequest(id).status, repository.getRequest(id).puzzleId], ["fulfilled", submitted.id]);
    assert.equal(repository.getPuzzle(submitted.id).package.brief.requestId, id);
    assert.equal(service.getBrief().requestId, undefined, "nothing is waiting any more");
    const again = await service.submitSpec(SAMPLE_SPEC, { client: "c", brief });
    assert.equal(again.alreadyExisted, true);

    const old = repository.createRequest({ preferences: {}, now: 10_000 - 31 * 60 * 1000 });
    assert.equal(service.getBrief().requestId, undefined, "a request nobody answered for half an hour is forgotten");
    assert.equal(repository.getRequest(old).status, "pending");
});

test("the guide is complete: its code blocks run, and its spec examples are valid puzzles", async () => {
    const { service } = create();
    const guide = service.getGuide();
    for (const field of ["kind", "tags", "goal", "inputs", "solution", "op", "hints"]) assert.ok(guide.includes(`\`${field}\``), `the guide describes ${field}`);
    assert.doesNotMatch(guide, /;@puzzle|puzzle\.require|snapshot/, "the guide no longer teaches the file format");
    const blocks = [...guide.matchAll(/```bo\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 2);
    for (const block of blocks) {
        let errors = "";
        const bo = await createBo({ onOutput: (t, s) => s === "stderr" && (errors += t) });
        bo.writeFile("examples/puzzles/lib.bo", puzzleFile("lib.bo"));
        for (const line of block.split("\n").filter((l) => l.trim())) {
            bo.debug.load(line);
            bo.debug.run(10_000);
            assert.equal(errors, "", `the guide's line failed: ${line}\n${errors}`);
        }
    }
    const specs = [...guide.matchAll(/```spec\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    assert.equal(specs.length, 3, "three examples");
    assert.deepEqual(specs.map((spec) => spec.kind), ["arrange", "define", "define"]);
    for (const [index, spec] of specs.entries()) {
        const compiled = await compileSpec(spec, { agent: "guide", number: index + 1 });
        assert.deepEqual(compiled.problems, [], `the guide's example ${index + 1} does not compile`);
        assert.deepEqual(compiled.warnings, [], `the guide's example ${index + 1} has warnings`);
        const report = await validatePuzzle(compiled.source);
        assert.equal(report.ok, true, `the guide's example ${index + 1} is not valid:\n${JSON.stringify(report.checks.filter((c) => !c.ok))}`);
    }
});

test("without a topic, a query searches every document and no query lists the topics", () => {
    const { service } = create();
    const topics = service.getReference(undefined);
    assert.match(topics, /^Topics: language \(\d+ KB\), library \(\d+ KB\), primitives \(\d+ KB\), examples \(\d+ KB\)\./);
    const swap = service.getReference(undefined, { query: "swap" });
    assert.match(swap, /^Entries mentioning "swap":/);
    assert.match(swap, /=== library/, "the op is in the library document, which the caller did not need to name");
    assert.match(swap, /\| `swap` \|/);
    assert.ok(swap.length <= REFERENCE_LIMIT + 800);
    assert.match(service.getReference(undefined, { query: "rot" }), /\| `rot` \|/);
    assert.match(service.getReference(undefined, { query: "no-such-word-anywhere" }), /^No document mentions/);
    assert.ok(service.getReference(undefined, { query: "the" }).length <= REFERENCE_LIMIT + 800, "a broad query is capped too");
});

test("the references are the real documents; long ones are searched or outlined, never dumped", () => {
    const { service } = create();
    for (const [topic, path] of Object.entries(REFERENCES)) assert.equal(service.getFullReference(topic), readFileSync(join(root, path), "utf8"));
    assert.throws(() => service.getReference("../../etc/passwd"), /topic must be one of/);
    assert.throws(() => service.getReference("toString"), /topic must be one of/);
    assert.throws(() => service.getFullReference("toString"), /topic must be one of/);

    const language = service.getReference("language");
    assert.equal(language, readFileSync(join(root, REFERENCES.language), "utf8"), "a short document is returned whole");
    for (const topic of ["library", "primitives"]) {
        const outline = service.getReference(topic);
        assert.ok(outline.length < REFERENCE_LIMIT, `${topic}: the outline is small`);
        assert.match(outline, /is long \(\d+ KB\), so here are its sections/);
        assert.match(outline, /^#{1,6} /m);
        assert.match(outline, /with topic "[a-z]+" and a query/);
    }
    const found = service.getReference("library", { query: "foldl" });
    assert.match(found, /entr(y|ies) in the library reference mention "foldl"/);
    assert.match(found, /\| `foldl` \|/);
    assert.match(found, /### List/, "an entry comes with its section heading");
    assert.ok(found.length < REFERENCE_LIMIT + 400);
    assert.match(service.getReference("library", { query: "  FOLDL  " }), /mention "FOLDL"/, "case and padding do not matter");
    assert.match(service.getReference("primitives", { query: "no-such-word-anywhere" }), /No entry in the primitives reference mentions/);
    const broad = service.getReference("library", { query: "the" });
    assert.ok(broad.length <= REFERENCE_LIMIT + 400, "a broad query is capped");
    assert.match(broad, /showing \d+; use a more specific query/);
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
