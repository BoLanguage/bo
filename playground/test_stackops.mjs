// Tests for the quick stack operations: the generated Bo lines are run against the machine.
// Usage: node playground/test_stackops.mjs   (after `make -C c wasm`)
import assert from "node:assert/strict";
import { createBo } from "../wasm/bo.mjs";
import { availableOperations, OPERATIONS, stackOperationCode } from "./stackops.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const items = (bo, name) => bo.stack(name, { maxItems: 50 }).items.map((i) => i[1]);
const fresh = async () => {
    const out = { stderr: "" };
    const bo = await createBo({ onOutput: (text, stream) => stream === "stderr" && (out.stderr += text) });
    return { bo, out };
};

test("the lines are the documented primitives", () => {
    assert.equal(stackOperationCode("", "drop"), "() DROP");
    assert.equal(stackOperationCode("", "clear"), "() CLEAR");
    assert.equal(stackOperationCode("", "dup"), "0 () PICK");
    assert.equal(stackOperationCode("", "swap"), "1 () ROLL");
    assert.equal(stackOperationCode("S", "drop"), "(S) DROP");
    assert.equal(stackOperationCode("S", "clear"), "(S) CLEAR");
    assert.equal(stackOperationCode("S", "dup"), "0 (S) PUSH (S) PICK");
    assert.equal(stackOperationCode("S", "swap"), "1 (S) PUSH (S) ROLL");
    assert.throws(() => stackOperationCode("", "twirl"));
});

test("on the default stack every operation does what its icon says", async () => {
    const { bo, out } = await fresh();
    bo.eval("1 2 3");
    assert.equal(bo.eval(stackOperationCode("", "dup")), true);
    assert.deepEqual(items(bo, ""), ["1", "2", "3", "3"]);
    assert.equal(bo.eval(stackOperationCode("", "swap")), true);
    assert.deepEqual(items(bo, ""), ["1", "2", "3", "3"], "the top two are equal, so nothing visibly changes");
    bo.eval("() CLEAR 1 2 3");
    assert.equal(bo.eval(stackOperationCode("", "swap")), true);
    assert.deepEqual(items(bo, ""), ["1", "3", "2"]);
    assert.equal(bo.eval(stackOperationCode("", "drop")), true);
    assert.deepEqual(items(bo, ""), ["1", "3"]);
    assert.equal(bo.eval(stackOperationCode("", "clear")), true);
    assert.deepEqual(items(bo, ""), []);
    assert.equal(out.stderr, "");
});

test("on a named stack they work too, without leaving anything on the default stack", async () => {
    const { bo, out } = await fresh();
    bo.eval("1 (S) PUSH 2 (S) PUSH 3 (S) PUSH 99");
    for (const [op, expected] of [["dup", ["1", "2", "3", "3"]], ["swap", ["1", "2", "3", "3"]], ["drop", ["1", "2", "3"]]]) {
        assert.equal(bo.eval(stackOperationCode("S", op)), true, op);
        assert.deepEqual(items(bo, "S"), expected, op);
        assert.deepEqual(items(bo, ""), ["99"], `${op} leaves the default stack alone`);
    }
    bo.eval(stackOperationCode("S", "swap"));
    assert.deepEqual(items(bo, "S"), ["1", "3", "2"]);
    bo.eval(stackOperationCode("S", "clear"));
    assert.deepEqual(items(bo, "S"), []);
    assert.deepEqual(items(bo, ""), ["99"]);
    assert.equal(out.stderr, "");
});

test("an operation on an empty stack fails with the machine's own error", async () => {
    const { bo, out } = await fresh();
    assert.equal(bo.eval(stackOperationCode("", "drop")), false);
    assert.match(out.stderr, /Stack-Error/);
});

test("operations are offered according to the stack's depth", () => {
    const stack = (depth, extra = {}) => ({ name: "S", origin: "user", depth, locked: false, ...extra });
    const enabled = (s) => Object.fromEntries(availableOperations(s).map((o) => [o.op, o.enabled]));
    assert.deepEqual(enabled(stack(0)), { dup: false, swap: false, drop: false, clear: false });
    assert.deepEqual(enabled(stack(1)), { dup: true, swap: false, drop: true, clear: true });
    assert.deepEqual(enabled(stack(2)), { dup: true, swap: true, drop: true, clear: true });
    assert.deepEqual(availableOperations(stack(2)).map((o) => o.op), OPERATIONS);
    assert.deepEqual(enabled(stack(5, { locked: true })), { dup: false, swap: false, drop: false, clear: false });
    assert.match(availableOperations(stack(5, { locked: true }))[0].title, /locked/);
});

test("a library stack the program changed only offers dropping what the program added", () => {
    const shadow = (depth) => ({ name: "map", origin: "shadows", depth, baseDepth: 1, locked: false });
    assert.deepEqual(availableOperations(shadow(2)).map((o) => [o.op, o.enabled]), [["drop", true]]);
    assert.deepEqual(availableOperations(shadow(1)).map((o) => [o.op, o.enabled]), [["drop", false]]);
});

test("the default stack is offered everything it can do", async () => {
    const { bo } = await fresh();
    bo.eval("1 2");
    const main = bo.state().stacks[0];
    assert.deepEqual(availableOperations(main).map((o) => o.enabled), [true, true, true, true]);
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
