// A small valid puzzle that is not a copy of any built-in puzzle or guide example, for the tests that
// need to submit one. Starting from 2 3 1 (1 on top), `-rot` leaves 1 2 3.
export const SAMPLE_PUZZLE = [
    ";@puzzle",
    ";@title Put three in order",
    ";@goal Reorder the stack so that 3 is on top, then 2, then 1.",
    ";@hints 1",
    ";@tags shuffle",
    ";@difficulty 1",
    ";@solution -rot guess",
    ";@wrong swap guess",
    ";@end",
    '"include/std.bo" require',
    '"examples/puzzles/lib.bo" require',
    "() (snapshot (1 2 3) =) puzzle.require",
    "2 3 1",
    '("-rot moves the top value down to third place.") (puzzle.hints) PUSH',
    '"-rot guess" (puzzle.reveal) PUSH',
    "",
].join("\n");

/** A genuinely different puzzle (other values, another check), for tests that need a second one. */
export const OTHER_PUZZLE = SAMPLE_PUZZLE
    .replace("Put three in order", "Bring the middle value up")
    .replace("Reorder the stack so that 3 is on top, then 2, then 1.", "Leave 1 on top of 3 and 2.")
    .replace("(snapshot (1 2 3) =)", "(snapshot (3 2 1) =)")
    .replace("2 3 1", "1 2 3")
    .replace(";@solution -rot guess", ";@solution swap rot guess")
    .replace('"-rot guess" (puzzle.reveal)', '"swap rot guess" (puzzle.reveal)');

/** The same idea as SAMPLE_PUZZLE, described as a spec (what an agent sends): not a copy of any guide example. */
export const SAMPLE_SPEC = {
    kind: "arrange",
    tags: ["shuffle"],
    goal: "Reorder the stack so that 3 is on top, then 2, then 1.",
    inputs: [[2, 3, 1]],
    solution: "-rot",
    hints: ["The top value has to go down to the bottom.", "`-rot` moves the top value down to third place."],
};
