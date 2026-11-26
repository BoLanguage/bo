// The "My profile" button and its dialog: the player's statistics, those of the agents that have played, and
// what is stored about the player (which can be shown, exported and erased). The numbers come from the
// server (service.getStatistics); this module only presents them.
import { confirmDialog, showDialog } from "./dialog.mjs";

const STYLE_ID = "plus-profile-style";
const STYLE = `
.plus-profile-button { font: inherit; font-size: 0.85rem; font-weight: 600; padding: 0.35rem 0.8rem; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border, #d9dde5); background: transparent; color: var(--text, #1d2330); white-space: nowrap; }
.plus-profile-button:hover { background: var(--hover, rgba(20, 30, 60, 0.07)); }
.plus-profile-button:focus-visible { outline: 2px solid var(--accent, #3b6fd4); outline-offset: 2px; }
.plus-profile h3 { margin: 1.1rem 0 0.4rem; font-size: 1rem; }
.plus-profile h3:first-child { margin-top: 0; }
.plus-profile p { margin: 0 0 0.6rem; }
.plus-profile .plus-note { opacity: 0.75; font-size: 0.85rem; }
.plus-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: 0.5rem; margin: 0.5rem 0 0.8rem; }
.plus-tile { border: 1px solid var(--border, #d9dde5); border-radius: 10px; padding: 0.5rem 0.7rem; }
.plus-tile b { display: block; font-size: 1.35rem; font-variant-numeric: tabular-nums; }
.plus-tile span { font-size: 0.78rem; opacity: 0.75; }
.plus-profile table { border-collapse: collapse; width: 100%; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
.plus-profile th, .plus-profile td { text-align: right; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--border, #d9dde5); }
.plus-profile th:first-child, .plus-profile td:first-child { text-align: left; }
.plus-profile details { margin: 0.8rem 0 0; }
.plus-profile summary { cursor: pointer; font-weight: 600; }
.plus-profile ul { margin: 0.3rem 0 0.6rem 1.1rem; padding: 0; }
.plus-profile pre { max-height: 14rem; overflow: auto; padding: 0.6rem; border-radius: 8px; background: var(--bg, #f6f7f9); font-size: 0.78rem; }
.plus-profile .plus-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; padding-bottom: 10px; }
`;

const dash = "–";
export const formatNumber = (n) => (n === null || n === undefined ? dash : String(n));
export const formatRate = (rate) => (rate === null || rate === undefined ? dash : `${Math.round(rate * 100)}%`);
export function formatSeconds(seconds) {
    if (seconds === null || seconds === undefined) return dash;
    if (seconds < 60) return `${seconds} s`;
    return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/** The headline numbers of a set of sessions (the player's, or one agent's), as `{label, value, note}` tiles. */
export function overviewTiles(stats, { subject = "puzzles" } = {}) {
    const left = stats.abandoned + stats.skipped;
    return [
        { label: `${subject} played`, value: formatNumber(stats.played) },
        { label: "solved", value: formatNumber(stats.solved), note: formatRate(stats.solveRate) === dash ? "" : `${formatRate(stats.solveRate)} of those finished` },
        { label: "solution revealed", value: formatNumber(stats.revealed) },
        { label: "abandoned", value: formatNumber(left), note: stats.skipped ? `${stats.skipped} left for another puzzle` : "" },
        { label: "mean difficulty (1 to 5)", value: formatNumber(stats.meanDifficulty) },
        { label: "median time to solve", value: formatSeconds(stats.medianSolveSeconds) },
        { label: "hints per solved puzzle", value: formatNumber(stats.averageHintsOnSolved) },
        { label: "words typed to solve", value: formatNumber(stats.meanWordsToSolve), note: stats.meanLengthRatio === null || stats.meanLengthRatio === undefined ? "" : `${stats.meanLengthRatio}× the shortest known answer` },
    ];
}

/** Rows for a breakdown by difficulty or topic: `[label, played, solved, solve rate, median time]`. */
export function breakdownRows(groups) {
    return Object.entries(groups).map(([label, s]) => [label, formatNumber(s.played ?? s.sessions), formatNumber(s.solved), formatRate(s.solveRate), formatSeconds(s.medianSolveSeconds)]);
}

/** Rows for the agents table: `[model, attempts, solved, solve rate, median time, words typed]`. */
export function agentRows(agents) {
    return agents.map((a) => [a.model, formatNumber(a.played), formatNumber(a.solved), formatRate(a.solveRate), formatSeconds(a.medianSolveSeconds), formatNumber(a.meanWordsToSolve)]);
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

const table = (doc, head, rows) =>
    element(doc, "table", {}, element(doc, "thead", {}, element(doc, "tr", {}, ...head.map((h) => element(doc, "th", {}, h)))),
        element(doc, "tbody", {}, ...rows.map((row) => element(doc, "tr", {}, ...row.map((cell) => element(doc, "td", {}, cell))))));

const tiles = (doc, list) => element(doc, "div", { class: "plus-tiles" },
    ...list.map((t) => element(doc, "div", { class: "plus-tile" }, element(doc, "b", {}, t.value), element(doc, "span", {}, t.label), ...(t.note ? [element(doc, "br"), element(doc, "span", {}, t.note)] : []))));

const dateOf = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : null);

/** The body of the dialog for `profile` ({you, agents, data}); `actions` has show(), exportData() and erase(). */
export function profileBody(doc, profile, actions) {
    const { you, agents, data } = profile;
    const body = element(doc, "div", { class: "plus-profile" });
    body.append(
        element(doc, "h3", {}, "You"),
        element(doc, "p", { class: "plus-note" }, "Only the first time you play a puzzle counts: after that it is practice."),
        tiles(doc, overviewTiles(you)),
    );
    const detail = (summary, groups) => {
        const rows = breakdownRows(groups);
        return element(doc, "details", {}, element(doc, "summary", {}, summary),
            rows.length ? table(doc, [summary.replace("By ", ""), "played", "solved", "solve rate", "median time"], rows) : element(doc, "p", { class: "plus-note" }, "Nothing yet."));
    };
    body.append(detail("By difficulty", you.byDifficulty), detail("By topic", you.byTag));

    body.append(element(doc, "h3", {}, "Agents"));
    if (agents.length) {
        body.append(table(doc, ["model", "attempts", "solved", "solve rate", "median time", "words typed"], agentRows(agents)),
            element(doc, "p", { class: "plus-note" }, "Every attempt of an agent counts, since it does not learn from the last one."));
    } else body.append(element(doc, "p", { class: "plus-note" }, "No agent has played yet."));

    const output = element(doc, "pre", { hidden: true });
    const show = element(doc, "button", { type: "button" }, "Show my data");
    show.addEventListener("click", async () => {
        output.hidden = false;
        output.textContent = "Loading…";
        output.textContent = await actions.show();
    });
    const exportButton = element(doc, "button", { type: "button" }, "Export as a file");
    exportButton.addEventListener("click", () => actions.exportData());
    const erase = element(doc, "button", { type: "button", class: "danger" }, "Erase my history");
    erase.addEventListener("click", () => actions.erase());
    body.append(element(doc, "details", {}, element(doc, "summary", {}, "What is stored about me"),
        element(doc, "p", {}, "Stored, on this computer only (the file ", element(doc, "code", {}, "playground-plus/data/playground-plus.sqlite"), "):"),
        element(doc, "ul", {}, element(doc, "li", {}, "each recorded puzzle you played: when, how it ended, hints and guesses"),
            element(doc, "li", {}, "the lines you typed at the prompt while playing it, and whether each worked")),
        element(doc, "p", {}, "Not stored: your name or any other identity, the editor's contents, anything you type outside a recorded puzzle, and anything that leaves this computer."),
        element(doc, "p", {}, "The runs of agents you watched (what the model typed, nothing about you) are stored too. They are not part of your history, so erasing it keeps them."),
        element(doc, "p", {}, `Right now: ${data.sessions} session${data.sessions === 1 ? "" : "s"} (${data.replays} of them replays), ${data.promptLines} prompt line${data.promptLines === 1 ? "" : "s"}${dateOf(data.since) ? `, since ${dateOf(data.since)}` : ""}.`),
        element(doc, "div", { class: "plus-actions" }, show, exportButton, erase), output));
    return body;
}

/** Adds the button. `notify(text)` shows a short message; `reload()` reloads the page (after erasing, the picker is stale). */
export function createProfile({ api, doc = document, notify = () => {}, reload = () => doc.defaultView.location.reload() }) {
    if (!doc.getElementById(STYLE_ID)) doc.head.append(element(doc, "style", { id: STYLE_ID }, STYLE));
    const button = element(doc, "button", { type: "button", class: "plus-profile-button", title: "Your statistics, and what is stored about you" }, "My profile");

    const actions = {
        show: async () => JSON.stringify(await api.exportProfile(), null, 2),
        async exportData() {
            const text = JSON.stringify(await api.exportProfile(), null, 2);
            const link = element(doc, "a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: "bo-playground-plus-history.json" });
            doc.body.append(link);
            link.click();
            link.remove();
            notify("Your history was saved as a file.");
        },
        async erase() {
            const sure = await confirmDialog({
                title: "Erase your history?",
                body: "This deletes every session and prompt line stored about you. Your puzzles stay, and become new again. It cannot be undone.",
                confirmLabel: "Erase it", cancelLabel: "Keep it", doc,
            });
            if (!sure) return;
            const { sessions } = await api.eraseProfile();
            notify(`Erased ${sessions} session${sessions === 1 ? "" : "s"}.`);
            controller.close?.("erased");
            reload();
        },
    };
    const controller = {};
    button.addEventListener("click", async () => {
        try {
            const profile = await api.profile();
            await showDialog({
                title: "My profile", doc, wide: true, controller,
                body: profileBody(doc, profile, actions),
                buttons: [{ label: "Close", value: true, kind: "primary" }], cancelValue: true,
            });
        } catch (error) {
            await showDialog({ title: "The profile could not be shown", body: error.message, doc, buttons: [{ label: "OK", value: true, kind: "primary" }] });
        }
    });
    return { button };
}
