// The vocabulary shared by the compiler, the brief maker and the API: the topics a puzzle can be tagged
// with, and what a player may ask for when requesting a puzzle. No imports, so anything can load it.

/** The topics a puzzle can be tagged with; the first tag of a puzzle is in its title. */
export const TAGS = ["shuffle", "arithmetic", "conditional", "quotation", "list", "recursion", "definition"];

export const CHANGES = ["easier", "same", "harder"];
export const MAX_ASKED_TAGS = 3;

/**
 * What a player may ask for when requesting a puzzle: some topics, and an easier or harder one than usual.
 * Anything else is an error. Returns the preferences in their canonical form (only what was asked for).
 */
export function cleanPreferences(value = {}) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("preferences must be an object");
    const unknown = Object.keys(value).filter((key) => key !== "tags" && key !== "change");
    if (unknown.length) throw new Error(`unknown preference: ${unknown.join(", ")}`);
    const clean = {};
    if (value.tags !== undefined) {
        if (!Array.isArray(value.tags) || value.tags.length > MAX_ASKED_TAGS || !value.tags.every((tag) => TAGS.includes(tag)) || new Set(value.tags).size !== value.tags.length)
            throw new Error(`tags must be up to ${MAX_ASKED_TAGS} different values from ${TAGS.join(", ")}`);
        if (value.tags.length) clean.tags = [...value.tags];
    }
    if (value.change !== undefined) {
        if (!CHANGES.includes(value.change)) throw new Error(`change must be one of ${CHANGES.join(", ")}`);
        if (value.change !== "same") clean.change = value.change;
    }
    return clean;
}
