// Wires the store, the editor and the views to the page.
import { createWorkerClient } from "./client.mjs";
import { config } from "./config.mjs";
import { createEditor } from "./editor.mjs";
import { EXAMPLES } from "./examples.mjs";
import { createStaticPuzzleProvider } from "./puzzles.mjs";
import { createHistory } from "./history.mjs";
import { createMenu, createToast } from "./menu.mjs";
import { arrowPlacement, arrowRect, cardPlacement, union } from "./arrow.mjs";
import { createOnboarding, describeStep, EXPRESSION, STEP_COUNT } from "./onboarding.mjs";
import { readShare, shareLink } from "./share.mjs";
import { createSidebar } from "./sidebar.mjs";
import { stackOperationCode } from "./stackops.mjs";
import { createStore } from "./store.mjs";
import { echoPanel, framesPanel, libraryResults, nextPanel, outputPanel, promptPlaceholder, puzzleGoalPanel, stacksPanel } from "./views.mjs";

const $ = (id) => document.getElementById(id);
const examplesUrl = new URL("../examples/", import.meta.url);
const puzzlesUrl = new URL("../examples/puzzles/", import.meta.url);
const workerUrl = new URL("./worker.mjs", import.meta.url);
const MAX_UPLOAD = 2 * 1024 * 1024; // bytes; the file is shown in the standard input box
const sources = {};
const puzzles = new Map();

const fetchText = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.text();
};

const store = createStore((onOutput) => createWorkerClient(workerUrl, onOutput), { onEvent: config.onEvent });
const puzzleProvider = config.puzzleProvider ?? createStaticPuzzleProvider(puzzlesUrl, fetchText);
const { actions } = store;
const isActive = () => ["ready", "paused"].includes(store.getState().status);
const toast = createToast($("toast"));
let onboarding = null;
const onboardingActivity = () => onboarding?.activity();

const remember = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            // the choice just is not remembered
        }
    },
};

// ---------------------------------------------------------------- theme

$("theme").addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    remember.set("bo-theme", theme);
});

// ---------------------------------------------------------------- editor sidebar and loaded program

let loadedDoc = null; // the text of the program loaded into the machine
let userEdited = false; // the editor holds text the user wrote
let settingDoc = false;

const editor = createEditor($("editor"), {
    doc: "",
    onChange: () => {
        onboardingActivity();
        if (!settingDoc) userEdited = true;
        render(store.getState());
    },
    keys: { "Mod-Enter": () => run(), F10: () => step(), "Shift-Enter": () => step() },
});

function setDoc(text, edited = false) {
    settingDoc = true;
    editor.setDoc(text);
    settingDoc = false;
    userEdited = edited;
}

const beforeAction = config.beforeAction ?? (async () => true);
let pickerChoice = ""; // the picker's current choice, put back if the player declines to leave a puzzle
const sidebar = createSidebar({
    layout: $("layout"),
    content: $("editor-content"),
    toggle: $("editor-toggle"),
    resizer: $("resizer"),
    beforeOpen: () => beforeAction("editor"),
    onChange(open) {
        onboardingActivity();
        $("menu-editor").textContent = open ? "Hide editor" : "Show editor";
        if (open) editor.measure();
        if (onboarding) renderOnboarding(onboarding.getState());
    },
    onResize: () => editor.measure(),
});

async function openEditor({ focus = false } = {}) {
    if (!sidebar.isOpen() && !(await beforeAction("editor"))) return;
    sidebar.open();
    if (focus) requestAnimationFrame(() => editor.focus());
}

async function startFresh() {
    loadStdin(""); // the text box too, not only what the machine reads
    await actions.reset();
    actions.clearOutput();
    actions.setHiddenStacks([]);
    actions.setHiddenStackPrefixes([]);
    actions.setPuzzleGoal(null);
    actions.setPuzzleDescription(null);
    actions.setPuzzleHints(0);
    actions.setPuzzleTitle(null);
    setDoc("");
    loadedDoc = null;
    $("example").value = "";
    pickerChoice = "";
    sidebar.close();
}

// the sidebar slides: the editor measures itself again when the slide ends
$("layout").addEventListener("transitionend", (event) => {
    if (event.propertyName === "grid-template-columns") editor.measure();
});

async function step() {
    const code = editor.getDoc();
    if (!isActive()) loadedDoc = code; // before the action: renders during it show this program
    await actions.step(code);
}

async function run() {
    const code = editor.getDoc();
    const fresh = !isActive();
    if (fresh) loadedDoc = code;
    // a program already loaded in the stepper is finished there; fast run starts new ones
    if (fresh && store.getState().fastRun) await actions.runFast(code);
    else await actions.run(code);
}

async function restart() {
    const code = editor.getDoc();
    loadedDoc = code;
    await actions.restart(code);
}

// ---------------------------------------------------------------- rendering

let lastMarker = "";
const PROMPT_PLACEHOLDER = $("repl-input").placeholder;

/** The dot and the word in the header: ready, running, paused or error. */
function statusView(state) {
    if (state.error) return { kind: "failed", text: state.error };
    if (state.running) return { kind: "running", text: "running" };
    if (state.busy) return { kind: "working", text: "working" };
    if (state.status === "paused" || state.status === "ready") {
        const stale = loadedDoc !== null && editor.getDoc() !== loadedDoc && !state.pausedAtPrompt;
        if (stale) return { kind: "paused", text: "paused, source edited: Restart to load it" };
        return { kind: "paused", text: state.machine?.breakpoint ? "paused at a breakpoint" : "paused" };
    }
    if (state.status === "error") return { kind: "error", text: "error" };
    if (state.status === "exit") return { kind: "exit", text: "exited" };
    return { kind: "ready", text: "ready" };
}

function markerFor(state) {
    const line = state.fast ? state.fast.line : state.machine?.line;
    if (!line || state.status === "idle" || state.status === "ready" || state.pausedAtPrompt) return null;
    return { line, kind: state.status };
}

/** An icon of a stack was pressed: its line is shown under the prompt and evaluated like typed text. */
async function runStackOperation(name, op) {
    const find = () => store.getState().machine?.stacks.find((s) => s.name === name);
    const before = find();
    await actions.evaluate(stackOperationCode(name, op));
    // a named stack can leave the list without having been deleted: say why
    if (name === "" || find() || !before) return;
    toast(before.origin === "shadows"
        ? `${name} is back to the library's own definition, so it is no longer listed here. It is still under "Library and kernel stacks".`
        : `${name} is empty, so it is not shown.`, { ms: 6000 });
}

function show(container, node) {
    container.replaceChildren(...(node ? [node] : []));
    container.hidden = !node;
}

function render(state) {
    $("version").textContent = state.version ? `Bo runtime ${state.version}` : "";
    // hints asked for so far: the puzzle runtime counts them on a hidden stack
    const stackDepth = (name) => state.machine?.stacks.find((s) => s.name === name)?.depth;
    const hintsUsed = stackDepth("puzzle.hint-shown") ?? stackDepth("puzzle.hint-used") ?? 0;
    show($("puzzle-goal"), puzzleGoalPanel(
        state.puzzleTitle, state.puzzleGoal, state.puzzleDescription, state.puzzleHints, state.puzzleFreeHints, hintsUsed));

    const status = statusView(state);
    $("status").className = `status ${status.kind}`;
    $("status").textContent = status.text;

    show($("echo"), echoPanel(state, loadedDoc?.split("\n")));
    show($("output"), outputPanel(state.output));
    $("clear-row").hidden = $("echo").hidden && $("output").hidden;
    $("output").scrollTop = $("output").scrollHeight;

    $("next").replaceChildren(nextPanel(state));
    $("frames").replaceChildren(framesPanel(state.machine));
    const stacks = state.stacksShown ? stacksPanel(state.machine, state.previous,
        { onOperation: runStackOperation, disabled: state.busy || !state.ready },
        state.hiddenStacks, state.hiddenStackPrefixes) : null;
    show($("stacks"), stacks);
    $("stacks-heading").hidden = !stacks;
    $("content").classList.toggle("has-stacks", Boolean(stacks)); // the space above the title shrinks
    $("library").replaceChildren(...[libraryResults(state.library, actions)].filter(Boolean));

    const waiting = state.busy && !state.running;
    $("step").disabled = state.busy || !state.ready;
    $("run").disabled = state.busy || !state.ready;
    $("run").classList.toggle("fast", state.fastRun);
    $("run").title = state.fastRun ? "Run to the end, fast (Ctrl+Enter)" : "Run to the end (Ctrl+Enter)";
    $("restart").disabled = state.busy || !state.ready;
    $("abort").disabled = state.busy || !isActive();
    $("stop").disabled = !state.running;
    $("mode").disabled = state.busy;
    $("example").disabled = state.busy;
    $("repl-input").disabled = state.busy || !state.ready;
    // a paused program (a breakpoint, or a step) makes the prompt a debugger: what is typed runs at the pause point
    const debugging = ["paused", "ready"].includes(state.status);
    $("repl").classList.toggle("debugging", debugging);
    $("repl-input").placeholder = promptPlaceholder(state, PROMPT_PLACEHOLDER);
    $("send").disabled = state.busy || !state.ready;
    $("plus").disabled = state.busy || !state.ready;
    $("kill").hidden = !(waiting && Date.now() - state.busySince > 3000);
    $("menu-fast").setAttribute("aria-checked", String(state.fastRun));

    const marker = markerFor(state);
    const key = marker ? `${marker.line}:${marker.kind}:${state.machine?.steps}` : "";
    if (key !== lastMarker) {
        lastMarker = key;
        editor.mark(marker);
    }
}

store.subscribe(render);
// the busy-too-long button depends on time, not on state changes
setInterval(() => {
    const state = store.getState();
    if (state.busy && !state.running) render(state);
}, 500);

// ---------------------------------------------------------------- controls

$("step").addEventListener("click", step);
$("run").addEventListener("click", run);
$("stop").addEventListener("click", () => actions.stop());
$("restart").addEventListener("click", restart);
$("abort").addEventListener("click", () => actions.abort());
$("kill").addEventListener("click", () => actions.kill());
$("mode").addEventListener("change", (event) => actions.setMode(event.target.value));
$("stdin").addEventListener("change", (event) => actions.setInput(event.target.value));
$("stdin-clear").addEventListener("click", () => {
    $("stdin").value = "";
    actions.setInput("");
    $("stdin").focus();
});
$("editor-clear").addEventListener("click", () => {
    onboardingActivity();
    setDoc("");
    render(store.getState());
    editor.focus();
});
$("clear").addEventListener("click", () => {
    actions.clearOutput();
    $("repl-input").focus();
});

window.addEventListener("keydown", (event) => {
    if (event.key === "F10" && !event.defaultPrevented) {
        event.preventDefault();
        step();
    }
});

let filterTimer = 0;
$("library-filter").addEventListener("input", (event) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => actions.setLibraryFilter(event.target.value), 150);
});
$("library-box").addEventListener("toggle", (event) => actions.setLibraryOpen(event.target.open));

// ---------------------------------------------------------------- prompt

const safeSessionStorage = () => {
    try {
        return window.sessionStorage;
    } catch (error) {
        return null; // blocked: the history then only lives in memory
    }
};
const promptHistory = createHistory(safeSessionStorage());
const promptInput = $("repl-input");
promptInput.addEventListener("input", onboardingActivity);

$("repl").addEventListener("submit", async (event) => {
    onboardingActivity();
    event.preventDefault();
    const code = promptInput.value;
    if (!code.trim()) return;
    promptHistory.add(code);
    promptInput.value = ""; // the text moves below the prompt, which is free for the next one
    const exited = await actions.evaluate(code);
    if (typeof exited === "number") {
        await startFresh();
        toast(`Exited with status ${exited}. Everything is empty.`);
    }
    promptInput.focus();
});

promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        promptInput.value = "";
        promptHistory.reset();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const text = event.key === "ArrowUp" ? promptHistory.previous(promptInput.value) : promptHistory.next();
        if (text === null) return;
        event.preventDefault();
        promptInput.value = text;
        promptInput.setSelectionRange(text.length, text.length);
    }
});

// ---------------------------------------------------------------- the "+" menu

function loadStdin(text, message) {
    $("stdin").value = text;
    $("stdin-box").open = text !== "";
    actions.setInput(text);
    if (message) toast(message);
}

$("upload").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = ""; // the same file can be chosen again
    if (!file) return;
    if (file.size > MAX_UPLOAD) {
        toast(`${file.name} is larger than ${MAX_UPLOAD / 1024 / 1024} MB; choose a smaller file.`);
        return;
    }
    loadStdin(await file.text(), `Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB) into standard input.`);
});

async function share() {
    const program = editor.getDoc();
    if (!program.trim()) return toast("The editor is empty: there is nothing to share.");
    const base = `${location.origin}${location.pathname}${location.search}`;
    const link = await shareLink(base, { program, input: $("stdin").value });
    try {
        await navigator.clipboard.writeText(link);
        const kb = (link.length / 1024).toFixed(1);
        toast(`Link copied: the editor's program${$("stdin").value ? " and the standard input" : ""} (${kb} KB).` +
              (link.length > 8000 ? " It is long; some apps may cut it." : ""), { ms: 6000 });
    } catch (error) {
        window.prompt("Copy this link:", link); // no clipboard access
    }
}

function toggleFastRun() {
    const on = !store.getState().fastRun;
    actions.setFastRun(on);
    remember.set("bo-fast-run", on ? "1" : "0");
    toast(on ? "Fast run on: Run starts programs without the stepper. Stop restarts the machine."
             : "Fast run off: Run steps through the program again.", { ms: 5000 });
}

createMenu({
    button: $("plus"),
    menu: $("menu"),
    async onChoose(action) {
        if (action === "onboarding") startGuide();
        else if (action === "upload") $("upload").click();
        else if (action === "clear") {
            if (!(await beforeAction("clear"))) return;
            await startFresh();
            toast("Everything is reset.");
        } else if (action === "fast") toggleFastRun();
        else if (action === "editor") {
            if (sidebar.isOpen()) sidebar.close();
            else openEditor({ focus: true });
        } else if (action === "share") {
            if (await beforeAction("share")) share();
        }
    },
});
$("plus").addEventListener("click", onboardingActivity);
$("onboarding-start").addEventListener("click", () => startGuide());
$("onboarding-dismiss").addEventListener("click", () => onboarding?.dismiss());
$("onboarding-skip").addEventListener("click", () => onboarding?.dismiss());
$("onboarding-back").addEventListener("click", () => onboarding?.back());
$("onboarding-next").addEventListener("click", () => onboarding?.next());
$("onboarding-helper").addEventListener("click", async () => {
    const { helper } = describeStep(onboarding.getState().step, onboardingContext());
    if (helper?.action === "fill") {
        promptInput.value = EXPRESSION;
        promptInput.focus();
    } else if (helper?.action === "run") {
        await actions.evaluate(EXPRESSION);
    }
});

if (remember.get("bo-fast-run") === "1") actions.setFastRun(true);

// ---------------------------------------------------------------- examples

for (const example of EXAMPLES) {
    const option = document.createElement("option");
    option.value = example.file;
    option.textContent = example.title;
    $("examples").append(option);
}

$("example").addEventListener("change", async (event) => {
    onboardingActivity();
    const choice = event.target.value;
    if (!choice) return;
    // an application may want to ask first (Playground+ does while a recorded puzzle is being played)
    if (!(await beforeAction("load"))) {
        $("example").value = pickerChoice;
        return;
    }
    pickerChoice = choice;
    if (choice === "own") {
        actions.setHiddenStacks([]);
        actions.setHiddenStackPrefixes([]);
        actions.setPuzzleGoal(null);
        actions.setPuzzleDescription(null);
        actions.setPuzzleHints(0);
        actions.setPuzzleTitle(null);
        if (!userEdited) setDoc(""); // an example is replaced; text the user wrote stays
        openEditor({ focus: true });
        return;
    }
    if (choice.startsWith("puzzle:")) {
        const puzzle = puzzles.get(choice.slice("puzzle:".length));
        sidebar.close();
        loadStdin("");
        actions.setHiddenStacks(puzzle.hiddenStacks ?? []);
        actions.setHiddenStackPrefixes(["puzzle."]);
        actions.setPuzzleGoal(puzzle.goal);
        actions.setPuzzleDescription(puzzle.description || null);
        actions.setPuzzleHints(puzzle.hints, puzzle.freeHints);
        actions.setPuzzleTitle(puzzle.title);
        const code = puzzle.source;
        setDoc(code);
        loadedDoc = null;
        await actions.setup(code);
        promptInput.focus();
        toast("Puzzle ready: enter a value at the prompt, then run guess.", { ms: 6000 });
        return;
    }
    const example = EXAMPLES.find((e) => e.file === choice);
    const input = example.input ? await fetchText(new URL(`expected/${example.input}`, examplesUrl)) : "";
    loadStdin(input);
    actions.setHiddenStacks([]);
    actions.setHiddenStackPrefixes([]);
    actions.setPuzzleGoal(null);
    actions.setPuzzleDescription(null);
    actions.setPuzzleHints(0);
    actions.setPuzzleTitle(null);
    setDoc(sources[`examples/${example.file}`]);
    loadedDoc = null;
    await actions.reset();
    openEditor({ focus: true });
});

/**
 * Adds a puzzle to the picker (at the top of its group when `first`, as for one that just arrived). The
 * playground's own puzzles are "Practice puzzles"; those a provider marks `recorded` (Playground+'s,
 * written for the player) are "New puzzles", or "Past puzzles" once played (`played`).
 */
function addPuzzle(puzzle, { first = false } = {}) {
    puzzles.set(puzzle.id, puzzle);
    const option = document.createElement("option");
    option.value = `puzzle:${puzzle.id}`;
    option.textContent = puzzle.title;
    const group = $(puzzle.recorded || puzzle.played ? (puzzle.played ? "past" : "puzzles") : "practice");
    group.hidden = false;
    if (first) group.prepend(option);
    else group.append(option);
}

// ---------------------------------------------------------------- start

try {
    for (const name of EXAMPLES.map((e) => e.file))
        sources[`examples/${name}`] = await fetchText(new URL(name, examplesUrl));
    const provided = await puzzleProvider.load();
    Object.assign(sources, provided.files);
    for (const puzzle of provided.puzzles) addPuzzle(puzzle);
    actions.setFiles(sources);
    // a provider may announce puzzles that arrive while the page is open
    puzzleProvider.subscribe?.((puzzle) => {
        addPuzzle(puzzle, { first: true });
        toast(`New puzzle: ${puzzle.title}`, { ms: 8000 });
    });
} catch (error) {
    // the page still works without the examples (for instance when only playground/ is served)
    for (const option of $("example").options) if (option.value && option.value !== "own") option.disabled = true;
    console.warn(`examples are not available: ${error.message}`);
}

/** Loads the program in a share link (the URL fragment) into the editor, without running it. */
async function loadShared() {
    const shared = await readShare(location.hash);
    if (!shared) return;
    setDoc(shared.program, true);
    loadStdin(shared.input);
    window.history.replaceState(null, "", `${location.pathname}${location.search}`);
    openEditor();
    toast("Loaded a shared program into the editor. Step or Run to try it.", { ms: 6000 });
}
// a link pasted into a tab that already shows the playground only changes the fragment
window.addEventListener("hashchange", loadShared);
await loadShared();

await actions.start();
render(store.getState());
promptInput.focus();

// ---------------------------------------------------------------- the optional guide

const narrow = window.matchMedia("(max-width: 600px)");
let tourTarget = null; // the element the current step points at
let tourArrow = null; // where the arrow stands on it: {side, along}, or null for none
let tourKey = ""; // what the card shows, so that it is only rewritten when it changes
let arrowKey = ""; // where the arrow stands, so that it is only moved when that changes
let arrowFrame = 0;

function onboardingContext() {
    const state = store.getState();
    return {
        stackItems: state.machine?.stacks?.[0]?.depth ?? 0,
        stackVisible: state.stacksShown,
        editorOpen: sidebar.isOpen(),
        puzzleActive: Boolean(state.puzzleGoal),
    };
}

function hideArrow() {
    $("onboarding-arrow").hidden = true;
    arrowKey = "";
}

/**
 * Stands the small arrow beside the target, and puts the card where it covers neither. On a phone the card is a
 * sheet at the bottom and there is no arrow.
 */
function placeArrow() {
    const card = $("onboarding");
    const box = tourTarget?.getBoundingClientRect();
    if (card.hidden || narrow.matches || !box || box.width < 2 || box.height < 2) {
        card.style.left = "";
        return hideArrow();
    }
    // centred on the page beside the editor, not on the window, so that the card never covers the sidebar
    const page = document.querySelector(".page").getBoundingClientRect();
    const half = card.offsetWidth / 2 + 8;
    const middle = Math.min(Math.max(page.left + page.width / 2, half), window.innerWidth - half);
    card.style.left = `${Math.round(middle)}px`;

    const view = { width: window.innerWidth, height: window.innerHeight };
    const placement = tourArrow ? arrowPlacement(box, tourArrow.side, view, { along: tourArrow.along }) : null;
    const region = placement ? union(box, arrowRect(placement)) : box;
    card.classList.toggle("at-top", cardPlacement(region, view.height, card.getBoundingClientRect()) === "top");
    if (!placement) return hideArrow();

    const key = `${placement.x},${placement.y},${placement.rotate}`;
    if (key !== arrowKey) {
        const arrow = $("onboarding-arrow");
        arrow.style.left = `${placement.x}px`;
        arrow.style.top = `${placement.y}px`;
        arrow.style.transform = `translate(-50%, -50%) rotate(${placement.rotate}deg)`;
        arrowKey = key;
    }
    $("onboarding-arrow").hidden = false;
}

// the page moves under the arrow (the editor slides, the stacks appear), so it follows frame by frame
function followArrow() {
    placeArrow();
    arrowFrame = requestAnimationFrame(followArrow);
}

function renderOnboarding(state) {
    const active = state.phase === "active";
    $("onboarding-invite").hidden = state.phase !== "invited";
    $("onboarding").hidden = !active;
    if (!active) {
        cancelAnimationFrame(arrowFrame);
        arrowFrame = 0;
        tourTarget = null;
        tourArrow = null;
        tourKey = "";
        hideArrow();
        return;
    }
    const step = describeStep(state.step, onboardingContext());
    const key = JSON.stringify([state.step, step]);
    tourTarget = document.querySelector(step.target);
    tourArrow = step.arrow;
    if (key !== tourKey) {
        const newStep = !tourKey.startsWith(`[${state.step},`);
        tourKey = key;
        $("onboarding-progress").textContent = `Step ${state.step + 1} of ${STEP_COUNT}`;
        $("onboarding-title").textContent = step.title;
        $("onboarding-body").textContent = step.body;
        $("onboarding-helper").hidden = !step.helper;
        $("onboarding-helper").textContent = step.helper?.label ?? "";
        $("onboarding-back").hidden = state.step === 0;
        $("onboarding-next").textContent = state.last ? "Done" : "Next";
        if (newStep) tourTarget?.scrollIntoView({ block: "nearest" });
    }
    if (!arrowFrame) followArrow();
}

/**
 * Starts the guide from the very beginning, so a replay finds an empty stack again. The stacks and output are
 * emptied, except where that would cost the visitor something: during a puzzle, or while a program is paused.
 */
async function startGuide() {
    const state = store.getState();
    if (state.stacksShown && !state.puzzleGoal && !isActive()) {
        await actions.clearStacks();
        actions.clearOutput();
    }
    onboarding.start();
}

onboarding = createOnboarding({ onChange: renderOnboarding });
renderOnboarding(onboarding.getState());
// the steps follow the page: a stack that fills, the editor that opens
store.subscribe(() => renderOnboarding(onboarding.getState()));
window.setTimeout(() => onboarding.invite(), 5000);
