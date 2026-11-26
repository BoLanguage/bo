// A small modal dialog for Playground+, built on the native <dialog> element (which provides the
// backdrop, the focus trap, Esc to cancel and the accessibility semantics). It is generic: a title,
// a body (text or a DOM node, so it can hold a form), and any number of buttons. It resolves to the
// value of the button chosen, or to `cancelValue` if the user dismisses it with Esc or by clicking
// outside. Its look follows the playground's colour variables, so it matches both themes.

const STYLE_ID = "plus-dialog-style";
const STYLE = `
dialog.plus-dialog.wide { max-width: min(50rem, calc(100vw - 2rem)); width: 100%; }
.plus-dialog.wide .plus-dialog-body { max-height: 68vh; overflow: auto; padding-right: 0.3rem; }
dialog.plus-dialog { max-width: min(32rem, calc(100vw - 2rem)); padding: 1.25rem 1.4rem; border: 1px solid var(--border, #d9dde5);
    border-radius: 12px; background: var(--panel, #fff); color: var(--text, #1d2330); box-shadow: var(--shadow, 0 8px 30px rgba(0, 0, 0, 0.2)); }
dialog.plus-dialog::backdrop { background: rgba(10, 15, 30, 0.45); }
.plus-dialog h2 { margin: 0 0 0.6rem; font-size: 1.1rem; }
.plus-dialog .plus-dialog-body { margin: 0 0 1.1rem; line-height: 1.45; }
.plus-dialog .plus-dialog-buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }
.plus-dialog button { font: inherit; padding: 0.45rem 0.9rem; border-radius: 8px; border: 1px solid var(--border, #d9dde5); background: var(--bg, #f6f7f9); color: inherit; cursor: pointer; }
.plus-dialog button:hover { background: var(--hover, rgba(20, 30, 60, 0.07)); }
.plus-dialog button:focus-visible { outline: 2px solid var(--accent, #3b6fd4); outline-offset: 2px; }
.plus-dialog button.primary { background: var(--accent, #3b6fd4); border-color: var(--accent, #3b6fd4); color: var(--accent-text, #fff); }
.plus-dialog button.danger { color: var(--danger, #b3261e); border-color: var(--danger, #b3261e); }
`;

/**
 * @param {{
 *   title: string,
 *   body?: string | Node,
 *   buttons: {label: string, value: *, kind?: "primary" | "danger" | "plain"}[],
 *   cancelValue?: *,
 *   focusValue?: *,
 *   doc?: Document,
 *   controller?: {close?: (value: *) => void},
 * }} options `focusValue` is the value of the button that starts focused (the first one by default);
 *   `controller` is an object that gets a `close(value)` method, so that code can dismiss the dialog itself;
 *   `wide` makes it wide with a scrolling body, `width` (a CSS length) sets how wide it may grow instead
 * @returns {Promise<*>}
 */
export function showDialog({ title, body = "", buttons, cancelValue = undefined, focusValue, doc = document, controller = null, wide = false, width = null }) {
    if (!buttons?.length) throw new Error("a dialog needs at least one button");
    if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = STYLE;
        doc.head.append(style);
    }

    return new Promise((resolve) => {
        const dialog = doc.createElement("dialog");
        dialog.className = wide ? "plus-dialog wide" : "plus-dialog";
        if (width) {
            dialog.style.maxWidth = `min(${width}, calc(100vw - 2rem))`;
            dialog.style.width = "100%";
        }
        const titleId = `plus-dialog-${Math.random().toString(36).slice(2)}`;
        dialog.setAttribute("aria-labelledby", titleId);

        const heading = doc.createElement("h2");
        heading.id = titleId;
        heading.textContent = title;
        const content = doc.createElement("div");
        content.className = "plus-dialog-body";
        content.append(body); // text is inserted as text, never as markup
        const row = doc.createElement("div");
        row.className = "plus-dialog-buttons";

        let answer = cancelValue;
        let focus = null;
        // The dialog is finished by whoever closes it first, not only by the browser's `close` event (which
        // a page in a background tab may delay), so the promise always settles.
        let finished = false;
        const finish = (value = answer) => {
            answer = value;
            if (dialog.open) dialog.close();
            if (finished) return;
            finished = true;
            dialog.remove();
            resolve(answer);
        };
        for (const { label, value, kind = "plain" } of buttons) {
            const button = doc.createElement("button");
            button.type = "button";
            button.textContent = label;
            if (kind !== "plain") button.classList.add(kind);
            button.addEventListener("click", () => finish(value));
            row.append(button);
            if (focus === null || (focusValue !== undefined && value === focusValue)) focus = button;
        }
        // Esc is handled here instead of being left to the browser, so it behaves the same everywhere
        dialog.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            finish();
        });
        // clicking the backdrop (the dialog element itself, outside its content box) dismisses it
        dialog.addEventListener("click", (event) => {
            if (event.target !== dialog) return;
            const box = dialog.getBoundingClientRect();
            const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
            if (outside) finish();
        });
        dialog.addEventListener("close", () => finish());

        dialog.append(heading, content, row);
        if (controller) controller.close = (value) => finish(value);
        doc.body.append(dialog);
        dialog.showModal();
        focus?.focus();
    });
}

/** Asks a yes/no question; `confirmLabel` is the costly choice, `cancelLabel` (the default) keeps things as they are. */
export function confirmDialog({ title, body, confirmLabel, cancelLabel = "Cancel", danger = true, doc }) {
    return showDialog({
        title,
        body,
        buttons: [
            { label: cancelLabel, value: false, kind: "primary" },
            { label: confirmLabel, value: true, kind: danger ? "danger" : "plain" },
        ],
        cancelValue: false,
        focusValue: false,
        doc,
    });
}
