// Runs every examples/*.bo under the WebAssembly runtime and compares stdout with examples/expected.
// Usage: node wasm/test_examples.mjs   (after `make -C c wasm`)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBo } from "./bo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examples = join(root, "examples");
const expected = join(examples, "expected");
const sources = readdirSync(examples).filter((f) => f.endsWith(".bo"));
const skip = new Set((process.env.BO_WASM_SKIP ?? "").split(",").filter(Boolean));

let failed = 0;
for (const file of sources.filter((f) => f !== "lib.bo")) {
    const name = file.slice(0, -3);
    if (skip.has(name)) {
        console.log(`skip ${name}`);
        continue;
    }
    let stdout = "";
    let stderr = "";
    const inputPath = join(expected, `${name}.in`);
    const bo = await createBo({
        autoload: "include/core.bo",
        input: existsSync(inputPath) ? readFileSync(inputPath, "utf8") : "",
        onOutput: (text, stream) => (stream === "stdout" ? (stdout += text) : (stderr += text)),
    });
    for (const source of sources) bo.writeFile(`examples/${source}`, readFileSync(join(examples, source), "utf8"));
    const ok = bo.include(`examples/${file}`);
    const want = readFileSync(join(expected, `${name}.out`), "utf8");
    const pass = ok && stderr === "" && stdout === want;
    if (!pass) failed++;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !stderr ? "" : `: ${stderr.trim().split("\n")[0]}`}`);
}
process.exit(failed ? 1 : 0);
