// Recall of earlier prompt entries with Up and Down, like a shell. No DOM: the page passes the
// current text in and shows what comes back.

/**
 * @param {{getItem(key: string): string|null, setItem(key: string, value: string): void}|null} storage
 *   where entries are kept between page loads (sessionStorage), or null to keep them in memory
 */
export function createHistory(storage = null, { key = "bo-prompt-history", limit = 50 } = {}) {
    let entries = [];
    try {
        const saved = JSON.parse(storage?.getItem(key) ?? "[]");
        if (Array.isArray(saved)) entries = saved.filter((e) => typeof e === "string").slice(-limit);
    } catch (error) {
        // unreadable history is just forgotten
    }
    let cursor = entries.length; // entries.length means "the text being typed"
    let draft = "";

    const save = () => {
        try {
            storage?.setItem(key, JSON.stringify(entries));
        } catch (error) {
            // storage can be full or blocked
        }
    };

    return {
        entries: () => [...entries],
        /** Remembers an evaluated entry (not blanks, not a repeat of the last one). */
        add(text) {
            if (text.trim() && entries[entries.length - 1] !== text) {
                entries.push(text);
                entries = entries.slice(-limit);
                save();
            }
            cursor = entries.length;
            draft = "";
        },
        /** The earlier entry to show for Up; `current` is what is typed now. Null if there is none. */
        previous(current) {
            if (cursor === 0) return null;
            if (cursor === entries.length) draft = current;
            cursor--;
            return entries[cursor];
        },
        /** The later entry (or the text that was being typed) for Down; null if already there. */
        next() {
            if (cursor >= entries.length) return null;
            cursor++;
            return cursor === entries.length ? draft : entries[cursor];
        },
        /** Back to "the text being typed" (after Escape, or when the text is replaced). */
        reset() {
            cursor = entries.length;
            draft = "";
        },
    };
}
