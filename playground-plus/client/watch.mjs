// The "Watch an agent play" button and what it opens. The player picks a model and a puzzle they have already
// played (never a new one: that would spoil it), or an earlier run to replay. A new run can be watched in two
// ways, and the player can go from one to the other: in the playground page itself (the agent's lines are typed
// into the prompt and run by the page's own machine, so the stacks move as when a person plays, with a banner
// above the puzzle), or as text in a dialog (monitoring, which leaves the page to the player). A replay is
// always in the page. The agent runs on the server (see agent-player.mjs) and only a run that ends on its own
// is recorded there; the page only shows it, and records nothing.
import { confirmDialog, showDialog } from "./dialog.mjs";
import { createStepPlayer } from "./stage.mjs";

const STYLE_ID = "plus-watch-style";
const STYLE = `
.plus-watch-button { font: inherit; font-size: 0.85rem; font-weight: 600; padding: 0.35rem 0.8rem; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border, #d9dde5); background: transparent; color: var(--text, #1d2330); white-space: nowrap; }
.plus-watch-button:hover { background: var(--hover, rgba(20, 30, 60, 0.07)); }
.plus-watch-button:focus-visible { outline: 2px solid var(--accent, #3b6fd4); outline-offset: 2px; }
.plus-watch-button[data-playing] { border-style: dashed; border-color: var(--accent, #3b6fd4); color: var(--accent, #3b6fd4); }
.plus-watch-button[data-playing]::before { content: ""; display: inline-block; width: 0.5em; height: 0.5em; margin-right: 0.45em; border-radius: 50%;
    background: var(--accent, #3b6fd4); animation: plus-pulse 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .plus-watch-button[data-playing]::before { animation: none; } }
.plus-watch .plus-pick { display: flex; align-items: center; gap: 0.5rem; margin: 0.25rem 0 0.5rem 1.55rem; }
.plus-watch .plus-pick label { min-width: 4rem; }
.plus-watch .plus-pick select { flex: 1; min-width: 0; font: inherit; padding: 0.25rem 0.4rem; border-radius: 6px; border: 1px solid var(--border, #d9dde5); background: var(--bg, #f6f7f9); color: inherit; }
.plus-watch fieldset { border: 0; margin: 0 0 0.7rem; padding: 0; }
.plus-watch legend { font-weight: 600; margin-bottom: 0.3rem; padding: 0; }
.plus-watch .plus-how { display: block; margin: 0.15rem 0; }
.plus-watch .plus-how small { display: block; margin-left: 1.55rem; opacity: 0.75; }
.plus-watch [disabled], .plus-watch label:has([disabled]) { opacity: 0.55; }
.plus-watch .plus-note { opacity: 0.75; font-size: 0.85rem; }
.plus-watch p { margin: 0 0 0.7rem; }
.plus-watch-status { font-variant-numeric: tabular-nums; }
.plus-watch-status strong, .plus-stage-status strong { font-weight: 700; }
.plus-watch-result { font-weight: 600; }
.plus-watch-log { font: 0.82rem/1.45 var(--mono, ui-monospace, monospace); background: var(--bg, #f6f7f9); border: 1px solid var(--border, #d9dde5);
    border-radius: 8px; padding: 0.6rem; height: 40vh; overflow: auto; }
.plus-watch-log div { white-space: pre-wrap; overflow-wrap: anywhere; }
.plus-watch-log .plus-line-code { font-weight: 700; margin-top: 0.5rem; }
.plus-watch-log .plus-line-code:first-child { margin-top: 0; }
.plus-watch-log .plus-line-stack { opacity: 0.65; }
.plus-watch-log .plus-line-err { color: var(--danger, #b3261e); }
.plus-watch-log .plus-line-say, .plus-watch-log .plus-line-note { font-family: var(--sans, system-ui, sans-serif); font-style: italic; opacity: 0.8; margin-top: 0.5rem; }
.plus-watch-log .plus-line-empty { opacity: 0.6; }
.plus-watch-log details.plus-line-think { margin-top: 0.5rem; font-family: var(--sans, system-ui, sans-serif); font-style: italic; opacity: 0.8; }
.plus-watch-log details.plus-line-think summary { cursor: pointer; }
.plus-watch-log details.plus-line-think div { margin: 0.25rem 0 0 1rem; }
.plus-stage { margin: 0 0 0.7rem; text-align: left; font-size: 0.85rem; color: var(--text, #1d2330); }
.plus-stage-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 1rem; }
.plus-stage-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.5rem; }
.plus-stage button { font: inherit; font-size: 0.85rem; padding: 0.3rem 0.9rem; border-radius: 999px; border: 1px solid var(--border, #d9dde5); background: var(--bg, #f6f7f9); color: inherit; cursor: pointer; }
.plus-stage button:hover { background: var(--hover, rgba(20, 30, 60, 0.07)); }
.plus-stage button:focus-visible, .plus-stage select:focus-visible { outline: 2px solid var(--accent, #3b6fd4); outline-offset: 2px; }
.plus-stage button.danger { color: var(--danger, #b3261e); border-color: var(--danger, #b3261e); }
.plus-stage select { font: inherit; font-size: 0.85rem; padding: 0.3rem 0.7rem; border-radius: 999px; border: 1px solid var(--border, #d9dde5); background: var(--panel, #fff); color: inherit; cursor: pointer; }
@keyframes plus-stage-pulse { 50% { border-color: var(--accent, #3b6fd4); box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent, #3b6fd4) 40%, transparent); } }
.plus-stage button.plus-pulse { animation: plus-stage-pulse 0.8s ease-in-out 2; }
@media (prefers-reduced-motion: reduce) { .plus-stage button.plus-pulse { animation: none; border-color: var(--accent, #3b6fd4); } }
.plus-stage-status { font-variant-numeric: tabular-nums; color: var(--muted, inherit); }
`;

const POLL_MS = 1000;
const SPEED_LABELS = { real: "Real time", compressed: "Compressed", fast: "Fast" };
const clock = (ms) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const minutes = (ms) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`;

/** One entry of the puzzle list: its title, how hard, and how often an agent tried it. */
export function describePuzzle({ title, difficulty, agentAttempts }) {
    return `${title}${difficulty ? ` · difficulty ${difficulty}` : ""}${agentAttempts ? ` · agents tried it ${agentAttempts}×` : ""}`;
}

const OUTCOME_WORDS = { solved: "solved", revealed: "gave up", abandoned: "not solved" };
/** One entry of the list of runs to replay: "gemma4:12b on “Shuffle #1” · solved · 0:14". */
export function describeRun({ model, title, outcome, seconds }) {
    return `${model} on “${title}” · ${OUTCOME_WORDS[outcome] ?? outcome} · ${clock(seconds * 1000)}`;
}

/**
 * What the agent is doing, for the status line, as `[text, bold]` parts: only the time is bold.
 * "gemma4:12b is playing “Shuffle #1” · **0:42** · turn 3 of 20". For a replay, `shownMs` is the time to show:
 * the original time of the step being played (see `replayClock`), or the length of the run once it is over.
 */
export function statusParts(job, now = Date.now()) {
    const title = `“${job.puzzle?.title ?? "the puzzle"}”`;
    if (job.replay) {
        return [[`${job.state === "running" ? `Replaying ${job.model} on` : `${job.model} on`} ${title} · `, false], [clock(job.shownMs ?? 0), true]];
    }
    if (job.state === "running") {
        const doing = job.turn === 0 ? "getting ready (the first time can take a minute or two)" : `playing ${title}`;
        return [[`${job.model} is ${doing} · `, false], [clock(now - job.startedAt), true], ...(job.turn ? [[` · turn ${job.turn} of ${job.maxTurns}`, false]] : [])];
    }
    const took = job.endedAt ? [[" · ", false], [clock(job.endedAt - job.startedAt), true]] : [];
    if (job.state === "cancelled") return [[`${job.model} was stopped on ${title}`, false], ...took];
    if (job.state === "failed") return [[`${job.model} could not play ${title}`, false]];
    return [[`${job.model} on ${title}`, false], ...took];
}

/** The same as one string, for a message. */
export const describeAgentJob = (job, now = Date.now()) => statusParts(job, now).map(([text]) => text).join("");

/**
 * The time to show for a replay. At real time it runs on from the original time of the step last played, so
 * that it moves while the agent "thinks"; at the other speeds a running timer would mean nothing (the waits
 * are shortened), so it stays at the original time of the step, which is when the agent did it.
 */
export function replayClock({ speed, at, since }, now) {
    return speed === "real" ? at + Math.max(now - since, 0) : at;
}

/** The result as one sentence, for the end of the transcript and the toast. */
export function describeOutcome(job) {
    if (job.state === "cancelled") return "Stopped. Nothing was recorded.";
    if (job.state === "failed") return `${job.message ?? "The model could not be used."} Nothing was recorded.`;
    if (job.outcome === "solved") return `Solved it. ${job.message.replace(/^Solved it\s*/, "").replace(/^with/, "It used")}`.trim();
    return `Not solved: ${(job.message ?? "").replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}. This counts as a failure.`;
}

/** What a recorded run says about itself, in the shape `describeOutcome` reads. */
export function runAsJob(run) {
    const message = run.outcome === "solved" ? `Solved it with ${run.guesses} ${run.guesses === 1 ? "guess" : "guesses"} and ${run.hints} ${run.hints === 1 ? "hint" : "hints"}.`
        : run.outcome === "revealed" ? "Gave up and asked for the answer."
            : "Did not finish: it ran out of time or turns, or it left the puzzle.";
    return { state: "finished", outcome: run.outcome, message };
}

/** A step of a recorded run in the shape of a live one: what was said is in `code` there, `text` here. */
export const liveStep = (step) => (step.kind === "say" || step.kind === "think" ? { ...step, text: step.code } : step);

/** The transcript lines of one step: `[{kind, text}]`, in the order they are shown. */
export function stepLines(step) {
    if (step.kind === "say") return [{ kind: "say", text: step.text }];
    if (step.kind === "think") return [{ kind: "think", text: step.text }];
    if (step.kind === "lookup") return [{ kind: "note", text: `looked up “${step.code}” in the documentation` }];
    if (step.kind === "give-up") return [{ kind: "note", text: "gave up and asked for the answer" }];
    return [
        { kind: "code", text: `› ${step.code}` },
        ...(step.output ? [{ kind: "out", text: step.output }] : []),
        ...(step.error ? [{ kind: "err", text: step.error }] : []),
        ...(step.stack ? [{ kind: "stack", text: step.stack }] : []),
    ];
}

/** Puts `[text, bold]` parts into `node`: plain text, with the bold ones (the times) in <strong>. */
function setParts(doc, node, parts) {
    node.replaceChildren(...parts.map(([text, bold]) => {
        if (!bold) return doc.createTextNode(text);
        const strong = doc.createElement("strong");
        strong.textContent = text;
        return strong;
    }));
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
 * Adds the button. `page` drives the playground page (see page-control.mjs); `notify(text)` shows a short
 * message. Returns {button, restore}: `restore()` picks up an agent that is still playing (after a reload).
 */
export function createWatch({ api, page, doc = document, now = Date.now, notify = () => {} }) {
    if (!doc.getElementById(STYLE_ID)) doc.head.append(element(doc, "style", { id: STYLE_ID }, STYLE));
    const window = doc.defaultView;
    const button = element(doc, "button", { type: "button", class: "plus-watch-button", title: "Watch a local model try a puzzle you have played" }, "Watch an agent play");
    let job = null; // the latest job from the server, with all its steps so far
    let timer = null;
    let epoch = 0; // bumped when polling stops, so that a request in flight is ignored
    let live = null; // the open transcript dialog: {update(job), close(value)}
    let stage = null; // what is being shown in the page: {player, banner, live, ...}
    let speed = "real"; // the replay speed the player chose last

    const render = () => {
        const playing = job?.state === "running";
        button.toggleAttribute("data-playing", playing || (stage !== null && !stage.over));
        button.textContent = playing ? "An agent is playing" : stage && !stage.over ? "Watching an agent" : "Watch an agent play";
        button.title = playing ? "A local model is playing a puzzle: open to watch it, or to stop it" : "Watch a local model try a puzzle you have played";
    };
    const tell = (title, text) => showDialog({ title, body: text, doc, buttons: [{ label: "OK", value: true, kind: "primary" }] });

    // ---- the banner above the puzzle

    function openBanner() {
        const status = element(doc, "span", { class: "plus-stage-status" });
        const controls = new Map(); // the buttons by their `key`
        const actions = element(doc, "span", { class: "plus-stage-actions" });
        const node = element(doc, "div", { class: "plus-stage", role: "status" }, element(doc, "div", { class: "plus-stage-row" }, actions, status));
        const goal = doc.getElementById("puzzle-goal");
        if (goal?.parentElement) goal.before(node);
        else doc.body.prepend(node);
        return {
            node,
            /** The status line, as `[text, bold]` parts. */
            setStatus: (parts) => setParts(doc, status, parts),
            /** `{label, kind, onClick}` buttons, or `{select: {value, options: [[value, label]], onChange}}`. */
            setControls(list) {
                controls.clear();
                actions.replaceChildren(...list.map((control) => {
                    if (control.select) {
                        const menu = element(doc, "select", { "aria-label": control.select.label }, ...control.select.options.map(([value, label]) => element(doc, "option", { value, selected: value === control.select.value }, label)));
                        menu.addEventListener("change", () => control.select.onChange(menu.value));
                        return menu;
                    }
                    const item = element(doc, "button", { type: "button", class: control.kind ?? "" }, control.label);
                    item.addEventListener("click", control.onClick);
                    if (control.key) controls.set(control.key, item);
                    return item;
                }));
            },
            /** Makes a button (by its `key`) pulse a couple of times, to say it is what the player has to press. */
            pulse(key) {
                const item = controls.get(key);
                if (!item) return;
                item.classList.remove("plus-pulse");
                void item.offsetWidth; // so that the animation starts again if it was running
                item.classList.add("plus-pulse");
            },
            remove: () => node.remove(),
        };
    }

    function endStage() {
        if (!stage) return;
        window.clearInterval(stage.clock);
        if (stage.guard) doc.removeEventListener("pointerdown", stage.guard, true);
        stage.player.stop();
        stage.banner.remove();
        page.lock(false);
        stage = null;
        render();
    }

    /** Loads the puzzle into the page, takes it over, and shows the banner; false if the player declined to leave their puzzle. */
    async function beginStage({ puzzleId, model, title, liveRun }) {
        if (!(await page.loadPuzzle(puzzleId))) return false;
        const banner = openBanner();
        page.lock(true, banner.node);
        const current = {
            banner, over: false, live: liveRun, played: 0, total: 0, pushed: 0, model, title, startedAt: now(), asText: null, textView: null,
            mark: { at: 0, since: now() }, finalMs: null, // a replay's time: the original time of the step last played, and when that was
            player: createStepPlayer({
                page, speed,
                onStep(step) {
                    current.played++;
                    if (!current.live && step.at !== undefined) current.mark = { at: step.at, since: now() };
                    if (current.asText) { // the replay's transcript grows as the replay goes
                        current.asText.steps.push(step);
                        current.asText.stepCount = current.asText.steps.length;
                        current.textView?.refresh(current.asText);
                    }
                    refreshBanner();
                },
            }),
            clock: window.setInterval(() => refreshBanner(), 1000), // the time moves between the server's updates
        };
        stage = current;
        refreshBanner();
        render();
        return true;
    }

    /** The time a replay shows now: real time ticks on from the last step, the other speeds show when that step happened. */
    const replayTime = (s) => s.finalMs ?? replayClock({ speed, at: s.mark.at, since: s.mark.since }, now());

    function refreshBanner() {
        if (!stage || stage.over) return;
        if (stage.live) {
            if (job) stage.banner.setStatus([["Watching: ", false], ...statusParts(job, now())]);
        } else {
            stage.banner.setStatus([[`Replaying ${stage.model} on “${stage.title}” · step ${Math.min(stage.played, stage.total)} of ${stage.total} · `, false], [clock(replayTime(stage)), true]]);
        }
    }

    /**
     * Everything has been played: say how it went and what can be done next. The page stays taken over until the
     * player presses Close, which is not obvious, so the button pulses now and again at each click on the page.
     * `text` is a job to show as a transcript; `finalMs` the length of the run, for a replay.
     */
    function showResult(result, { replayRunId = null, text = null, finalMs = null } = {}) {
        if (!stage) return;
        stage.over = true;
        stage.finalMs = finalMs;
        window.clearInterval(stage.clock);
        if (stage.asText) {
            Object.assign(stage.asText, result, { state: "finished", endedAt: now() });
            stage.textView?.refresh(stage.asText);
        }
        stage.banner.setStatus([[`${stage.model} on “${stage.title}”: ${describeOutcome(result)} Press Close to get the page back.`, false]]);
        stage.banner.setControls([
            ...(replayRunId ? [{ label: "Replay", onClick: () => replayRun(replayRunId) }] : []),
            ...(text ? [{ label: "Show as text", onClick: () => transcriptDialog(text) }] : []),
            { label: "Close", key: "close", kind: "close", onClick: endStage },
        ]);
        const current = stage;
        current.guard = (event) => {
            if (!current.banner.node.contains(event.target) && !event.target.closest?.("dialog")) current.banner.pulse("close");
        };
        doc.addEventListener("pointerdown", current.guard, true);
        current.banner.pulse("close");
        render();
    }

    // ---- a live run

    function stopPolling() {
        if (timer !== null) window.clearInterval(timer);
        timer = null;
        epoch++;
    }
    function startPolling() {
        timer ??= window.setInterval(tick, POLL_MS);
    }
    async function tick() {
        const mine = epoch;
        let current;
        try {
            current = await api.agentPlayStatus(job?.stepCount ?? 0);
        } catch {
            return; // the server is busy or restarting: try again on the next beat
        }
        if (mine !== epoch) return;
        if (current.state === "idle") return forget();
        const same = job && job.id === current.id;
        job = { ...current, steps: [...(same ? job.steps : []), ...current.steps] };
        const watching = stage?.live ? stage : null;
        feed();
        live?.update(job);
        if (current.state === "running") return;
        stopPolling();
        render();
        if (watching) {
            await watching.player.idle();
            if (stage === watching) showResult(job, { replayRunId: job.sessionId, text: job });
        } else if (live) live.close("ended");
        else notify(`${describeAgentJob(job, now())}. ${describeOutcome(job)}`);
    }
    function forget() {
        stopPolling();
        job = null;
        endStage();
        render();
    }
    /** Gives the page's player the steps of the live run it has not been given yet (they are not waited for). */
    function feed() {
        if (!stage?.live || !job) return;
        stage.player.push(job.steps.slice(stage.pushed), { live: true });
        stage.pushed = job.steps.length;
    }

    async function stopLive() {
        stopPolling();
        endStage();
        const stopped = await api.cancelAgentPlay().catch(() => null);
        job = stopped?.state && stopped.state !== "idle" ? { ...stopped, steps: job?.steps ?? [] } : null;
        render();
        notify("Stopped. Nothing was recorded.");
    }

    /** The live run in the page: loads the puzzle, and (when joining a run under way) catches the page up at once. */
    async function showLiveInPage({ catchUp = false } = {}) {
        const shown = await beginStage({ puzzleId: job.puzzle.id, model: job.model, title: job.puzzle.title, liveRun: true });
        if (!shown) return false;
        stage.banner.setControls([
            { label: "Stop the agent", kind: "danger", onClick: stopLive },
            { label: "Switch to text", onClick: switchToText },
        ]);
        if (catchUp) {
            stage.player.push(job.steps, { instant: true });
            stage.pushed = job.steps.length;
        }
        feed();
        return true;
    }

    async function watchLive(choice) {
        job = { ...(await api.startAgentPlay({ puzzleId: choice.puzzleId, model: choice.model })), steps: [] };
        render();
        startPolling();
        if (choice.how === "text") return transcriptDialog(job);
        if (!(await showLiveInPage())) {
            await stopLive();
            notify("The agent was not started: you stayed on your puzzle.");
        }
    }

    /** From the page to the text: the page is the player's again, and the run goes on. */
    function switchToText() {
        endStage();
        return transcriptDialog(job);
    }

    /** From the text to the page: asks first, as it replaces what is on the page; a finished run is replayed instead. */
    async function switchToPage() {
        const sure = await confirmDialog({
            title: "Watch in the page?", doc, danger: false, confirmLabel: "Watch in the page", cancelLabel: "Cancel",
            body: "The playground page is taken over: what is on your prompt and stacks is replaced. If you are in the middle of a puzzle, you are asked first.",
        });
        if (!sure) return transcriptDialog(job);
        if (job.state === "running") {
            if (!(await showLiveInPage({ catchUp: true }))) notify("You stayed on your puzzle. The agent goes on playing.");
        } else if (job.sessionId) await replayRun(job.sessionId);
    }

    // ---- a recorded run

    async function replayRun(id) {
        endStage();
        const { run, steps } = await api.agentRun(id);
        const shown = await beginStage({ puzzleId: run.puzzleId, model: run.model, title: run.title, liveRun: false });
        if (!shown) return notify("The replay was not started: you stayed on your puzzle.");
        const mine = stage;
        mine.total = steps.length;
        refreshBanner();
        // the replay's transcript: it starts empty and gains each step as the replay plays it (see beginStage)
        const asText = {
            state: "running", replay: true, model: run.model, puzzle: { id: run.puzzleId, title: run.title }, startedAt: mine.startedAt, endedAt: null,
            steps: [], stepCount: 0, turn: 0, maxTurns: 0,
            get shownMs() { return replayTime(mine); },
        };
        mine.asText = asText;
        mine.banner.setControls([
            { label: "Stop", kind: "danger", onClick: endStage },
            { label: "Show as text", onClick: () => transcriptDialog(asText) },
            { select: { label: "Replay speed", value: speed, options: Object.entries(SPEED_LABELS), onChange: (value) => { speed = value; mine.player.setSpeed(value); } } },
        ]);
        mine.player.push(steps.map(liveStep));
        await mine.player.idle();
        if (stage === mine) showResult(runAsJob(run), { replayRunId: id, text: asText, finalMs: run.seconds * 1000 });
    }

    // ---- the transcript as text

    /** One line of the transcript. What a model thought is folded (it can be long): open it to read it. */
    function logLine(line) {
        if (line.kind !== "think") return element(doc, "div", { class: `plus-line-${line.kind}` }, line.text);
        const first = line.text.split("\n")[0];
        return element(doc, "details", { class: "plus-line-think", open: line.text.length <= 600 },
            element(doc, "summary", {}, `thinking: ${first.length > 90 ? `${first.slice(0, 90)}…` : first}`), element(doc, "div", {}, line.text));
    }

    /** The transcript: the status line, the lines as they come, and what the player can do. */
    function transcript(current) {
        const status = element(doc, "p", { class: "plus-watch-status", role: "status" });
        const log = element(doc, "div", { class: "plus-watch-log", role: "log", "aria-live": "polite", "aria-label": "What the agent does" });
        const result = element(doc, "p", { class: "plus-watch-result" });
        const empty = element(doc, "div", { class: "plus-line-empty" }, current.replay ? "Nothing has happened yet in the replay…" : "Waiting for the model's first move…");
        log.append(empty);
        let shown = 0;
        const refresh = (latest) => {
            setParts(doc, status, statusParts(latest, now()));
            const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
            for (const step of latest.steps.slice(shown)) {
                empty.remove();
                for (const line of stepLines(step)) log.append(logLine(line));
            }
            shown = latest.steps.length;
            if (latest.state !== "running") result.textContent = describeOutcome(latest);
            if (atEnd) log.scrollTop = log.scrollHeight;
        };
        refresh(current);
        const body = element(doc, "div", { class: "plus-watch" }, status, log, result,
            ...(current.state === "running" && !current.replay ? [element(doc, "p", { class: "plus-note" }, "Hiding this window keeps the agent playing, and the page stays yours. Stopping records nothing.")] : []));
        return { body, refresh };
    }

    async function transcriptDialog(current) {
        const view = transcript(current);
        const replay = Boolean(current.replay); // a recorded run being played again: its transcript grows with the replay
        const ticking = current.state === "running";
        const running = ticking && !replay; // a run that is going on, which can be stopped
        const clockTimer = ticking ? window.setInterval(() => view.refresh(replay ? current : job ?? current), 1000) : null;
        const controller = {};
        if (replay && stage?.asText === current) stage.textView = view;
        else live = running ? { update: view.refresh, close: (value) => controller.close?.(value) } : null;
        const replayable = !ticking && current.sessionId;
        const answer = await showDialog({
            title: replay ? "The replay as text" : running ? "What the agent does" : "How the agent played", doc, wide: true, controller, body: view.body,
            buttons: running
                ? [{ label: "Stop the agent", value: "stop", kind: "danger" }, { label: "Watch in the page", value: "page" }, { label: "Hide this window", value: "hide", kind: "primary" }]
                : [{ label: "Close", value: "close", kind: replayable ? "plain" : "primary" }, ...(replayable ? [{ label: "Replay in the page", value: "page", kind: "primary" }] : [])],
            cancelValue: running ? "hide" : "close", focusValue: running ? "hide" : "close",
        });
        window.clearInterval(clockTimer);
        if (replay) {
            if (stage?.textView === view) stage.textView = null;
        } else live = null;
        if (answer === "stop") await stopLive();
        else if (answer === "page") await switchToPage();
        else if (answer === "ended") return transcriptDialog(job); // finished while it was watched: show it again, finished
    }

    // ---- choosing

    /** The first dialog: a new run (which model, which of the played puzzles) or an earlier run to replay. */
    async function choose() {
        let info;
        let runs = [];
        try {
            [info, runs] = await Promise.all([api.agentPlayState(), api.agentRuns().catch(() => [])]);
        } catch {
            info = { available: false, reason: "The server could not be asked.", puzzles: [], models: [], job: { state: "idle" } };
        }
        if (info.job?.state === "running") {
            job = { ...info.job, steps: info.job.steps ?? [] };
            render();
            startPolling();
            return transcriptDialog(job);
        }
        const canPlay = info.available && info.puzzles.length > 0;
        if (!canPlay && !runs.length) {
            return info.available
                ? tell("Play a puzzle first", "An agent only plays puzzles you have already played, so that watching it never spoils one for you. Play one of the New puzzles, then come back.")
                : tell("No agent available", `${info.reason ?? "No local model is available."}`);
        }
        const select = (id, name, options, { disabled = false } = {}) => element(doc, "select", { id, name, disabled }, ...options);
        const model = select("plus-watch-model", "model", info.models.map((m) => element(doc, "option", { value: m.name, selected: m.name === info.model }, `${m.name}${m.parameterSize ? ` (${m.parameterSize})` : ""}`)), { disabled: !canPlay });
        const puzzle = select("plus-watch-puzzle", "puzzle", info.puzzles.map((p) => element(doc, "option", { value: p.id }, describePuzzle(p))), { disabled: !canPlay });
        const where = select("plus-watch-where", "where", [
            element(doc, "option", { value: "page" }, "In the playground page"),
            element(doc, "option", { value: "text" }, "As text, keeping the page for myself"),
        ], { disabled: !canPlay });
        const run = select("plus-watch-run", "run", runs.map((r) => element(doc, "option", { value: r.id }, describeRun(r))), { disabled: !runs.length || canPlay });
        const pick = (id, label, control) => element(doc, "div", { class: "plus-pick" }, element(doc, "label", { for: id }, label), control);
        const radio = (value, label, note, checked, disabled) => element(doc, "label", { class: "plus-how" },
            element(doc, "input", { type: "radio", name: "how", value, checked, disabled }), ` ${label}`, element(doc, "small", {}, note));
        const limits = info.limits ?? { maxTurns: 20, timeoutMs: 300_000 };
        const form = element(doc, "form", { class: "plus-watch" },
            element(doc, "p", {}, "A local model tries a puzzle you have already played. It gets what you got: the goal, a prompt, ", element(doc, "code", {}, "guess"), ", hints and the documentation, never the solution."),
            element(doc, "fieldset", {},
                radio("new", "Watch a new run", canPlay ? `Up to ${minutes(limits.timeoutMs)} and ${limits.maxTurns} turns; running out, or giving up, counts as a failure. It is added to the Agents table in My profile.` : info.reason ?? "Play a puzzle first.", canPlay, !canPlay),
                pick("plus-watch-model", "Model", model), pick("plus-watch-puzzle", "Puzzle", puzzle), pick("plus-watch-where", "Watch", where),
                radio("replay", "Replay an earlier run", runs.length ? "Shows a recorded run again in the page, at the pace it had or faster, without a model." : "No run was recorded yet.", !canPlay, !runs.length),
                pick("plus-watch-run", "Run", run)),
            element(doc, "p", { class: "plus-note" }, "Watching in the page takes it over, so what is on your prompt and stacks is replaced; if you are in the middle of a puzzle, you are asked first. You can switch between the page and the text while it plays."));
        form.addEventListener("submit", (event) => event.preventDefault());
        const how = () => form.querySelector('input[name="how"]:checked')?.value;
        form.addEventListener("change", () => {
            model.disabled = puzzle.disabled = where.disabled = how() !== "new";
            run.disabled = how() !== "replay";
        });
        const confirmed = await showDialog({
            title: "Watch an agent play", body: form, doc, width: "38rem",
            buttons: [{ label: "Cancel", value: false }, { label: "Watch", value: true, kind: "primary" }], cancelValue: false, focusValue: true,
        });
        if (!confirmed) return;
        if (how() === "replay") return replayRun(run.value);
        return watchLive({ puzzleId: puzzle.value, model: model.value, how: where.value });
    }

    button.addEventListener("click", async () => {
        try {
            if (stage && !stage.over) return; // the banner has the controls
            await choose();
        } catch (error) {
            await tell("The agent could not start", `Playground+ could not start it: ${error.detail ?? error.message}`);
        }
    });
    render();

    return {
        button,
        async restore() {
            try {
                const current = await api.agentPlayStatus(0);
                if (current.state === "running") {
                    job = current;
                    startPolling();
                }
            } catch {
                job = null;
            }
            render();
        },
    };
}
