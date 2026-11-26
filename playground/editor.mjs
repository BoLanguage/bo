// The source editor: CodeMirror 6 (vendored in vendor/codemirror.js) with the Bo language and a
// marker on the line being executed.
import {
    EditorState, StateField, StateEffect, EditorView, Decoration, keymap, lineNumbers, drawSelection,
    syntaxHighlighting, classHighlighter, bracketMatching, defaultKeymap, history, historyKeymap, highlightActiveLine, bo,
} from "./vendor/codemirror.js";

const setMarker = StateEffect.define();

// One decorated line: `value` is {line, kind} with kind "paused" | "error" | "done" | "exit", or null.
const markerField = StateField.define({
    create: () => Decoration.none,
    update(decorations, transaction) {
        decorations = decorations.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (!effect.is(setMarker)) continue;
            const marker = effect.value;
            if (!marker) decorations = Decoration.none;
            else {
                const doc = transaction.state.doc;
                const line = doc.line(Math.min(Math.max(marker.line, 1), doc.lines));
                decorations = Decoration.set([Decoration.line({ class: `exec-line exec-${marker.kind}` }).range(line.from)]);
            }
        }
        return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
});

/**
 * @param {HTMLElement} parent
 * @param {{doc?: string, onChange?: () => void, keys?: Record<string, () => void>}} options
 *   `keys` maps CodeMirror key names, e.g. "Mod-Enter", to handlers
 */
export function createEditor(parent, { doc = "", onChange = () => {}, keys = {} } = {}) {
    const extraKeys = Object.entries(keys).map(([key, run]) => ({ key, run: () => (run(), true), preventDefault: true }));
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc,
            extensions: [
                lineNumbers(),
                history(),
                drawSelection(),
                highlightActiveLine(),
                bracketMatching(),
                bo(),
                syntaxHighlighting(classHighlighter),
                markerField,
                keymap.of([...extraKeys, ...defaultKeymap, ...historyKeymap]),
                EditorView.updateListener.of((update) => update.docChanged && onChange()),
            ],
        }),
    });
    return {
        getDoc: () => view.state.doc.toString(),
        setDoc(text) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, effects: setMarker.of(null) });
        },
        /** Marks the line being executed (scrolling the editor, not the page); null clears it. */
        mark(marker) {
            view.dispatch({ effects: [setMarker.of(marker)] });
            if (!marker) return;
            const doc = view.state.doc;
            const block = view.lineBlockAt(doc.line(Math.min(Math.max(marker.line, 1), doc.lines)).from);
            const scroller = view.scrollDOM;
            const margin = 2 * block.height;
            if (block.top < scroller.scrollTop) scroller.scrollTop = Math.max(0, block.top - margin);
            else if (block.bottom > scroller.scrollTop + scroller.clientHeight)
                scroller.scrollTop = block.bottom - scroller.clientHeight + margin;
        },
        /** Call after the editor became visible (it may have been inside a closed section). */
        measure: () => view.requestMeasure(),
        focus: () => view.focus(),
    };
}
