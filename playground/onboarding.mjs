// The optional guide to the playground. This file is the DOM-free part: the phases, and what each step says
// and points at given what the page currently shows. Nothing is stored: the guide is always available from the
// "+" menu, and an idle visitor is only invited to start it.

export const EXPRESSION = "1 2 +";
export const STEP_COUNT = 5;

/**
 * What step `index` says and which element it points at, given the page's state:
 * `{stackItems, stackVisible, editorOpen, puzzleActive}`. `arrow` says where the small arrow stands: `side` is the
 * side of the target it stands on (it points back at the target), `along` where along that side (0 to 1, default
 * the middle); null for no arrow. `helper` is an optional button that does the step's example for the visitor
 * (`fill` puts the expression in the prompt, `run` evaluates it); it is never offered during a puzzle, where
 * running something else would disturb the play.
 */
export function describeStep(index, { stackItems = 0, stackVisible = false, editorOpen = false, puzzleActive = false } = {}) {
    const helper = (label, action) => (puzzleActive ? null : { label, action });
    switch (index) {
        case 0:
            return {
                target: "#repl",
                arrow: { side: "right" }, // beside the send button, at the right end of the prompt
                title: "Run some Bo",
                body: stackItems > 0
                    ? "Type Bo at the prompt and press Enter, or click the arrow button, to run it. Try as many expressions as you like."
                    : `Type ${EXPRESSION} at the prompt and press Enter, or click the arrow button, to run it.`,
                helper: stackItems > 0 ? null : helper(`Put ${EXPRESSION} in the prompt`, "fill"),
            };
        case 1: {
            const shown = stackVisible && stackItems > 0;
            return {
                target: stackVisible ? "#stacks .stack.wide" : "#repl",
                arrow: shown ? { side: "bottom", along: 0.8 } : null, // clear of the "Not shown" note at the left
                title: "Watch the default stack",
                body: stackItems > 0
                    ? "This is the default stack, with the most recent value (the top) on the left. Operations such as + take values from the top and put the result back. New or changed values are highlighted."
                    : "Values you push appear on the default stack, with the most recent (the top) on the left. It is empty for now.",
                helper: stackItems > 0 ? null : helper(`Run ${EXPRESSION} for me`, "run"),
            };
        }
        case 2:
            return editorOpen
                ? {
                    target: "#next",
                    arrow: { side: "right" },
                    title: "Step through a program",
                    body: "Write a program in the editor, then Run it or press Step to go one word at a time. This panel shows the word about to run, and Running below shows the programs being executed.",
                    helper: null,
                }
                : {
                    target: "#editor-toggle",
                    arrow: { side: "right" },
                    title: "Open the editor for longer programs",
                    body: "The editor can run a program in one go or step through it word by word, showing what is about to run.",
                    helper: null,
                };
        case 3:
            return {
                target: "#example",
                arrow: { side: "bottom" },
                title: "Choose a puzzle or an example",
                body: "Practice puzzles show their goal beside the prompt; examples open a longer program in the editor. The guide never loads anything for you.",
                helper: null,
            };
        default:
            return {
                target: "#repl",
                arrow: { side: "left" }, // beside the + button, at the left end of the prompt
                title: "Find this guide again here",
                body: "The + menu also uploads standard input, resets everything, toggles fast run and shares the editor's program. Start here replays this guide.",
                helper: null,
            };
    }
}

/** Stateless, DOM-independent state of the guide: waiting, invited, active or hidden. */
export function createOnboarding({ onChange = () => {} } = {}) {
    let phase = "waiting";
    let step = 0;
    const state = () => ({ phase, step, last: step === STEP_COUNT - 1 });
    const emit = () => onChange(state());

    return {
        getState: state,
        /** The idle visitor is offered the guide (only if nothing else happened first). */
        invite() {
            if (phase !== "waiting") return;
            phase = "invited";
            emit();
        },
        /** The visitor did something of their own, so the invitation is withdrawn; a running guide is left alone. */
        activity() {
            if (phase !== "waiting" && phase !== "invited") return;
            phase = "hidden";
            emit();
        },
        start() {
            phase = "active";
            step = 0;
            emit();
        },
        next() {
            if (phase !== "active") return;
            if (step === STEP_COUNT - 1) phase = "hidden";
            else step++;
            emit();
        },
        back() {
            if (phase !== "active" || step === 0) return;
            step--;
            emit();
        },
        dismiss() {
            phase = "hidden";
            emit();
        },
    };
}
