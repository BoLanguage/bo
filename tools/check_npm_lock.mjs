import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
const installed = JSON.parse(readFileSync(join(dir, "node_modules/.package-lock.json"), "utf8"));

if (!lock.packages || !installed.packages) {
    console.error(`Missing package data in ${dir} lockfile`);
    process.exit(1);
}

for (const [path, entry] of Object.entries(installed.packages)) {
    const expected = lock.packages[path];
    if (!expected || entry.version !== expected.version ||
        entry.integrity !== expected.integrity || entry.resolved !== expected.resolved ||
        entry.link !== expected.link) {
        console.error(`Installed package ${path} differs from ${dir}/package-lock.json`);
        process.exit(1);
    }
}
