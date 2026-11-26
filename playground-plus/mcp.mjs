// Playground+'s MCP server: the tools and resources an LLM agent uses to write puzzles for the
// player. Start it over stdio from an MCP client:
//     node --disable-warning=ExperimentalWarning playground-plus/mcp.mjs
// It shares the database file with the web server ($PLAYGROUND_PLUS_DB, by default
// playground-plus/data/playground-plus.sqlite), so a puzzle submitted here shows up in the page.
//
// Nothing here writes to stdout except the protocol itself: stdout is the channel to the client.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KINDS, TAGS, availableKinds } from "./compile.mjs";
import { openDatabase } from "./db.mjs";
import { REFERENCES, createService } from "./service.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const LOOKUPS_BEFORE_NUDGE = 3;
const MAX_LOOKUPS = 4; // lookups allowed in a row before a draft has been validated

/**
 * @param {ReturnType<typeof createService>} service
 * @param {{client?: string|null, raw?: boolean, briefEasier?: () => number}} [options] `raw` also offers the
 *   advanced tools that take a whole Bo puzzle file (off by default: fewer tools is easier for small
 *   models); `briefEasier` says how many levels easier than usual each brief is (for a retry)
 */
export function createMcpServer(service, { client = null, raw = false, briefEasier = () => 0 } = {}) {
    const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
    const server = new McpServer({ name: "playground-plus", version }, {
        instructions:
            "Playground+ lets you write Bo puzzles for the person using it. Call get_bo_guide first: it explains how to describe a puzzle and how to work, and for most puzzles it contains everything you need, so do not spend turns looking words up. " +
            "Then get_brief (it says what to write next) and describe a puzzle, validate_puzzle until it is valid, and submit_puzzle.",
    });
    const submitter = () => ({ client: client ?? server.server.getClientVersion()?.name ?? null });
    let lookups = 0; // reference lookups since the agent last validated or submitted a draft
    let brief = null; // the brief the agent was last given, kept with the puzzle it leads to
    let lastValidated = null; // the last puzzle the agent validated, as text, to notice a repeat

    server.registerTool("get_bo_guide", {
        title: "Guide to writing Bo puzzles",
        description: "Read this first. How to write a puzzle for the player (file format, the check, good puzzle design, a short Bo primer, complete examples) and the workflow to follow.",
        annotations: READ_ONLY,
    }, async () => text(service.getGuide()));

    server.registerTool("get_bo_reference", {
        title: "Bo language reference",
        description: "Look up Bo words and rules when the guide's primer is not enough. Pass a query (a word such as \"foldl\" or \"swap\") to search every document at once and get just the matching entries. A topic (language, library, primitives, examples) reads one document; long ones return an outline.",
        inputSchema: {
            topic: z.enum(Object.keys(REFERENCES)).optional().describe("one document to read; leave it out to search all of them"),
            query: z.string().max(100).optional().describe("a word or phrase to look up; only the entries that mention it are returned"),
        },
        annotations: READ_ONLY,
    }, async ({ topic, query }) => {
        // a weak agent can spiral into looking up every word it has just read; point it back to writing
        if (lookups >= MAX_LOOKUPS) {
            return failure(`Lookup limit reached: you have looked things up ${lookups} times without validating a draft. Write a draft puzzle of your own now (use the closest example in the guide for its structure) and call validate_puzzle; its report will tell you exactly what to fix. After you have validated, you can look things up again.`);
        }
        lookups++;
        const answer = service.getReference(topic, { query });
        return text(lookups >= LOOKUPS_BEFORE_NUDGE
            ? `${answer}\n\n[Note: that was lookup number ${lookups} and you have not validated a draft yet. The guide has what you need: write a draft puzzle of your own now, using the closest example for its structure, and call validate_puzzle. Its report will tell you exactly what to fix.]`
            : answer);
    });

    server.registerTool("get_brief", {
        title: "What puzzle to write next",
        description: "Says what puzzle to write next: its kind, main topic, difficulty and a starting idea, chosen from how the player is doing and what puzzles already exist, plus goals to avoid repeating. Call it after the guide and follow it.",
        annotations: READ_ONLY,
    }, async () => {
        brief = service.getBrief({ easier: briefEasier() });
        return text(service.describeBrief(brief));
    });

    server.registerTool("get_user_profile", {
        title: "How the player is doing",
        description: "The player's record from their recorded sessions: totals, results by difficulty and by tag (solve rate, median time, hints), and the most recent puzzles. Use it to choose the next puzzle's difficulty and topic.",
        annotations: READ_ONLY,
    }, async () => text(service.getUserProfile()));

    server.registerTool("get_session_history", {
        title: "Recent play sessions",
        description: "The player's most recent sessions, newest first: which puzzle, the outcome (solved, revealed, skipped, abandoned, or open), time spent, prompts typed, guesses and hints used.",
        inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("how many sessions (default 10)") },
        annotations: READ_ONLY,
    }, async ({ limit }) => text(service.getSessionHistory({ limit })));

    server.registerTool("list_puzzles", {
        title: "Existing puzzles",
        description: "Every puzzle already available to the player, with its title, goal, tags, difficulty and how often it was played. Check it so you do not repeat a puzzle.",
        annotations: READ_ONLY,
    }, async () => text(service.listPuzzles()));

    const specShape = {
        kind: z.enum(availableKinds()).describe(availableKinds().map((kind) => `${kind}: ${KINDS[kind].summary}`).join("; ")),
        tags: z.array(z.enum(TAGS)).min(1).max(3).describe("1 to 3 topics; the first is the main one and goes in the title"),
        goal: z.string().describe("what the player must do, in one or two sentences; use `backticks` around Bo code"),
        inputs: z.array(z.array(z.any())).describe("stacks of whole numbers (or lists of whole numbers), bottom first. arrange: exactly one, the start stack. define: 3 to 8, the test inputs"),
        solution: z.string().describe("Bo words that solve it. arrange: the words applied to the start stack, e.g. rot. define: the body of the word, without parentheses, e.g. 2 * 1 +"),
        word: z.string().optional().describe("define only: the name of the word the player defines, lowercase with hyphens"),
        hints: z.array(z.string()).min(1).max(3).describe("1 to 3 texts, from a gentle nudge to a strong one, written for this puzzle"),
    };

    server.registerTool("validate_puzzle", {
        title: "Check a puzzle without storing it",
        description: "Builds the puzzle from your description and checks it on the real Bo machine. The expected results are worked out by running your solution, and shown so you can check them. Lines starting with PROBLEM or ERROR must be fixed before submitting; warnings are advice. Call it as often as needed.",
        inputSchema: specShape,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    }, async (spec) => {
        lookups = 0;
        try {
            const key = JSON.stringify(spec);
            const repeated = key === lastValidated;
            lastValidated = key;
            const report = service.describeSpecResult(await service.validateSpec(spec, submitter()));
            // a weak agent can send the same thing again and again; say so instead of repeating the report silently
            return text(repeated && !/\nValid\.$/.test(report)
                ? `[You sent exactly the same puzzle as your last validate_puzzle call, so the result is the same. Change the solution, the inputs or the goal, following the PROBLEM or ERROR lines.]\n${report}`
                : report);
        } catch (error) {
            return failure(error.message);
        }
    });

    server.registerTool("submit_puzzle", {
        title: "Give a puzzle to the player",
        description: "Builds, validates and, if valid, adds the puzzle to the player's puzzle list at once. If it is not valid nothing is stored and the report says why.",
        inputSchema: specShape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (spec) => {
        lookups = 0;
        try {
            const result = await service.submitSpec(spec, { ...submitter(), brief });
            if (result.alreadyExisted && !result.result) return text(`This exact puzzle was already submitted (id ${result.id}).`);
            if (!result.accepted) return failure(`${service.describeSpecResult(result.result)}\n\nNot stored.`);
            const { derived } = result.result.compiled;
            return text(`${result.alreadyExisted ? "This exact puzzle already existed" : "Stored"}: "${derived.title}" (id ${result.id}). It is in the player's puzzle list in Playground+.\n\n${service.describeSpecResult(result.result)}`);
        } catch (error) {
            return failure(error.message);
        }
    });

    if (raw) {
        server.registerTool("validate_bo_puzzle", {
            title: "Check a puzzle file without storing it (advanced)",
            description: "Advanced: runs a complete Bo puzzle file on the real machine and reports each check. Most agents should use validate_puzzle.",
            inputSchema: { source: z.string().describe("the complete puzzle file, starting with ;@puzzle") },
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        }, async ({ source }) => {
            lookups = 0;
            try {
                const report = await service.validatePuzzle(source);
                return text(`${service.formatReport(report)}\n\n${report.ok ? "Valid: call submit_bo_puzzle to give it to the player." : "Fix the ERROR lines and validate again."}`);
            } catch (error) {
                return failure(error.message);
            }
        });

        server.registerTool("submit_bo_puzzle", {
            title: "Give a puzzle file to the player (advanced)",
            description: "Advanced: validates a complete Bo puzzle file and, if valid, adds it to the player's puzzle list. Most agents should use submit_puzzle.",
            inputSchema: { source: z.string().describe("the complete puzzle file, starting with ;@puzzle") },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async ({ source }) => {
            lookups = 0;
            try {
                const result = await service.submitPuzzle(source, submitter());
                if (!result.accepted) return failure(`${service.formatReport(result.report)}\n\nNot stored. Fix the ERROR lines and submit again.`);
                return text(`${result.alreadyExisted ? "This exact puzzle already existed" : "Stored"}: "${result.report.puzzle.title}" (id ${result.id}). It is in the player's puzzle list in Playground+.\n\n${service.formatReport(result.report)}`);
            } catch (error) {
                return failure(error.message);
            }
        });
    }

    server.registerResource("guide", "bo://guide", {
        title: "Guide to writing Bo puzzles", description: "The same text as get_bo_guide.", mimeType: "text/markdown",
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: service.getGuide() }] }));
    for (const topic of Object.keys(REFERENCES)) {
        server.registerResource(`reference-${topic}`, `bo://reference/${topic}`, {
            title: `Bo reference: ${topic}`, description: `The whole ${topic} document (get_bo_reference searches it instead).`, mimeType: "text/markdown",
        }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: service.getFullReference(topic) }] }));
    }
    return server;
}

/** Runs the server on stdio, on the database at `databasePath`. */
export async function main(databasePath = process.env.PLAYGROUND_PLUS_DB ?? join(ROOT, "playground-plus", "data", "playground-plus.sqlite")) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const repository = openDatabase(databasePath);
    const server = createMcpServer(createService({ repository }), { raw: process.env.PLAYGROUND_PLUS_RAW === "1" });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`Playground+ MCP server ready (data: ${databasePath})\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
