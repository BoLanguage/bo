// Validates puzzle files: node playground-plus/validate.mjs [--json] [--budget N] FILE...
// Exit status 1 if any puzzle is invalid (warnings do not fail). Needs the WebAssembly build.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_BUDGET, formatReport, validatePuzzle } from "./harness.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const budgetAt = args.indexOf("--budget");
const budget = budgetAt >= 0 ? Number(args[budgetAt + 1]) : DEFAULT_BUDGET;
const paths = args.filter((arg, i) => !arg.startsWith("--") && !(budgetAt >= 0 && i === budgetAt + 1));
if (!paths.length || !Number.isInteger(budget) || budget <= 0) {
    console.error("usage: node playground-plus/validate.mjs [--json] [--budget WORDS] FILE...");
    process.exit(2);
}

let failed = 0;
const reports = [];
for (const path of paths) {
    const report = await validatePuzzle(readFileSync(path, "utf8"), { file: basename(path), budget });
    reports.push({ file: path, ...report });
    if (!report.ok) failed++;
    if (!json) console.log(formatReport(report, path));
}
if (json) console.log(JSON.stringify(reports, null, 2));
process.exit(failed ? 1 : 0);
