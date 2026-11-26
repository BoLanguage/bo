// Where Playground+ gets its puzzles: the playground's own (practice, not recorded) plus those
// stored on the server. The server's come first. A stored puzzle is recorded the first time it is played;
// it says how the editor is treated then (it holds the puzzle's source, so opening it counts as revealing the
// solution). Once played it is a past puzzle: practice, like the playground's own, and not recorded again.
import { parsePuzzle } from "../../playground/puzzles.mjs";

export const REVEAL_NOTE = "Opening the editor counts as revealing the solution.";
export const PAST_NOTE = "You have played this puzzle before, so this time it is practice: the editor is free to use and nothing is recorded.";

// the server lists a puzzle's text and its source; what the header says about hints is read from the source
const freeHintsOf = (puzzle) => {
    try {
        return parsePuzzle(puzzle.source, puzzle.title).freeHints;
    } catch {
        return 0;
    }
};

const fromServer = (puzzle) => {
    const played = Boolean(puzzle.played);
    const note = played ? PAST_NOTE : REVEAL_NOTE;
    return {
        ...puzzle,
        description: puzzle.description ? `${puzzle.description}\n\n${note}` : note,
        freeHints: freeHintsOf(puzzle),
        hiddenStacks: [],
        recorded: !played,
        played,
    };
};

export function createPlusPuzzleProvider({ practice, api, onError = console.warn }) {
    const known = new Set(); // ids of the stored puzzles already handed to the page
    return {
        async load() {
            const { puzzles, files } = await practice.load();
            let stored = [];
            try {
                stored = await api.listPuzzles();
            } catch (error) {
                onError(`Playground+ puzzles are not available: ${error.message}`);
            }
            for (const puzzle of stored) known.add(puzzle.id);
            return {
                files,
                puzzles: [...stored.map(fromServer), ...puzzles.map((puzzle) => ({ ...puzzle, recorded: false }))],
            };
        },

        /** Calls `callback(puzzle)` for each puzzle stored after `load` (for example one an agent has just written). */
        subscribe(callback) {
            return api.onNewPuzzle(async () => {
                try {
                    for (const puzzle of await api.listPuzzles()) {
                        if (known.has(puzzle.id)) continue;
                        known.add(puzzle.id);
                        callback(fromServer(puzzle));
                    }
                } catch (error) {
                    onError(`Playground+ puzzles are not available: ${error.message}`);
                }
            });
        },
    };
}
