// Counting what a player typed. The unit is the top-level token: a word, a number, a string, or a
// whole parenthesised list (so `(2 *) (twicer) PUSH guess` is four). Literals count, as decided;
// what is inside a list does not. The rules follow doc/language.md: tokens are separated by
// whitespace, parentheses delimit lists, `"..."` is a string with backslash escapes, and `;` outside
// a string starts a comment that ends at the end of the line.

/**
 * @param {string} text Bo source as typed
 * @returns {string[]} the top-level tokens, exactly as written
 * @throws {Error} if a string or a list is not closed, or a `)` has no `(`
 */
export function topLevelTokens(text) {
    const tokens = [];
    let i = 0;
    const n = text.length;
    const skipString = () => {
        const start = i;
        i++; // the opening quote
        while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
        if (i >= n) throw new Error(`unterminated string starting at character ${start}`);
        i++; // the closing quote
    };
    while (i < n) {
        const c = text[i];
        if (/\s/.test(c)) i++;
        else if (c === ";") while (i < n && text[i] !== "\n") i++;
        else if (c === '"') {
            const start = i;
            skipString();
            tokens.push(text.slice(start, i));
        } else if (c === "(") {
            const start = i;
            let depth = 0;
            do {
                const d = text[i];
                if (d === "(") depth++;
                else if (d === ")") depth--;
                if (d === '"') skipString();
                else if (d === ";") while (i < n && text[i] !== "\n") i++;
                else i++;
            } while (depth > 0 && i < n);
            if (depth > 0) throw new Error(`unclosed ( starting at character ${start}`);
            tokens.push(text.slice(start, i));
        } else if (c === ")") throw new Error(`unexpected ) at character ${i}`);
        else {
            const start = i;
            while (i < n && !/[\s()";]/.test(text[i])) i++;
            tokens.push(text.slice(start, i));
        }
    }
    return tokens;
}

/** The number of top-level tokens, not counting a final `guess` (the check, not part of the answer). */
export function answerLength(text) {
    const tokens = topLevelTokens(text);
    if (tokens.at(-1) === "guess") tokens.pop();
    return tokens.length;
}
