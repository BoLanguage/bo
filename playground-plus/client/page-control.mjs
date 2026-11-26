// Drives the playground page from the outside, through what a person would use: the program picker, and the
// prompt and its form. The playground itself is not changed. It learns that something finished from the
// store's events (`onEvent`, see playground/config.mjs), which Playground+ already receives.
const LOAD_WAIT_MS = 10 * 60_000; // a confirmation (leaving a puzzle in progress) may wait for the person
const LINE_WAIT_MS = 30_000;

/** @param {{doc?: Document}} [options] */
export function createPageControl({ doc = document } = {}) {
    let waiter = null; // {type, resolve}: what the page is being waited on for
    const locked = []; // the elements made inert

    const wait = (type, ms) => new Promise((resolve) => {
        const timer = doc.defaultView.setTimeout(() => finish(false), ms);
        const finish = (value) => {
            doc.defaultView.clearTimeout(timer);
            if (waiter?.finish === finish) waiter = null;
            resolve(value);
        };
        waiter = { type, finish };
    });

    return {
        /** Give every store event to this. */
        onEvent(event) {
            if (waiter && event.type === waiter.type) waiter.finish(true);
        },
        /** The player declined to leave the puzzle they are in: a load that was waited on will not happen. */
        declined() {
            if (waiter?.type === "setup") waiter.finish(false);
        },
        /** Chooses a puzzle in the picker as the player would, and resolves to whether it was loaded. */
        loadPuzzle(id) {
            const select = doc.getElementById("example");
            const value = `puzzle:${id}`;
            if (!select || ![...select.options].some((option) => option.value === value)) return Promise.resolve(false);
            const loaded = wait("setup", LOAD_WAIT_MS);
            select.value = value;
            select.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
            return loaded;
        },
        /** Shows text in the prompt, as if it were being typed. */
        setPrompt(text) {
            const input = doc.getElementById("repl-input");
            if (input) input.value = text;
        },
        /** Runs a line from the prompt, as Enter would; resolves to whether the page finished it. */
        submit(code) {
            const input = doc.getElementById("repl-input");
            const form = doc.getElementById("repl");
            if (!input || !form) return Promise.resolve(false);
            input.value = code;
            const done = wait("evaluate", LINE_WAIT_MS);
            form.requestSubmit();
            return done;
        },
        /**
         * While an agent plays, the page cannot be used: `inert` stops clicks, typing and focus (not scripts). It is
         * set on everything around `keep` (the banner, which stays usable), not on the banner's own ancestors.
         */
        lock(on, keep = null) {
            for (const node of locked.splice(0)) node.removeAttribute("inert");
            if (!on) return;
            const layout = doc.getElementById("layout");
            for (let node = keep; node && node !== layout && node.parentElement; node = node.parentElement) {
                for (const sibling of node.parentElement.children) {
                    if (sibling === node || sibling.hasAttribute("inert")) continue;
                    sibling.setAttribute("inert", "");
                    locked.push(sibling);
                }
            }
        },
    };
}
