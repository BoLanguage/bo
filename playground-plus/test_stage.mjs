// Tests for the step player, against a fake page and a virtual clock (nothing really waits).
// Usage: node playground-plus/test_stage.mjs
import assert from "node:assert/strict";
import { createStepPlayer, shownGap, TYPING_MS } from "./client/stage.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A virtual clock, and a page that writes down what it is asked to do, and when. */
function world({ onSleep = () => {} } = {}) {
    const w = { t: 0, log: [], submits: [] };
    w.clock = () => w.t;
    w.sleep = async (ms) => {
        w.t += ms;
        onSleep(w);
    };
    w.page = {
        setPrompt: (text) => w.log.push(`prompt:${text}`),
        submit: async (code) => {
            w.log.push(`submit:${code}`);
            w.submits.push(w.t);
            return true;
        },
    };
    return w;
}
const player = (w, options = {}) => createStepPlayer({ page: w.page, sleep: w.sleep, clock: w.clock, ...options });
const STEPS = [{ kind: "run", code: "1", at: 1000 }, { kind: "run", code: "2", at: 3000 }, { kind: "guess", code: "guess", at: 10_000 }];

test("the gap to show: as it was, shortened, or a tenth of it", () => {
    assert.deepEqual([shownGap(90_000, "real"), shownGap(90_000, "compressed"), shownGap(1500, "compressed"), shownGap(90_000, "fast"), shownGap(2000, "fast")], [90_000, 4000, 1500, 600, 200]);
});

test("at real time each line is run when it was run, the typing being part of the wait", async () => {
    const w = world();
    const p = player(w, { speed: "real" });
    p.push(STEPS);
    await p.idle();
    assert.deepEqual(w.submits, [1000, 3000, 10_000]);
    assert.deepEqual(w.log.filter((l) => l.startsWith("prompt:")), ["prompt:1", "prompt:2", "prompt:guess"]);
});

test("compressed, a long wait is cut", async () => {
    const w = world();
    const p = player(w, { speed: "compressed" });
    p.push(STEPS);
    await p.idle();
    assert.deepEqual(w.submits, [1000, 3000, 7000], "1 s and 2 s as they were, 7 s cut to 4 s");
});

test("fast is quick whatever the gaps", async () => {
    const w = world();
    const p = player(w, { speed: "fast" });
    p.push(STEPS);
    await p.idle();
    assert.ok(w.t < 2500, `took ${w.t} ms`);
    assert.equal(w.submits.length, 3);
});

test("the speed can be changed while a long wait is going on", async () => {
    let changed = false;
    const w = world({ onSleep: (world_) => { if (world_.t >= 1000 && !changed) { changed = true; p.setSpeed("fast"); } } });
    const p = player(w, { speed: "real" });
    p.push([{ kind: "run", code: "late", at: 120_000 }]);
    await p.idle();
    assert.ok(w.t < 3000, `ended at ${w.t} ms instead of 120000`);
    assert.equal(w.submits.length, 1);
    p.setSpeed("nonsense");
});

test("a live run is not waited for: lines are typed and run as they arrive, the other steps only reported", async () => {
    const w = world();
    const seen = [];
    const p = player(w, { onStep: (s) => seen.push(s.kind) });
    p.push([{ kind: "say", text: "hmm", at: 900_000 }, { kind: "run", code: "-rot", at: 901_000 }, { kind: "lookup", code: "rot", at: 950_000 }, { kind: "guess", code: "guess", at: 990_000 }], { live: true });
    await p.idle();
    assert.deepEqual(seen, ["say", "run", "lookup", "guess"]);
    assert.equal(w.t, 2 * TYPING_MS, "only the typing took time");
});

test("steps brought up to date are played at once, without typing", async () => {
    const w = world();
    const p = player(w);
    p.push(STEPS, { instant: true });
    await p.idle();
    assert.equal(w.t, 0);
    assert.deepEqual(w.log, ["submit:1", "submit:2", "submit:guess"]);
});

test("steps that arrive while it plays are played after the ones before", async () => {
    const w = world();
    const p = player(w);
    p.push([{ kind: "run", code: "1" }], { live: true });
    p.push([{ kind: "run", code: "2" }], { live: true });
    p.push([{ kind: "run", code: "3" }], { live: true });
    await p.idle();
    assert.deepEqual(w.log.filter((l) => l.startsWith("submit:")), ["submit:1", "submit:2", "submit:3"]);
});

test("a line that never finished on the server is announced but not run here", async () => {
    const w = world();
    const seen = [];
    const p = player(w, { onStep: (s) => seen.push([s.code, s.skipped ?? false]) });
    p.push([{ kind: "run", code: "(a) (a) PUSH a", error: "That line did not finish within 200000 steps (an endless loop?) and was stopped." }, { kind: "run", code: "1" }], { live: true });
    await p.idle();
    assert.deepEqual(seen, [["(a) (a) PUSH a", true], ["1", false]]);
    assert.deepEqual(w.log, ["prompt:1", "submit:1"]);
});

test("stopping ends it at once: what is queued is dropped, and a line being typed is not run", async () => {
    const w = world({ onSleep: () => { if (w.t >= TYPING_MS) p.stop(); } });
    const p = player(w);
    p.push([{ kind: "run", code: "1" }, { kind: "run", code: "2" }], { live: true });
    await p.idle();
    assert.equal(p.stopped, true);
    assert.deepEqual(w.log, ["prompt:1", "prompt:"], "the prompt was emptied and nothing was run");
    p.push([{ kind: "run", code: "3" }], { live: true });
    await p.idle();
    assert.ok(!w.log.includes("submit:3"));
});

test("idle resolves at once when nothing is queued", async () => {
    await player(world()).idle();
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
