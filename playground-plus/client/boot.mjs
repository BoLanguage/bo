// The Playground+ page's entry point: it takes the place of the playground's own script tag in
// playground/index.html (see playground-plus/server.mjs), connects the playground to the server (puzzles
// from it, and the recorder for the play), then starts it.
import { configure } from "../../playground/config.mjs";
import { createToast } from "../../playground/menu.mjs";
import { createStaticPuzzleProvider } from "../../playground/puzzles.mjs";
import { createApi } from "./api.mjs";
import { confirmDialog } from "./dialog.mjs";
import { createNewPuzzle } from "./new-puzzle.mjs";
import { createPageControl } from "./page-control.mjs";
import { createProfile } from "./profile.mjs";
import { createPlusPuzzleProvider, PAST_NOTE, REVEAL_NOTE } from "./provider.mjs";
import { createRecorder } from "./recorder.mjs";
import { createWatch } from "./watch.mjs";

document.title = "Bo Playground+";
const wordmark = document.querySelector(".wordmark");
if (wordmark) {
    const plus = document.createElement("sup");
    plus.textContent = "+";
    plus.title = "Playground+: the playground with a local backend for agent-generated puzzles";
    //plus.style.cssText = "color: var(--accent); margin-left: 0.05em; font-family: var(--title); font-size: 0.7em; font-weight: 900;";
    plus.style.cssText = "color: var(--bofeet); margin-left: 0.05em; font-family: var(--title); font-size: 0.7em; font-weight: 900;";
    wordmark.append(plus);
}

const fetchText = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.text();
};
// Menu items that make no sense during a challenge are hidden (and disabled, so the menu's keyboard
// navigation skips them) while a recorded puzzle is being played.
const NOISE = ["upload", "fast"].flatMap((action) => [...document.querySelectorAll(`#menu [data-action="${action}"]`)]);
const hideNoise = (hide) => {
    for (const item of NOISE) {
        item.disabled = hide;
        item.style.display = hide ? "none" : "";
    }
};

const api = createApi();
const toast = createToast(document.getElementById("toast"));

// "Bo runtime 0.8.0 | Agent connected (Ollama)": whether a local model can write puzzles, shown
// next to the runtime version so the player knows before asking for a puzzle.
const version = document.getElementById("version");
const agentStatus = document.createElement("span");
agentStatus.id = "agent-status";
if (version) {
    const line = document.createElement("div");
    line.className = "runtime plus-runtime";
    version.before(line);
    version.classList.remove("runtime");
    line.append(version, agentStatus);
    const style = document.createElement("style");
    style.textContent = "#version { display: inline; } #version:not(:empty) + #agent-status::before { content: ' | '; } #agent-status { cursor: help; }";
    document.head.append(style);
}
function showAgentStatus(info) {
    if (!info) return;
    agentStatus.textContent = info.available ? "Agent connected (Ollama)" : "Agent not connected (manual prompt required)";
    agentStatus.title = info.available
        ? `Puzzles are written on this computer by a local model through Ollama (${info.models.length} suitable models installed; ${info.model} by default). Use New puzzle.`
        : `${info.reason ?? "No local model is available."}\nYou can still ask your own AI assistant: New puzzle, then "Ask my chat assistant".`;
}
api.generatorState().then(showAgentStatus).catch(() => {});

let recordedPuzzles = [];
const recorder = createRecorder({ api, onOpenChange: hideNoise, onStart: markPlayed });
const newPuzzle = createNewPuzzle({ api, canAutoLoad: () => !recorder.hasOpenSession(), onState: showAgentStatus, notify: (text) => toast(text, { ms: 5000 }) });
document.querySelector(".top .example")?.before(newPuzzle.button);
const profile = createProfile({ api, notify: (text) => toast(text, { ms: 5000 }) });
newPuzzle.button.after(profile.button);
const pageControl = createPageControl();
const watch = createWatch({ api, page: pageControl, notify: (text) => toast(text, { ms: 8000 }) });
profile.button.after(watch.button);
newPuzzle.restore();
watch.restore();
const provider = createPlusPuzzleProvider({
    practice: createStaticPuzzleProvider(new URL("../../examples/puzzles/", import.meta.url), fetchText),
    api,
});

/**
 * A recorded puzzle was started: this was its first play. From now on it is a past puzzle (in the picker, and
 * for the recorder: its next plays are practice), so the statistics count each puzzle once.
 */
function markPlayed(puzzle) {
    puzzle.played = true;
    puzzle.recorded = false;
    puzzle.description = puzzle.description?.replace(REVEAL_NOTE, PAST_NOTE) ?? puzzle.description; // for its next load
    recordedPuzzles = recordedPuzzles.filter((candidate) => candidate.id !== puzzle.id);
    recorder.setPuzzles(recordedPuzzles);
    const option = document.querySelector(`#example option[value="puzzle:${puzzle.id}"]`);
    const past = document.getElementById("past");
    const fresh = document.getElementById("puzzles");
    if (!option || !past) return;
    past.prepend(option);
    past.hidden = false;
    if (fresh) fresh.hidden = fresh.children.length === 0;
}

// What each guarded action means for a recorded puzzle that is being played. Showing the puzzle's
// source (the editor, or sharing the editor's program) gives the solution away, so it counts as
// revealing it; emptying everything ends the challenge, so it counts as giving up.
const CHALLENGE_ACTIONS = {
    editor: {
        title: "Open the editor?",
        body: "The editor shows this puzzle's source, including its solution. Opening it ends the challenge and counts as revealing the solution.",
        confirmLabel: "Show the solution",
        reveals: true,
    },
    share: {
        title: "Share the editor's program?",
        body: "The editor holds this puzzle's source, including its solution, so sharing it gives the solution away. It ends the challenge and counts as revealing the solution.",
        confirmLabel: "Share and reveal",
        reveals: true,
    },
    clear: {
        title: "Reset everything?",
        body: "This ends the challenge: the puzzle will count as abandoned.",
        confirmLabel: "Give up",
        reveals: false,
    },
    load: {
        title: "Leave this puzzle?",
        body: "You are in the middle of a puzzle. Choosing something else ends it, and it will count as abandoned.",
        confirmLabel: "Leave the puzzle",
        reveals: false,
    },
};

configure({
    onEvent(event) {
        recorder.onEvent(event);
        pageControl.onEvent(event);
    },
    async beforeAction(name) {
        const action = CHALLENGE_ACTIONS[name];
        if (!action || !recorder.hasOpenSession()) return true;
        const confirmed = await confirmDialog({ title: action.title, body: action.body, cancelLabel: "Keep playing", confirmLabel: action.confirmLabel });
        if (!confirmed && name === "load") pageControl.declined();
        if (confirmed && action.reveals) recorder.revealSource();
        return confirmed;
    },
    puzzleProvider: {
        async load() {
            const loaded = await provider.load();
            recordedPuzzles = loaded.puzzles.filter((puzzle) => puzzle.recorded);
            recorder.setPuzzles(recordedPuzzles);
            return loaded;
        },
        subscribe(callback) {
            return provider.subscribe((puzzle) => {
                if (puzzle.recorded) {
                    recordedPuzzles = [...recordedPuzzles, puzzle];
                    recorder.setPuzzles(recordedPuzzles);
                }
                callback(puzzle);
                newPuzzle.arrived(puzzle); // after the page has listed it, so that it can be loaded
            });
        },
    },
});
await import("../../playground/app.mjs");
