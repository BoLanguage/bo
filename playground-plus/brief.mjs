// The creative brief for the next puzzle: what kind, which topic, how hard, and one idea to start from,
// chosen from how the player is doing and from what already exists. Small models copy examples and have few
// ideas of their own, so the server supplies the idea and the targeting; the agent only has to carry it out.
import { TAGS } from "./taxonomy.mjs";

/** Starting ideas, by topic: {kind, difficulty, idea, words}. `words` are Bo words the solution will probably use. */
export const IDEAS = {
    shuffle: [
        { kind: "arrange", difficulty: 1, idea: "Copy the second value onto the top of the stack.", words: ["over"] },
        { kind: "arrange", difficulty: 1, idea: "Exchange the top two values and leave a third one untouched below.", words: ["swap"] },
        { kind: "arrange", difficulty: 2, idea: "Reverse the order of three values.", words: ["swap", "rot", "-rot"] },
        { kind: "arrange", difficulty: 2, idea: "Leave the top value both on top and underneath the other two.", words: ["dup", "-rot", "rot"] },
        { kind: "arrange", difficulty: 3, idea: "Bring the fourth value from the top up to the top, keeping the others in order.", words: ["roll", "pick"] },
        { kind: "arrange", difficulty: 4, idea: "Reverse the order of four values.", words: ["swap", "roll", "rot"] },
    ],
    arithmetic: [
        { kind: "arrange", difficulty: 1, idea: "Leave the larger of two numbers.", words: ["max"] },
        { kind: "arrange", difficulty: 1, idea: "Add the top two numbers.", words: ["+"] },
        { kind: "arrange", difficulty: 2, idea: "Leave the sum of three numbers.", words: ["+"] },
        { kind: "define", difficulty: 1, idea: "Define a word that adds ten to a number.", words: ["+"] },
        { kind: "define", difficulty: 2, idea: "Define a word that squares a number and subtracts the number.", words: ["dup", "*", "-", "swap"] },
        { kind: "define", difficulty: 3, idea: "Define a word for the distance between two numbers (the absolute difference).", words: ["-", "abs"] },
    ],
    conditional: [
        { kind: "define", difficulty: 2, idea: "Define a word that leaves 1 for an even number and 0 for an odd one.", words: ["mod", "="] },
        { kind: "define", difficulty: 2, idea: "Define a word that leaves -1, 0 or 1 for the sign of a number.", words: ["ifte", "dup", "<", "="] },
        { kind: "define", difficulty: 3, idea: "Define a word that limits a number to at most 100 and at least 0.", words: ["min", "max"] },
    ],
    quotation: [
        { kind: "define", difficulty: 1, idea: "Define a word that negates a number.", words: ["neg"] },
        { kind: "define", difficulty: 2, idea: "Define a word that leaves a number and its double.", words: ["dup", "*"] },
        { kind: "define", difficulty: 2, idea: "Define a word that replaces two numbers by their sum and their product.", words: ["over", "+", "*", "-rot"] },
    ],
    list: [
        { kind: "define", difficulty: 2, idea: "Define a word that doubles every element of a list.", words: ["map", "apply", "unit"] },
        { kind: "define", difficulty: 2, idea: "Define a word that keeps only the elements of a list that are greater than 3.", words: ["filter", "apply", ">"] },
        { kind: "define", difficulty: 3, idea: "Define a word that leaves the largest element of a non-empty list.", words: ["foldl", "max", "apply"] },
        { kind: "define", difficulty: 3, idea: "Define a word for the sum of the squares of a list.", words: ["map", "foldl", "apply", "unit"] },
        { kind: "define", difficulty: 3, idea: "Define a word that counts the even elements of a list.", words: ["filter", "len", "mod", "apply"] },
    ],
    recursion: [
        { kind: "define", difficulty: 3, idea: "Define a word for the sum of the numbers from 1 to n.", words: ["ifte", "dup", "+"] },
        { kind: "define", difficulty: 3, idea: "Define a word for n factorial.", words: ["ifte", "dup", "*"] },
        { kind: "define", difficulty: 4, idea: "Define a word for the nth Fibonacci number.", words: ["ifte", "dup", "+"] },
        { kind: "define", difficulty: 4, idea: "Define a word for 2 to the power n, without using ^.", words: ["ifte", "dup", "*"] },
    ],
    definition: [
        { kind: "define", difficulty: 1, idea: "Define a word that triples a number and adds two.", words: ["*", "+"] },
        { kind: "define", difficulty: 2, idea: "Define a word that leaves the average of two numbers (whole division).", words: ["+", "//"] },
        { kind: "define", difficulty: 3, idea: "Define a word that leaves the middle value of three numbers on the stack.", words: ["min", "max"] },
    ],
};

const DIFFICULTY_CHANGE = { easier: -1, same: 0, harder: 1 };
const RECENT = 8; // goals of the newest puzzles shown to avoid

const pick = (list, random) => list[Math.min(Math.floor(random() * list.length), list.length - 1)];

/** The brief as the agent reads it. */
export function formatBrief(brief) {
    return [
        "Brief for your next puzzle (follow it unless you have a clearly better idea):",
        `- kind: ${brief.kind}`,
        `- main tag: ${brief.tag} (put it first in tags)`,
        `- difficulty: about ${brief.difficulty}`,
        `- idea: ${brief.idea} Make the numbers your own.`,
        ...(brief.words?.length ? [`- Bo words the solution will probably use: ${brief.words.join(" ")} (get_bo_reference with a query shows how one works)`] : []),
        `- why this: ${brief.why}`,
        ...(brief.avoid.length ? ["- do not repeat these goals:", ...brief.avoid.map((goal) => `  * ${goal}`)] : []),
        "Now describe the puzzle and call validate_puzzle.",
    ].join("\n");
}

/**
 * @param {{profile: object, puzzles: {goal: string, tags: string[], brief?: {idea?: string}}[], random?: () => number,
 *   preferences?: {tags?: string[], change?: "easier"|"same"|"harder", kind?: string, difficulty?: number}}} input
 *   `puzzles` are the stored puzzles, oldest first; `preferences` are what the player asked for (all optional);
 *   `easier` is how many levels to lower the difficulty by (for a retry after a try that failed)
 * @returns {{kind: string, tag: string, difficulty: number, idea: string, avoid: string[], why: string}}
 */
export function makeBrief({ profile, puzzles, random = Math.random, preferences = {}, easier = 0 }) {
    const reasons = [];
    const finished = (stats) => stats.solved + stats.revealed + stats.abandoned + stats.skipped;

    // difficulty: a step above the highest level the player solves reliably
    let difficulty = 1;
    if (profile.totals.sessions) {
        const solid = Object.entries(profile.byDifficulty).filter(([, s]) => finished(s) >= 2 && s.solveRate !== null && s.solveRate >= 0.6).map(([level, s]) => ({ level: Number(level), rate: s.solveRate }));
        const top = solid.at(-1);
        difficulty = top ? Math.min(top.level + (top.rate >= 0.8 ? 1 : 0), 5) : 1;
        reasons.push(top ? `the player solves difficulty ${top.level} ${Math.round(top.rate * 100)}% of the time` : "the player has not yet solved a level reliably");
    } else reasons.push("the player is new");
    if (preferences.difficulty) {
        difficulty = Math.min(Math.max(Math.round(preferences.difficulty), 1), 5);
        reasons.push("the player asked for this difficulty");
    } else if (preferences.change && preferences.change in DIFFICULTY_CHANGE) {
        // "easier" and "harder" are than the puzzle the player played last
        const last = profile.recent?.[0]?.difficulty;
        if (last) {
            difficulty = Math.min(Math.max(last + DIFFICULTY_CHANGE[preferences.change], 1), 5);
            reasons.push(`the player asked for something ${preferences.change} than the last puzzle (difficulty ${last})`);
        } else reasons.push(`the player asked for something ${preferences.change}, but has no earlier puzzle to compare with`);
    }
    // a writer that failed at this level is given an easier one on its next try
    if (easier > 0) {
        difficulty = Math.max(difficulty - easier, 1);
        reasons.push(`an earlier try at a harder puzzle did not work out, so this one is easier`);
    }

    // topic: one the player asked for, else one never tried, else the one they do worst on. A topic needs an
    // idea at the difficulty (or, failing that, next to it), so a new player is not handed recursion.
    const near = (topic, distance) => IDEAS[topic]?.some((entry) => Math.abs(entry.difficulty - difficulty) <= distance);
    const suitable = (topics) => {
        const exact = topics.filter((topic) => near(topic, 0));
        return exact.length ? exact : topics.filter((topic) => near(topic, 1));
    };
    const asked = (preferences.tags ?? []).filter((tag) => TAGS.includes(tag));
    let tag;
    if (asked.length) {
        tag = pick(asked, random);
        reasons.push(`the player asked for ${tag}`);
    } else {
        const played = new Set(Object.keys(profile.byTag));
        const fresh = suitable(TAGS.filter((candidate) => !played.has(candidate)));
        if (fresh.length && profile.totals.sessions) {
            tag = pick(fresh, random);
            reasons.push(`the player has not tried ${tag} yet`);
        } else {
            const weakest = Object.entries(profile.byTag).filter(([name, s]) => IDEAS[name] && s.solveRate !== null).sort(([, a], [, b]) => a.solveRate - b.solveRate)[0];
            tag = weakest ? weakest[0] : pick(suitable(Object.keys(IDEAS)), random);
            if (weakest) reasons.push(`${tag} is where the player does worst (${Math.round(weakest[1].solveRate * 100)}% solved)`);
        }
    }

    // idea: one of the topic's not used before, nearest the difficulty (and the kind, if one was asked for)
    const used = new Set(puzzles.map((p) => p.brief?.idea).filter(Boolean));
    const pool = IDEAS[tag].filter((entry) => !preferences.kind || entry.kind === preferences.kind);
    const candidates = (pool.length ? pool : IDEAS[tag]).map((entry) => ({ ...entry, distance: Math.abs(entry.difficulty - difficulty) + (used.has(entry.idea) ? 10 : 0) }));
    const best = Math.min(...candidates.map((c) => c.distance));
    const chosen = pick(candidates.filter((c) => c.distance === best), random);
    if (used.has(chosen.idea)) reasons.push("every idea for this topic was used, so make a new variation");

    return {
        kind: chosen.kind, tag, difficulty, idea: chosen.idea, words: chosen.words,
        avoid: puzzles.slice(-RECENT).map((p) => p.goal),
        why: reasons.join("; "),
    };
}
