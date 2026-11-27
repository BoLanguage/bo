// Views of the playground: plain functions from store state to DOM nodes. They hold no state
// and call back only through the `actions` they are given, so each one can become a component
// of a UI framework later without changing its inputs.
import { availableOperations } from "./stackops.mjs";

/** Creates an element: `h("div", {class: "x", onClick: fn}, child, "text", [more])`. */
export function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(props ?? {})) {
        if (value == null || value === false) continue;
        if (name === "class") element.className = value;
        else if (name.startsWith("on")) element.addEventListener(name.slice(2).toLowerCase(), value);
        else if (value === true) element.setAttribute(name, "");
        else element.setAttribute(name, value);
    }
    appendAll(element, children);
    return element;
}

function appendAll(element, children) {
    for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

/** Splits paired backtick code spans without interpreting any other markup. */
export function inlineCodeParts(text) {
    const parts = [];
    const code = /`([^`]*)`/g;
    let end = 0;
    for (let match; (match = code.exec(text));) {
        if (match.index > end) parts.push({ text: text.slice(end, match.index), code: false });
        parts.push({ text: match[1], code: true });
        end = code.lastIndex;
    }
    if (end < text.length) parts.push({ text: text.slice(end), code: false });
    return parts.length ? parts : [{ text, code: false }];
}

function inlineCode(text) {
    return inlineCodeParts(text).map((part) => part.code ? h("code", {}, part.text) : part.text);
}

const ORIGIN_TITLES = {
    default: "the default stack",
    user: "defined by the program",
    shadows: "a library op the program redefined",
    library: "defined by the standard library",
    kernel: "a kernel primitive",
    empty: "empty",
};

export function originBadge(origin) {
    return h("span", { class: `badge origin-${origin}`, title: ORIGIN_TITLES[origin] ?? origin }, origin);
}

function lockBadge() {
    return h("span", { class: "badge locked", title: "This stack cannot be changed until it is unlocked" }, "locked");
}

/** The top-level items of a rendered list, e.g. "(a (b c) d)" gives ["a", "(b c)", "d"]. */
export function splitItems(text) {
    const inner = text.startsWith("(") ? text.slice(1, text.endsWith(")") ? -1 : undefined) : text;
    const items = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i <= inner.length; i++) {
        const c = inner[i];
        const space = c === undefined || (depth === 0 && /\s/.test(c));
        if (space) {
            if (start >= 0) items.push(inner.slice(start, i));
            start = -1;
            continue;
        }
        if (start < 0) start = i;
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
    }
    return items;
}

/** A list of printable character codes, such as "(72 105)", read as text: "Hi". */
export function textHint(kind, text) {
    if (kind !== "l") return null;
    const codes = splitItems(text);
    if (codes.length < 2 || !codes.every((c) => /^\d{2,3}$/.test(c))) return null;
    const chars = codes.map(Number);
    return chars.every((c) => c >= 32 && c < 127) ? `"${String.fromCharCode(...chars)}"` : null;
}

// Icons are fixed markup (never built from data); they draw with the current text colour.
const ICONS = {
    dup: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    swap: '<path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4"/>',
    drop: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    clear: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    idea: '<path d="M9 18h6M10 22h4M8.2 14.5A7 7 0 1 1 15.8 14.5c-1.1.8-1.8 2-1.8 3.5h-4c0-1.5-.7-2.7-1.8-3.5z"/>',
};

export function icon(name) {
    const span = document.createElement("span");
    span.className = "icon-svg";
    span.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
}

/**
 * The quick operations of a stack, shown when the pointer is over it (always on touch screens).
 * `tools` is `{onOperation(stackName, op), disabled}`; without it no icons are drawn.
 */
function stackTools(stack, tools) {
    if (!tools) return null;
    return h("div", { class: "tools", role: "toolbar", "aria-label": `Operations on ${stack.name || "the default stack"}` },
        availableOperations(stack).map(({ op, enabled, title }) =>
            h("button", { class: `tool tool-${op}`, type: "button", title, "aria-label": title,
                          disabled: !enabled || tools.disabled, onClick: () => tools.onOperation(stack.name, op) }, icon(op))));
}

function item([kind, text], fresh) {
    const hint = textHint(kind, text);
    return h("li", { class: `item kind-${kind}${fresh ? " fresh" : ""}`, title: hint ? `${text}  =  ${hint}` : text },
        h("span", { class: "text" }, text),
        hint && h("span", { class: "hint" }, hint));
}

/** How many leading items of `stack` are unchanged from `before`; the rest are new. */
function unchanged(stack, before) {
    if (!before || before.hidden !== stack.hidden) return stack.items.length;
    let i = 0;
    while (i < stack.items.length && i < before.items.length &&
           stack.items[i][0] === before.items[i][0] && stack.items[i][1] === before.items[i][1]) i++;
    return i;
}

/** One stack as a column, its top first; items that are new since the previous state are marked. */
export function stackColumn(stack, before, tools) {
    const same = unchanged(stack, before);
    const delta = before ? stack.depth - before.depth : 0;
    const top = [...stack.items].map((entry, index) => item(entry, index >= same)).reverse();
    return h("section", { class: `stack origin-${stack.origin}${stack.locked ? " is-locked" : ""}`, "data-name": stack.name },
        h("header", {},
            h("h3", {}, stack.name === "" ? "default" : stack.name),
            stack.origin === "shadows" && originBadge("shadows"),
            stack.locked && lockBadge(),
            h("span", { class: "depth", title: "number of items" },
                stack.depth, delta ? h("span", { class: delta > 0 ? "up" : "down" }, delta > 0 ? ` +${delta}` : ` ${delta}`) : null),
            stackTools(stack, tools)),
        stack.items.length === 0 ? h("p", { class: "empty" }, "empty") : h("ul", {}, top),
        stack.hidden > 0 && h("p", { class: "more" }, `${stack.hidden} deeper items not shown`));
}

/**
 * The default stack as a full-width strip: items run left to right from the top to the bottom of
 * the stack, like the top-first columns of the other stacks, so a new item appears on the left.
 */
export function defaultStackRow(stack, before, tools) {
    const same = unchanged(stack, before);
    const delta = before ? stack.depth - before.depth : 0;
    const chips = stack.items.map((entry, index) => {
        const [kind, text] = entry;
        const hint = textHint(kind, text);
        const isTop = index === stack.items.length - 1;
        return h("li", { class: `chip kind-${kind}${index >= same ? " fresh" : ""}${isTop ? " top" : ""}`,
                         title: hint ? `${text}  =  ${hint}` : text },
            h("span", { class: "text" }, text), hint && h("span", { class: "hint" }, hint));
    }).reverse();
    return h("section", { class: `stack origin-default wide${stack.locked ? " is-locked" : ""}`, "data-name": "" },
        h("header", {},
            h("h3", {}, "default stack"),
            stack.locked && lockBadge(),
            h("span", { class: "depth", title: "number of items" },
                `${stack.depth} ${stack.depth === 1 ? "item" : "items"}`,
                delta ? h("span", { class: delta > 0 ? "up" : "down" }, delta > 0 ? ` +${delta}` : ` ${delta}`) : null),
            h("span", { class: "orientation", title: "top on the left, bottom on the right" }, "top \u2192 bottom"),
            stackTools(stack, tools)),
        stack.items.length === 0 ? h("p", { class: "empty" }, "empty") : h("ol", { class: "strip" },
            chips, stack.hidden > 0 && h("li", { class: "chip more" }, `\u2026 ${stack.hidden} deeper`)));
}

/**
 * The default stack on a row of its own, then the program's stacks as columns. The page decides
 * when to show it: it appears once something is on a stack and stays (empty) after that.
 */
export function visibleStacks(stacks, hiddenNames = [], hiddenPrefixes = []) {
    const hidden = new Set(hiddenNames);
    return stacks.filter((stack) => stack.name === "" ||
        (!hidden.has(stack.name) && !hiddenPrefixes.some((prefix) => stack.name.startsWith(prefix))));
}

export function stacksPanel(machine, previous, tools, hiddenNames, hiddenPrefixes) {
    if (!machine) return null;
    const stacks = visibleStacks(machine.stacks, hiddenNames, hiddenPrefixes);
    const before = new Map(visibleStacks(previous?.stacks ?? [], hiddenNames, hiddenPrefixes).map((s) => [s.name, s]));
    const hidden = machine.stacks.length - stacks.length;
    const [main, ...others] = stacks;
    return h("div", { class: "stacks" },
        defaultStackRow(main, before.get(main.name), tools),
        others.length > 0 && h("div", { class: "columns" }, others.map((s) => stackColumn(s, before.get(s.name), tools))),
        machine.counts && counts({ ...machine.counts, hidden }));
}

function counts({ library, kernel, empty, hidden = 0 }) {
    const parts = [`${library} library stacks`, `${kernel} kernel primitives`, `${empty} empty`];
    if (hidden) parts.push(`${hidden} hidden`);
    const title = hidden
        ? "Library and kernel stacks can be opened below; some stacks are intentionally hidden"
        : "Hidden by default; open the list below to look at them";
    return h("p", { class: "counts", title },
        `Not shown: ${parts.join(", ")}`);
}

/** What is about to run, or why nothing is. */
export function nextPanel({ status, machine, fast }) {
    const next = machine?.next;
    if (status === "paused" && next) {
        return h("div", { class: "next" },
            h("code", { class: "op" }, next.op),
            next.literal
                ? h("span", { class: "badge", title: `a ${next.literal} that the next step pushes` }, next.literal)
                : originBadge(next.origin),
            next.native && h("span", { class: "detail" }, "primitive ", h("code", {}, next.native)),
            next.definition && h("span", { class: "detail" }, "defined as ", h("code", {}, next.definition)),
            !next.native && !next.definition && !next.literal && h("span", { class: "detail error" }, "not defined"));
    }
    const text = {
        idle: "No program loaded. Press Step or Run.",
        ready: "Loaded. Press Step.",
        paused: machine?.breakpoint ? "Paused at a breakpoint." : "Paused.",
        done: fast ? "Finished in fast mode (it was not stepped)." : `Finished after ${machine?.steps ?? 0} steps.`,
        error: `Stopped by an error on line ${fast?.line || machine?.line || "?"}. See the output.`,
        exit: `The program exited with status ${machine?.exitCode}.`,
    }[status] ?? status;
    return h("div", { class: `next ${status}` }, h("span", { class: "detail" }, text));
}

/**
 * What the prompt asks for. While a program is paused it says what the next step runs and what the
 * prompt is for (it works at the pause point); `idle` is the text for everything else.
 */
export function promptPlaceholder({ status, machine }, idle) {
    if (status === "ready") return "Program loaded \u00b7 Type step, next, continue or stop, or any Bo to run here";
    if (status !== "paused") return idle;
    const op = machine?.next?.op;
    const item = op && (op.length > 24 ? `${op.slice(0, 23)}\u2026` : op);
    return `Paused${item ? ` before ${item}` : ""} \u00b7 Type step, next, continue or stop, or any Bo to run here`;
}

/** Nested programs being run, innermost first, with the position of the next op. */
export function framesPanel(machine) {
    const frames = machine?.frames ?? [];
    if (!frames.length) return h("p", { class: "empty" }, "No program is running.");
    return h("ol", { class: "frames" }, [...frames].reverse().map((frame, index) => {
        const innermost = index === 0;
        const body = frame.kind === "code" ? splitItems(frame.list).map((token, at) =>
            h("span", { class: `token${at === frame.pos ? (innermost ? " current" : " resume") : ""}` }, token, " "))
            : frame.list ?? "";
        return h("li", { class: `frame kind-${frame.kind}${innermost ? " innermost" : ""}` },
            h("span", { class: "kind", title: frame.kind === "code" ? "a list being executed" : "pending control structure" },
                frame.kind === "code" ? (innermost && frames.length === 1 ? "program" : "call") : frame.kind),
            h("span", { class: "tokens" }, body));
    }));
}

/** The program's output (errors in a second colour), or null when there is none. */
export function outputPanel(output) {
    if (!output.length) return null;
    return h("pre", { class: "output" }, output.map(({ stream, text }) => h("span", { class: stream }, text)));
}

/** The footer text about a puzzle's hints: how many there are, how many were used, and which cost nothing. */
export function hintSummary(hints, freeHints = 0, used = 0) {
    if (hints <= 0) return "no hints available";
    const details = [];
    if (used > 0) details.push(`${Math.min(used, hints)} used`);
    if (freeHints > 0) details.push(hints === 1 ? "free" : freeHints === 1 ? "the first is free" : `the first ${freeHints} are free`);
    return `${hints} ${hints === 1 ? "hint" : "hints"} available${details.length ? ` (${details.join("; ")})` : ""}`;
}

/** A safe, styled puzzle goal supplied by the playground's level metadata. */
export function puzzleGoalPanel(title, goal, description, hints, freeHints = 0, hintsUsed = 0) {
    if (!goal) return null;
    const hasHints = hints > 0;
    return h("div", { class: "puzzle-goal", role: "note" },
        h("div", { class: "puzzle-emblem" },
            h("span", { class: "puzzle-emblem-image", "aria-hidden": "true" })),
        h("div", { class: "puzzle-content" },
            h("header", {},
                h("span", { class: "puzzle-title" }, title),
                " | ",
                h("span", { class: "puzzle-title-goal" }, inlineCode(goal))),
            h("div", { class: "body" },
                description && h("p", { class: "description" }, inlineCode(description))),
            h("footer", {},
                hintSummary(hints, freeHints, hintsUsed),
                h("span", {
                    class: `hint-icon${hasHints ? " available" : ""}`,
                    title: hasHints ? "Use hint at the prompt if you need help." : null,
                    "aria-label": hasHints ? "Use hint at the prompt if you need help." : null,
                }, icon("idea")))));
}

/**
 * The line under the prompt: what the prompt last evaluated, or, for a program in the editor,
 * the source line being executed (`programLines` are the lines of the loaded program).
 */
export function echoPanel({ source, echo, status, machine, fast }, programLines) {
    if (source === "prompt") return echo ? h("div", {}, h("span", { class: "mark" }, "\u203a"), echo) : null;
    if (!machine || status === "idle") return null;
    if (status === "ready") return h("span", { class: "note" }, "Program loaded. Use Step or Run in the editor.");
    if (fast && !fast.line) return h("span", { class: "note" }, "Ran in fast mode (not stepped).");
    const line = fast ? fast.line : machine.line;
    const text = (programLines?.[line - 1] ?? "").trim();
    return h("div", {}, h("span", { class: "line-no", title: "line being executed" }, line),
        text || h("span", { class: "note" }, "(empty line)"));
}

/** Library and kernel stacks matching the filter, each expandable to its items. */
export function libraryResults(library, actions) {
    if (!library.open) return null;
    if (!library.stacks.length) return h("p", { class: "empty" }, "No stack matches.");
    return h("ul", { class: "library" },
        library.stacks.map((s) => {
            const detail = library.details[s.name];
            return h("li", { class: `entry origin-${s.origin}${detail ? " open" : ""}` },
                h("button", { class: "name", onClick: () => actions.toggleStackDetails(s.name), "aria-expanded": detail ? "true" : "false" },
                    s.name, originBadge(s.origin), h("span", { class: "depth" }, s.depth)),
                detail && (detail.items.length
                    ? h("ul", { class: "definition" }, [...detail.items].reverse().map((entry) => item(entry, false)))
                    : h("p", { class: "empty" }, s.origin === "kernel" ? "implemented by the runtime" : "empty")));
        }),
        library.total > library.stacks.length && h("li", { class: "more" }, `${library.total - library.stacks.length} more; narrow the search`));
}
