// Entry point of the vendored CodeMirror bundle: only what the playground editor uses.
export { EditorState, StateField, StateEffect, Compartment } from "@codemirror/state";
export { EditorView, Decoration, keymap, lineNumbers, drawSelection, highlightActiveLine } from "@codemirror/view";
export { syntaxHighlighting, bracketMatching } from "@codemirror/language";
export { classHighlighter } from "@lezer/highlight";
export { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
// The same generated language the JupyterLab extension uses, so highlighting follows the primitives.
export { bo } from "../../jupyterlab/src/bo.ts";
