// Tests for the onboarding state, its steps and the arrow geometry (no DOM needed).
// Usage: node playground/test_onboarding.mjs
import assert from "node:assert/strict";
import { ARROW, arrowPlacement, arrowRect, cardPlacement, union } from "./arrow.mjs";
import { createOnboarding, describeStep, EXPRESSION, STEP_COUNT } from "./onboarding.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const rect = (left, top, width, height) => ({ left, top, width, height });

test("an idle visitor is invited, and the guide advances, finishes and replays", () => {
    const tour = createOnboarding();
    assert.equal(tour.getState().phase, "waiting");
    tour.invite();
    assert.equal(tour.getState().phase, "invited");
    tour.start();
    assert.deepEqual([tour.getState().phase, tour.getState().step], ["active", 0]);
    for (let step = 1; step < STEP_COUNT; step++) {
        tour.next();
        assert.equal(tour.getState().step, step);
    }
    assert.equal(tour.getState().last, true);
    tour.next();
    assert.equal(tour.getState().phase, "hidden");
    tour.start();
    assert.equal(tour.getState().step, 0, "starting again replays from the beginning");
});

test("something the visitor does withdraws the invitation but never interrupts a guide", () => {
    const early = createOnboarding();
    early.activity();
    early.invite();
    assert.equal(early.getState().phase, "hidden", "an early action prevents a later invitation");

    const invited = createOnboarding();
    invited.invite();
    invited.activity();
    assert.equal(invited.getState().phase, "hidden");

    const running = createOnboarding();
    running.start();
    running.activity();
    assert.equal(running.getState().phase, "active");
    running.dismiss();
    assert.equal(running.getState().phase, "hidden");
});

test("every step names a target, a title and a body", () => {
    for (let step = 0; step < STEP_COUNT; step++) {
        const described = describeStep(step);
        assert.match(described.target, /^[#.]/, `step ${step}`);
        assert.ok(described.title && described.body, `step ${step}`);
    }
});

test("the first step offers to fill the prompt, and stops offering once something ran", () => {
    assert.deepEqual(describeStep(0).helper, { label: `Put ${EXPRESSION} in the prompt`, action: "fill" });
    assert.equal(describeStep(0, { stackItems: 1 }).helper, null);
    assert.equal(describeStep(0, { puzzleActive: true }).helper, null, "never during a puzzle");
});

test("the stack step has no arrow until the stack has something, then points below it", () => {
    const empty = describeStep(1);
    assert.equal(empty.target, "#repl");
    assert.equal(empty.arrow, null);
    assert.deepEqual(empty.helper, { label: `Run ${EXPRESSION} for me`, action: "run" });
    assert.match(empty.body, /empty/);
    assert.equal(describeStep(1, { stackVisible: true }).arrow, null, "a shown but empty stack has none either");
    const filled = describeStep(1, { stackItems: 2, stackVisible: true });
    assert.equal(filled.target, "#stacks .stack.wide");
    assert.equal(filled.arrow.side, "bottom");
    assert.equal(filled.helper, null);
    assert.equal(describeStep(1, { puzzleActive: true }).helper, null);
});

test("the editor step points at the tab when the editor is closed and at the Next panel when it is open", () => {
    assert.equal(describeStep(2, { editorOpen: false }).target, "#editor-toggle");
    assert.equal(describeStep(2, { editorOpen: true }).target, "#next");
    assert.equal(describeStep(2, { editorOpen: true }).arrow.side, "right");
});

test("each step's arrow stands where the guide says", () => {
    assert.equal(describeStep(0).arrow.side, "right", "beside the send button");
    assert.equal(describeStep(3).arrow.side, "bottom", "below the picker");
    assert.equal(describeStep(4).arrow.side, "left", "beside the + button");
    for (let step = 0; step < STEP_COUNT; step++) {
        const { arrow } = describeStep(step, { stackItems: 1, stackVisible: true });
        assert.ok(arrow && ["left", "right", "top", "bottom"].includes(arrow.side), `step ${step}`);
    }
});

test("back goes to the step before, and stops at the first", () => {
    const tour = createOnboarding();
    tour.back();
    assert.equal(tour.getState().phase, "waiting", "nothing to go back in before the guide starts");
    tour.start();
    tour.back();
    assert.equal(tour.getState().step, 0);
    tour.next();
    tour.next();
    tour.back();
    assert.equal(tour.getState().step, 1);
    tour.dismiss();
    tour.back();
    assert.equal(tour.getState().phase, "hidden");
});

test("an arrow stands beside its target and points at it", () => {
    const view = { width: 1000, height: 800 };
    const target = rect(300, 400, 400, 50);
    const right = arrowPlacement(target, "right", view);
    assert.deepEqual([right.rotate, right.y], [0, 425], "on the right it points left, level with the target's middle");
    assert.ok(right.x - ARROW.length / 2 >= 700, "and clear of the target's edge");
    const left = arrowPlacement(target, "left", view);
    assert.equal(left.rotate, 180, "on the left it points right");
    assert.ok(left.x + ARROW.length / 2 <= 300);
    const below = arrowPlacement(target, "bottom", view);
    assert.equal(below.rotate, 90, "below it points up");
    assert.equal(below.x, 500);
    assert.ok(below.y - ARROW.length / 2 >= 450);
    assert.equal(arrowPlacement(target, "top", view).rotate, 270, "above it points down");
});

test("an arrow can stand along its side, and is not drawn where it would not fit", () => {
    const view = { width: 1000, height: 800 };
    assert.equal(arrowPlacement(rect(300, 400, 400, 50), "bottom", view, { along: 0.8 }).x, 620);
    assert.equal(arrowPlacement(rect(300, 400, 690, 50), "right", view), null, "no room on the right");
    assert.equal(arrowPlacement(rect(20, 400, 100, 50), "left", view), null, "no room on the left");
    assert.equal(arrowPlacement(rect(300, 400, 100, 50), "diagonal", view), null, "not a side");
});

test("the rectangle of an arrow is as wide as it is long when it is horizontal", () => {
    const horizontal = arrowRect({ x: 100, y: 100, rotate: 0 });
    const vertical = arrowRect({ x: 100, y: 100, rotate: 90 });
    assert.deepEqual([horizontal.width, horizontal.height], [ARROW.length, ARROW.thickness]);
    assert.deepEqual([vertical.width, vertical.height], [ARROW.thickness, ARROW.length]);
    assert.deepEqual(union(rect(0, 0, 10, 10), rect(20, 5, 10, 10)), rect(0, 0, 30, 15));
});

test("the card keeps clear of its target: at the bottom unless the target is low and in the card's column", () => {
    const card = rect(300, 600, 400, 120);
    assert.equal(cardPlacement(rect(0, 100, 50, 40), 800, card), "bottom");
    assert.equal(cardPlacement(rect(350, 650, 50, 40), 800, card), "top", "low and above the card's column");
    assert.equal(cardPlacement(rect(0, 650, 200, 40), 800, card), "bottom", "low but beside the card");
    assert.equal(cardPlacement(rect(0, 600, 50, 40), 800), "top", "without a card, only the height counts");
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`FAIL ${name}\n${error.stack.split("\n").slice(0, 6).join("\n")}`);
    }
}
process.exit(failed ? 1 : 0);
