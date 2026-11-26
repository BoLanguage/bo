// A small popup menu: a button that opens a list of `role="menuitem"` (or `menuitemcheckbox`) buttons. Closes on a click
// outside, on Escape, and after a choice; Up/Down move between items.

/** @returns {{open(): void, close(): void, toggle(): void, isOpen(): boolean}} */
export function createMenu({ button, menu, onChoose }) {
    const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not([disabled])')];
    const isOpen = () => !menu.hidden;

    function close({ restoreFocus = false } = {}) {
        if (!isOpen()) return;
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
        if (restoreFocus) button.focus();
    }

    function open() {
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        items()[0]?.focus();
    }

    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => (isOpen() ? close() : open()));

    menu.addEventListener("click", (event) => {
        const item = event.target.closest('[role^="menuitem"]');
        if (!item || item.disabled) return;
        close();
        onChoose(item.dataset.action);
    });

    menu.addEventListener("keydown", (event) => {
        const list = items();
        const at = list.indexOf(document.activeElement);
        if (event.key === "ArrowDown") list[(at + 1) % list.length]?.focus();
        else if (event.key === "ArrowUp") list[(at - 1 + list.length) % list.length]?.focus();
        else if (event.key === "Home") list[0]?.focus();
        else if (event.key === "End") list[list.length - 1]?.focus();
        else if (event.key === "Escape") close({ restoreFocus: true });
        else if (event.key === "Tab") close();
        else return;
        if (event.key !== "Tab") event.preventDefault();
    });

    document.addEventListener("pointerdown", (event) => {
        if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) close();
    });

    return { open, close, toggle: () => (isOpen() ? close() : open()), isOpen };
}

/** Shows `text` for a few seconds in `element` (a live region). */
export function createToast(element) {
    let timer = 0;
    return (text, { ms = 4000 } = {}) => {
        clearTimeout(timer);
        element.textContent = text;
        element.hidden = false;
        timer = setTimeout(() => (element.hidden = true), ms);
    };
}
