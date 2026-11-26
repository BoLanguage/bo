// Optional extension points for an application built on the playground. The published playground
// never calls `configure`, so every value stays null and the built-in behaviour applies.
//
// An application sets them before importing app.mjs:
//     import { configure } from "./config.mjs";
//     configure({ onEvent, puzzleProvider });
//     await import("./app.mjs");
//
// - `onEvent`: observer of the store's actions (see createStore in store.mjs).
// - `puzzleProvider`: where puzzles come from (see createStaticPuzzleProvider in puzzles.mjs).
// - `beforeAction`: an async function asked before the user does something an application may want to
//   confirm, with the action's name: "editor" (open the editor), "share" (share the editor's
//   program), "clear" ("Reset everything") or "load" (choose something in the program picker).
//   Resolving to false cancels the action.
export const config = { onEvent: null, puzzleProvider: null, beforeAction: null };

export function configure(options) {
    Object.assign(config, options);
}
