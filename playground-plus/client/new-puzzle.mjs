// The "New puzzle" button and its dialogs. A player asks for a puzzle (optionally a topic, and easier or
// harder than the last one). Two ways to get it:
//  - a local model writes it here, in the background, on the server (the default when Ollama is installed);
//  - the player gives a message to their own chat assistant, which writes it through the MCP server.
// Either way the server records the request, and `get_brief` reads it, so the wishes reach the writer.
import { CHANGES, TAGS } from "../taxonomy.mjs";
import { showDialog } from "./dialog.mjs";

const STYLE_ID = "plus-new-puzzle-style";
const STYLE = `
.plus-new { font: inherit; font-size: 0.85rem; font-weight: 600; padding: 0.35rem 0.8rem; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--accent, #3b6fd4); background: transparent; color: var(--accent, #3b6fd4); white-space: nowrap; }
.plus-new:hover { background: var(--hover, rgba(20, 30, 60, 0.07)); }
.plus-new:focus-visible { outline: 2px solid var(--accent, #3b6fd4); outline-offset: 2px; }
.plus-new[data-waiting] { border-style: dashed; }
.plus-new[data-waiting]::before { content: ""; display: inline-block; width: 0.5em; height: 0.5em; margin-right: 0.45em; border-radius: 50%;
    background: var(--accent, #3b6fd4); animation: plus-pulse 1.4s ease-in-out infinite; }
@keyframes plus-pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .plus-new[data-waiting]::before { animation: none; } }
.plus-new[data-ready] { background: var(--accent, #3b6fd4); color: var(--accent-text, #fff); border-style: solid; }
.plus-new[data-ready]:hover { filter: brightness(1.1); background: var(--accent, #3b6fd4); }
@keyframes plus-attn { 50% { border-color: var(--accent, #3b6fd4); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent, #3b6fd4) 35%, transparent); } }
select.plus-attn { animation: plus-attn 0.9s ease-in-out 3; border-color: var(--accent, #3b6fd4); }
@media (prefers-reduced-motion: reduce) { select.plus-attn { animation: none; } }
.plus-form p { margin: 0 0 0.7rem; }
.plus-form fieldset { border: 0; margin: 0 0 0.8rem; padding: 0; }
.plus-form legend { font-weight: 600; margin-bottom: 0.3rem; padding: 0; }
.plus-form label { display: block; margin: 0.15rem 0; }
.plus-form label small { display: block; margin-left: 1.55rem; opacity: 0.75; }
.plus-form .plus-chips { display: flex; flex-wrap: wrap; gap: 0.3rem 1rem; }
.plus-form .plus-chips label { display: inline-block; }
.plus-form .plus-model { margin: 0.2rem 0 0 1.55rem; display: flex; align-items: center; gap: 0.5rem; }
.plus-form .plus-model select { font: inherit; padding: 0.2rem 0.4rem; border-radius: 6px; border: 1px solid var(--border, #d9dde5); background: var(--bg, #f6f7f9); color: inherit; }
.plus-form [disabled], .plus-form label:has([disabled]) { opacity: 0.55; }
.plus-prompt { width: 100%; box-sizing: border-box; min-height: 7.5rem; font: 0.85rem/1.4 var(--mono, ui-monospace, monospace); padding: 0.5rem;
    border-radius: 8px; border: 1px solid var(--border, #d9dde5); background: var(--bg, #f6f7f9); color: inherit; resize: vertical; }
.plus-copied { margin-left: 0.6rem; opacity: 0.8; }
.plus-progress { font-variant-numeric: tabular-nums; }
`;

const CHANGE_LABELS = { same: "Let Playground+ decide", easier: "A bit easier than last time", harder: "A bit harder than last time" };
const TOOL_TEXT = {
    get_bo_guide: "reading the guide",
    get_brief: "deciding what to write",
    get_user_profile: "looking at how you play",
    get_session_history: "looking at how you play",
    list_puzzles: "looking at the existing puzzles",
    get_bo_reference: "looking something up",
    validate_puzzle: "checking its puzzle",
    submit_puzzle: "handing the puzzle over",
};
const POLL_MS = 1500;
const ORDINALS = { 2: "second", 3: "third", 4: "fourth" };
const AUTOLOAD_WINDOW_MS = 15_000; // how long after a job ends its puzzle is still loaded for a player who was watching

/** What the player asked for, in words ("about list, a bit harder than the last one"), or "" if nothing special. */
export function describePreferences({ tags = [], change } = {}) {
    const parts = [];
    if (tags.length) parts.push(`about ${tags.join(" or ")}`);
    if (change === "easier") parts.push("a bit easier than the last one");
    if (change === "harder") parts.push("a bit harder than the last one");
    return parts.join(", ");
}

/** The message the player gives their assistant (the preferences are also on the server, for `get_brief`). */
export function buildPrompt(preferences = {}) {
    const wish = describePreferences(preferences);
    return [
        "Please write me a new puzzle for Playground+.",
        "Use the Playground+ tools: read get_bo_guide first, then call get_brief, then validate_puzzle until it is valid, then submit_puzzle.",
        ...(wish ? [`I would like it ${wish}.`] : []),
        "When it is submitted, tell me its title, but do not tell me the solution.",
    ].join(" ");
}

/** What a running job is doing, for the player: "gemma4:12b is checking its puzzle · 0:42". */
export function describeJob(job, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - job.startedAt) / 1000));
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const doing = job.turn === 0 ? "starting up (the first time can take a minute or two)" : TOOL_TEXT[job.tool] ?? "working";
    return `${job.model} is ${doing}${job.attempt > 1 ? `, on its ${ORDINALS[job.attempt] ?? `${job.attempt}th`} try` : ""} · ${elapsed}`;
}

const element = (doc, tag, props = {}, ...children) => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
        if (name === "class") node.className = value;
        else if (value !== false && value !== null && value !== undefined) node.setAttribute(name, value === true ? "" : value);
    }
    node.append(...children);
    return node;
};

/**
 * The first dialog: how it is made, which model, which topics, how hard. `info` is what the server says
 * ({available, reason, models, model, hasHistory}). Resolves to {how, model, preferences}, or null if the
 * player cancels.
 */
function askPreferences(doc, info) {
    const group = (legend, ...rows) => element(doc, "fieldset", {}, element(doc, "legend", {}, legend), ...rows);
    const radio = (name, value, label, { checked = false, disabled = false, note = "" } = {}) =>
        element(doc, "label", {}, element(doc, "input", { type: "radio", name, value, checked, disabled }), ` ${label}`, ...(note ? [element(doc, "small", {}, note)] : []));
    const local = info.available;
    const modelPicker = local && info.models.length > 1
        ? element(doc, "div", { class: "plus-model" }, element(doc, "label", { for: "plus-model" }, "Model:"),
            element(doc, "select", { id: "plus-model", name: "model" }, ...info.models.map((m) => element(doc, "option", { value: m.name, selected: m.name === info.model }, `${m.name}${m.parameterSize ? ` (${m.parameterSize})` : ""}`))))
        : null;
    const tagRow = element(doc, "div", { class: "plus-chips" },
        ...TAGS.map((tag) => element(doc, "label", {}, element(doc, "input", { type: "checkbox", name: "tag", value: tag }), ` ${tag}`)));
    const noHistory = !info.hasHistory;
    const form = element(doc, "form", { class: "plus-form" },
        element(doc, "p", {}, "Puzzles are written by an AI model, to suit how you are doing."),
        group("How should it be made?",
            radio("how", "local", "Write it here with a local model", {
                checked: local, disabled: !local,
                note: local ? `Runs on this computer through Ollama; usually under two minutes.` : info.reason ?? "Not available.",
            }),
            ...(modelPicker ? [modelPicker] : []),
            radio("how", "paste", "Ask my chat assistant", { checked: !local, note: "You paste a short message into an assistant that is connected to Playground+." })),
        group("Topic (optional, up to 3)", tagRow),
        group("How hard?",
            ...CHANGES.map((change) => radio("change", change, CHANGE_LABELS[change], { checked: change === "same", disabled: noHistory && change !== "same" })),
            ...(noHistory ? [element(doc, "small", {}, "Easier and harder are than your last puzzle, so they are available once you have played one.")] : [])));
    form.addEventListener("submit", (event) => event.preventDefault());
    const limit = () => {
        const boxes = [...form.querySelectorAll('input[name="tag"]')];
        const full = boxes.filter((box) => box.checked).length >= 3;
        for (const box of boxes) box.disabled = full && !box.checked;
    };
    form.addEventListener("change", limit);
    return showDialog({
        title: "New puzzle", body: form, doc,
        buttons: [{ label: "Cancel", value: false }, { label: "Continue", value: true, kind: "primary" }],
        cancelValue: false, focusValue: true,
    }).then((confirmed) => {
        if (!confirmed) return null;
        const tags = [...form.querySelectorAll('input[name="tag"]:checked')].map((box) => box.value);
        const change = form.querySelector('input[name="change"]:checked')?.value ?? "same";
        return {
            how: form.querySelector('input[name="how"]:checked')?.value ?? "paste",
            model: form.querySelector('select[name="model"]')?.value ?? info.model,
            preferences: { ...(tags.length ? { tags } : {}), ...(change !== "same" ? { change } : {}) },
        };
    });
}

/**
 * While a request waits for the player's own assistant: the message to give it, and the choice to keep
 * waiting or to cancel. Resolves to "cancel" or to anything else (keep waiting).
 */
function waitDialog(doc, preferences, controller) {
    const prompt = buildPrompt(preferences);
    const area = element(doc, "textarea", { class: "plus-prompt", readonly: true, "aria-label": "Message for your assistant" }, prompt);
    area.value = prompt;
    const copied = element(doc, "span", { class: "plus-copied", role: "status" });
    const copy = element(doc, "button", { type: "button" }, "Copy");
    copy.addEventListener("click", async () => {
        try {
            await doc.defaultView.navigator.clipboard.writeText(prompt);
            copied.textContent = "Copied.";
        } catch {
            area.focus();
            area.select();
            copied.textContent = "Select it and copy (Ctrl+C).";
        }
    });
    const wish = describePreferences(preferences);
    const body = element(doc, "div", { class: "plus-form" },
        element(doc, "p", {}, "Paste this into the chat of an assistant that is connected to Playground+. The puzzle appears here as soon as it is ready."),
        ...(wish ? [element(doc, "p", {}, `You asked for a puzzle ${wish}.`)] : []),
        area, element(doc, "p", {}, copy, copied));
    return showDialog({
        title: "Waiting for your assistant", body, doc, controller,
        buttons: [{ label: "Cancel the request", value: "cancel", kind: "danger" }, { label: "Keep waiting", value: "wait", kind: "primary" }],
        cancelValue: "wait", focusValue: "wait",
    });
}

/** The dialog shown while a local model writes the puzzle. `view.update(job)` refreshes its text. */
function progressDialog(doc, job, view) {
    const window = doc.defaultView;
    let latest = job;
    const status = element(doc, "p", { class: "plus-progress", role: "status" }, describeJob(job));
    const wish = describePreferences(job.preferences ?? {});
    const refresh = () => {
        status.textContent = describeJob(latest);
    };
    view.update = (current) => {
        latest = current;
        refresh();
    };
    const clock = window.setInterval(refresh, 1000); // the elapsed time moves between the server's updates
    return showDialog({
        title: "Writing your puzzle", doc, controller: view,
        body: element(doc, "div", { class: "plus-form" }, status, ...(wish ? [element(doc, "p", {}, `You asked for a puzzle ${wish}.`)] : []),
            element(doc, "p", {}, "You can hide this window and keep playing: the puzzle goes on being written, and the New puzzle button tells you when it is ready."),
            element(doc, "p", {}, "Stopping throws away the work so far. Nothing is added to your puzzles.")),
        buttons: [{ label: "Stop writing this puzzle", value: "cancel", kind: "danger" }, { label: "Hide this window, keep writing", value: "hide", kind: "primary" }],
        cancelValue: "hide", focusValue: "hide",
    }).finally(() => window.clearInterval(clock));
}

/**
 * Adds the button and keeps its state: "New puzzle", "Writing a puzzle" while a local model works, or
 * "Waiting for a puzzle" while a request waits for the player's assistant. `arrived()` tells it a puzzle
 * came in. `canAutoLoad()` says whether a puzzle may be loaded for the player right now (not while they are
 * in the middle of another); `onState(info)` is told what the server says about the generator, whenever it is
 * asked; `notify(text)` shows a short message. Returns {button, arrived, restore}.
 */
export function createNewPuzzle({ api, doc = document, now = Date.now, canAutoLoad = () => true, onState = () => {}, notify = () => {} }) {
    if (!doc.getElementById(STYLE_ID)) doc.head.append(element(doc, "style", { id: STYLE_ID }, STYLE));
    const button = element(doc, "button", { type: "button", class: "plus-new" }, "New puzzle");
    let epoch = 0; // bumped when the job ends or is stopped, so that a status request in flight is ignored
    let pending = null; // {id, preferences}: a request for the player's own assistant
    let job = null; // the running job of the local model, as the server describes it
    let ready = null; // {id, title}: a puzzle that arrived and was not loaded for the player
    let autoLoadUntil = 0; // until when an arriving puzzle is loaded for a player who was watching the job
    let lastChoice = null; // what the player chose last, for "Try again"
    let waiting = null; // the controller of the open waiting or progress dialog
    let timer = null;
    let pulseTimer = null;
    const window = doc.defaultView;
    const picker = () => doc.getElementById("example");

    /** Chooses a puzzle in the playground's picker, as if the player had; false if it is not in the list. */
    function loadPuzzle(id) {
        const select = picker();
        const value = `puzzle:${id}`;
        if (!select || ![...select.options].some((o) => o.value === value)) return false;
        select.value = value;
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
        return true;
    }
    /** Draws the eye to the picker for a few seconds. */
    function pulse() {
        const select = picker();
        if (!select) return;
        select.classList.add("plus-attn");
        window.clearTimeout(pulseTimer);
        pulseTimer = window.setTimeout(() => select.classList.remove("plus-attn"), 6000);
    }
    // choosing the new puzzle in the picker by hand answers the "ready" button
    picker()?.addEventListener("change", (event) => {
        if (ready && event.target.value === `puzzle:${ready.id}`) {
            ready = null;
            render();
        }
        picker().classList.remove("plus-attn");
    });

    const render = () => {
        const busy = pending !== null || job !== null;
        button.toggleAttribute("data-waiting", busy && !ready);
        button.toggleAttribute("data-ready", ready !== null);
        button.textContent = ready ? "Your puzzle is ready: play it" : job ? "Writing a puzzle" : pending ? "Waiting for a puzzle" : "New puzzle";
        button.title = ready ? `${ready.title}: click to play it`
            : job ? "A local model is writing a puzzle: open to see how it is going, or to cancel"
                : pending ? "A puzzle was requested: open to see the message for your assistant, or to cancel"
                    : "Ask for a new puzzle written for you";
    };
    const tell = (title, text) => showDialog({ title, body: text, doc, buttons: [{ label: "OK", value: true, kind: "primary" }] });

    function stopPolling() {
        if (timer !== null) window.clearInterval(timer);
        timer = null;
    }
    function startPolling() {
        timer ??= window.setInterval(tick, POLL_MS);
    }
    async function tick() {
        const mine = epoch;
        let current;
        try {
            current = await api.generatorStatus();
        } catch {
            return; // the server is busy or restarting: try again on the next beat
        }
        if (mine !== epoch) return; // the player stopped it (or the puzzle arrived) while we were asking
        if (current.state === "running") {
            job = { ...current, preferences: job?.preferences ?? lastChoice?.preferences };
            waiting?.update?.(job);
            return;
        }
        job = null;
        epoch++;
        stopPolling();
        // a job that ended while the player watched is followed by its puzzle, which is then loaded for them
        if (waiting !== null && current.state === "done") autoLoadUntil = now() + AUTOLOAD_WINDOW_MS;
        render();
        waiting?.close?.("hide");
        if (current.state === "failed") await failed(current.message);
    }

    async function failed(message) {
        const next = await showDialog({
            title: "The puzzle could not be written", doc,
            body: `${message ?? "No puzzle was written."} Nothing was added to your puzzles.`,
            buttons: [{ label: "Close", value: "close" }, { label: "Ask my chat assistant instead", value: "paste" }, { label: "Try again", value: "retry", kind: "primary" }],
            cancelValue: "close", focusValue: "retry",
        });
        if (next === "retry" && lastChoice) await begin({ ...lastChoice, how: "local" });
        if (next === "paste" && lastChoice) await begin({ ...lastChoice, how: "paste" });
    }

    async function showProgress() {
        waiting = { update: null };
        const answer = await progressDialog(doc, job, waiting);
        waiting = null;
        if (answer === "cancel") {
            epoch++;
            job = null;
            stopPolling();
            render();
            await api.cancelGeneration().catch(() => {});
            notify("Stopped. No puzzle was added.");
        }
    }

    async function showWait() {
        waiting = {};
        const answer = await waitDialog(doc, pending.preferences, waiting);
        waiting = null;
        if (answer === "cancel" && pending) {
            const { id } = pending;
            pending = null;
            render();
            await api.cancelRequest(id).catch(() => {}); // already answered or gone: nothing to cancel
        }
    }

    /** Carries out a choice: starts the local model, or records a request for the player's assistant. */
    async function begin(choice) {
        lastChoice = choice;
        if (choice.how === "local") {
            job = { ...(await api.generate({ preferences: choice.preferences, model: choice.model })), preferences: choice.preferences };
            render();
            startPolling();
            await showProgress();
        } else {
            pending = { id: await api.createRequest(choice.preferences), preferences: choice.preferences };
            render();
            await showWait();
        }
    }

    button.addEventListener("click", async () => {
        try {
            if (ready) {
                const { id } = ready;
                ready = null;
                render();
                if (!loadPuzzle(id)) await tell("The puzzle is not in the list yet", "Choose it from the New puzzles group in the picker.");
                return;
            }
            // ask the server, not our memory: after a stop or a restart they can disagree
            let info;
            try {
                info = await api.generatorState();
            } catch {
                info = { available: false, reason: "The server could not be asked.", models: [], model: null, hasHistory: false, job: { state: "idle" } };
            }
            onState(info);
            if (info.job?.state === "running") {
                job = { ...info.job, preferences: job?.preferences ?? {} };
                render();
                startPolling();
                return await showProgress();
            }
            if (job) {
                epoch++;
                job = null;
                stopPolling();
                render();
            }
            if (pending) return await showWait();
            const choice = await askPreferences(doc, info);
            if (choice) await begin(choice);
        } catch (error) {
            await tell("The request did not work", `Playground+ could not start it: ${error.detail ?? error.message}`);
        }
    });
    render();

    return {
        button,
        /**
         * A puzzle arrived (`{id, title}`), whoever wrote it. If the player was watching the wait (the
         * dialog was open, or had just closed because the job finished) and is not in the middle of another
         * puzzle, it is loaded at once; otherwise the button says it is ready and the picker draws attention,
         * so that nothing the player is doing is replaced without being asked.
         */
        arrived(puzzle) {
            const watching = waiting !== null || now() < autoLoadUntil;
            epoch++;
            pending = null;
            job = null;
            autoLoadUntil = 0;
            stopPolling();
            waiting?.close?.("hide");
            if (puzzle && !(watching && canAutoLoad() && loadPuzzle(puzzle.id))) {
                ready = puzzle;
                pulse();
            }
            render();
        },
        /** Picks up a job or a request that is still going (after a page reload). */
        async restore() {
            try {
                const current = await api.generatorStatus();
                if (current.state === "running") {
                    job = { ...current, preferences: {} };
                    startPolling();
                } else pending = await api.pendingRequest();
            } catch {
                pending = null;
            }
            render();
        },
    };
}
