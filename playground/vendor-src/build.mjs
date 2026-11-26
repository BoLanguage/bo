// Bundles CodeMirror 6 and the Bo language into ../vendor/codemirror.js (run `npm install` first).
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await build({
    entryPoints: [join(here, "entry.js")],
    outfile: join(here, "..", "vendor", "codemirror.js"),
    bundle: true,
    format: "esm",
    minify: true,
    legalComments: "none",
    // jupyterlab/src/bo.ts must use this folder's CodeMirror copy, not its own, or the
    // single @codemirror/state instance the editor relies on would be duplicated.
    alias: { "@codemirror/language": join(here, "node_modules", "@codemirror", "language") },
});
