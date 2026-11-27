// One-off migration after Bo's "word" -> "op" rename: rewrites the JSON stored in the Playground+ database
// so that its keys match the renamed fields (a define spec's `word` -> `op`, a brief's `words` -> `ops`,
// `meanWordsToSolve` -> `meanTokensToSolve`, a debugger `next.word` -> `next.op`, step mode "words" -> "ops").
// Only those keys and values are renamed, never free text. Key order is kept, so a stored spec still
// compares equal to a newly normalized one (service.submitSpec).
//
//   node tools/migrate-word-to-op.mjs [path/to/playground-plus.sqlite] [--dry-run]
//
// It is idempotent: a second run changes nothing.
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const path = args.find((a) => !a.startsWith("--")) ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "playground-plus.sqlite");

const RENAMED = { meanWordsToSolve: "meanTokensToSolve", wordsTyped: "tokensTyped" };
const HOLDS_AN_OP = new Set(["spec", "next", "frames", "control"]);

/** The new name of `key` inside an object reached by `parent`, or null to keep it. */
function newKey(key, parent) {
    if (key === "word" && HOLDS_AN_OP.has(parent)) return "op";
    if (key === "words" && parent === "brief") return "ops";
    return RENAMED[key] ?? null;
}

/** Walks a parsed JSON value; returns [new value, number of keys or values renamed]. */
function migrate(value, parent = null) {
    if (Array.isArray(value)) {
        let count = 0;
        const out = value.map((item) => {
            const [v, n] = migrate(item, parent);
            count += n;
            return v;
        });
        return [out, count];
    }
    if (!value || typeof value !== "object") return [value, 0];
    let count = 0;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        let name = key;
        const to = newKey(key, parent);
        if (to && !Object.hasOwn(value, to)) {
            name = to;
            count++;
        }
        let [v, n] = migrate(item, name);
        if (name === "mode" && v === "words") {
            v = "ops";
            n++;
        }
        out[name] = v;
        count += n;
    }
    return [out, count];
}

const COLUMNS = {
    puzzles: { key: ["id"], columns: ["package"] },
    events: { key: ["session_id", "seq"], columns: ["meta", "puzzle_state", "stack_before", "stack_after", "output"] },
    requests: { key: ["id"], columns: ["preferences"] },
};

const db = new DatabaseSync(path);
db.exec("PRAGMA journal_mode = WAL");
const report = [];
db.exec("BEGIN IMMEDIATE");
try {
    for (const [table, { key, columns }] of Object.entries(COLUMNS)) {
        const where = key.map((k) => `${k} = ?`).join(" AND ");
        for (const column of columns) {
            const rows = db.prepare(`SELECT ${key.join(", ")}, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
            const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`);
            let rowsChanged = 0;
            let renamed = 0;
            for (const row of rows) {
                let parsed;
                try {
                    parsed = JSON.parse(row.value);
                } catch {
                    continue;
                }
                const [next, n] = migrate(parsed);
                if (!n) continue;
                rowsChanged++;
                renamed += n;
                if (!dryRun) update.run(JSON.stringify(next), ...key.map((k) => row[k]));
            }
            report.push(`${table}.${column}: ${rows.length} rows read, ${rowsChanged} changed, ${renamed} keys/values renamed`);
        }
    }
    db.exec(dryRun ? "ROLLBACK" : "COMMIT");
} catch (error) {
    db.exec("ROLLBACK");
    throw error;
}
if (!dryRun) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(`${dryRun ? "[dry run] " : ""}${path}\n${report.join("\n")}`);
