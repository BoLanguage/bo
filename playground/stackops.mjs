// The quick operations offered on a stack (the icons that appear when the pointer is over it).
// Each one is turned into a line of Bo, which the page shows under the prompt and evaluates like
// anything typed there, so the icons double as a way to learn the ops.
//
// PICK and ROLL read their index from the selected stack itself, so on a named stack
// the index is pushed onto it first; on the default stack it is simply written before `()`.

export const OPERATIONS = ["dup", "swap", "drop", "clear"];

const LABELS = {
    dup: { name: "Duplicate the top", op: "PICK" },
    swap: { name: "Swap the top two", op: "ROLL" },
    drop: { name: "Drop the top", op: "DROP" },
    clear: { name: "Empty the stack", op: "CLEAR" },
};

/** The Bo line for operation `op` on the stack named `name` ("" is the default stack). */
export function stackOperationCode(name, op) {
    const selector = name === "" ? "()" : `(${name})`;
    const withIndex = (index, stackOp) => name === ""
        ? `${index} () ${stackOp}`
        : `${index} ${selector} PUSH ${selector} ${stackOp}`;
    switch (op) {
        case "dup": return withIndex(0, "PICK");
        case "swap": return withIndex(1, "ROLL");
        case "drop": return `${selector} DROP`;
        case "clear": return `${selector} CLEAR`;
        default: throw new Error(`unknown stack operation: ${op}`);
    }
}

/**
 * The operations to offer for a stack of the machine's state, each enabled or not, with a title.
 * A locked stack accepts none. A library stack the program changed (origin "shadows") only
 * offers Drop, and only for what the program added: emptying it would remove the library op.
 */
export function availableOperations(stack) {
    return OPERATIONS.map((op) => {
        const { name, op: stackOp } = LABELS[op];
        let reason = "";
        if (stack.locked) reason = "the stack is locked";
        else if (stack.origin === "shadows" && op !== "drop") reason = "this would change the library's own definition";
        else if (stack.origin === "shadows" && stack.depth <= (stack.baseDepth ?? 0)) reason = "nothing the program added";
        else if (op === "swap" ? stack.depth < 2 : stack.depth < 1) reason = op === "swap" ? "needs two items" : "the stack is empty";
        const undo = stack.origin === "shadows" ? " (undoes the program's last redefinition)" : "";
        return { op, enabled: reason === "", title: reason ? `${name}: ${reason}` : `${name}${undo} (${stackOp})` };
    }).filter(({ op }) => stack.origin !== "shadows" || op === "drop");
}
