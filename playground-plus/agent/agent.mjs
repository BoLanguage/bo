// An agent loop that asks an Ollama model to write puzzles through Playground+'s MCP server, and
// records how that goes. It is a stand-in for an MCP client such as a chat application: it offers
// the model the server's tools, runs the tool calls the model makes, and stops when a puzzle is
// accepted, the model gives up, or a limit is reached. Playground+'s own puzzle generator and the
// experiment runner (eval/run.mjs) both use it.

const DEFAULTS = {
    maxTurns: 14,
    totalTimeoutMs: 15 * 60 * 1000,
    turnTimeoutMs: 8 * 60 * 1000,
    toolOutputLimit: 20_000, // characters of a tool result kept in the conversation
    options: { num_ctx: 16384, temperature: 0.2, seed: 7 }, // Ollama's default context would silently cut the guide
};

export const TASK = "Please write me a new Bo puzzle.";

/** The server's tools as Ollama's tool definitions. */
export function toOllamaTools(mcpTools) {
    return mcpTools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object", properties: {} } },
    }));
}

/**
 * Some models write a tool call as JSON text instead of using the structured field. This finds one:
 * `{"name": ..., "arguments": {...}}`, bare or inside a code fence, naming a tool that exists.
 * @returns {{name: string, arguments: object} | null}
 */
export function parseTextToolCall(content, toolNames) {
    if (typeof content !== "string") return null;
    const candidates = [];
    for (const fence of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(fence[1]);
    candidates.push(content);
    for (const candidate of candidates) {
        const start = candidate.indexOf("{");
        const end = candidate.lastIndexOf("}");
        if (start < 0 || end <= start) continue;
        try {
            const value = JSON.parse(candidate.slice(start, end + 1));
            const call = value.function ?? value;
            const args = call.arguments ?? call.parameters ?? {};
            if (typeof call.name === "string" && toolNames.includes(call.name) && args !== null && typeof args === "object" && !Array.isArray(args))
                return { name: call.name, arguments: args };
        } catch {
            // not JSON: try the next candidate
        }
    }
    return null;
}

const resultText = (result) => (result.content ?? []).map((part) => part.text ?? "").join("\n");

/**
 * @param {{
 *   ollama: ReturnType<import("./ollama.mjs").createOllama>,
 *   model: string,
 *   mcp: {listTools: Function, callTool: Function, getInstructions: Function},
 *   think?: boolean | string,
 *   lenient?: boolean,
 *   task?: string,
 *   maxTurns?: number, totalTimeoutMs?: number, turnTimeoutMs?: number, toolOutputLimit?: number,
 *   options?: object,
 *   onStep?: (step: object) => void,
 * }} config `lenient` accepts tool calls written as text (counted separately from structured ones);
 *   `signal` stops the run when aborted (the outcome is "cancelled"); `retryEmpty` is how many times a reply
 *   with neither text nor a tool call is answered with a nudge instead of ending the run
 */
export async function runAgent(config) {
    const { ollama, model, mcp, think, lenient = true, task = TASK, onStep = () => {}, signal, retryEmpty = 0 } = config;
    const { maxTurns, totalTimeoutMs, turnTimeoutMs, toolOutputLimit } = { ...DEFAULTS, ...config };
    const options = { ...DEFAULTS.options, ...config.options };

    const { tools: mcpTools } = await mcp.listTools();
    const tools = toOllamaTools(mcpTools);
    const toolNames = mcpTools.map((tool) => tool.name);
    const instructions = mcp.getInstructions() ?? "";
    const messages = [
        { role: "system", content: `You are an assistant connected to Playground+ through tools. ${instructions}`.trim() },
        { role: "user", content: task },
    ];

    const metrics = {
        turns: 0, structuredCalls: 0, textCalls: 0, unknownTools: 0, toolErrors: 0,
        calls: {}, validateCalls: 0, submitCalls: 0, attemptsToValid: null, firstValidateOk: null,
        readGuideFirst: null, outputTokens: 0, maxPromptTokens: 0, modelMs: 0, contextNearlyFull: false,
    };
    const steps = [];
    const started = Date.now();
    let outcome = "max-turns";
    let finalText = "";
    let accepted = null;
    let emptyRetries = 0;
    metrics.emptyRetries = 0;

    for (let turn = 1; turn <= maxTurns; turn++) {
        if (signal?.aborted) {
            outcome = "cancelled";
            break;
        }
        if (Date.now() - started > totalTimeoutMs) {
            outcome = "timeout";
            break;
        }
        let reply;
        try {
            reply = await ollama.chat({ model, messages, tools, options, think, timeoutMs: turnTimeoutMs, signal });
        } catch (error) {
            outcome = signal?.aborted ? "cancelled" : "error";
            finalText = String(error.message ?? error);
            break;
        }
        metrics.turns = turn;
        metrics.outputTokens += reply.outputTokens;
        metrics.maxPromptTokens = Math.max(metrics.maxPromptTokens, reply.promptTokens);
        // near the window, Ollama silently drops the oldest messages, and the model forgets the guide
        if (reply.promptTokens >= options.num_ctx * 0.9) metrics.contextNearlyFull = true;
        metrics.modelMs += reply.ms;
        const message = reply.message ?? { role: "assistant", content: "" };
        finalText = message.content ?? "";

        let calls = (message.tool_calls ?? []).map((c) => ({ name: c.function?.name, arguments: c.function?.arguments ?? {}, structured: true }));
        if (!calls.length && lenient) {
            const text = parseTextToolCall(finalText, toolNames);
            if (text) calls = [{ ...text, structured: false }];
        }
        const step = { turn, ms: reply.ms, promptTokens: reply.promptTokens, outputTokens: reply.outputTokens, thinkingChars: (message.thinking ?? "").length, content: finalText, calls: [] };
        steps.push(step);
        if (!calls.length) {
            onStep(step);
            // an empty reply (no text, no tool call) happens now and then; a person would just ask again
            if (!finalText.trim() && emptyRetries < retryEmpty) {
                emptyRetries++;
                metrics.emptyRetries = emptyRetries;
                messages.push({ role: "assistant", content: "" }, { role: "user", content: "Please continue: call one of the tools." });
                continue;
            }
            outcome = "no-tool-call";
            break;
        }
        messages.push({ role: "assistant", content: finalText, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });

        for (const call of calls) {
            if (call.structured) metrics.structuredCalls++;
            else metrics.textCalls++;
            let text;
            let isError = false;
            if (!toolNames.includes(call.name)) {
                metrics.unknownTools++;
                isError = true;
                text = `Error: there is no tool named "${call.name}". The tools are: ${toolNames.join(", ")}.`;
            } else {
                metrics.calls[call.name] = (metrics.calls[call.name] ?? 0) + 1;
                if (metrics.readGuideFirst === null) metrics.readGuideFirst = call.name === "get_bo_guide";
                try {
                    const result = await mcp.callTool({ name: call.name, arguments: call.arguments });
                    text = resultText(result);
                    isError = result.isError === true;
                } catch (error) {
                    isError = true;
                    text = `Error: ${error.message ?? error}`;
                }
            }
            if (isError) metrics.toolErrors++;
            if (call.name === "validate_puzzle" || call.name === "submit_puzzle") {
                const isValidate = call.name === "validate_puzzle";
                if (isValidate) metrics.validateCalls++;
                else metrics.submitCalls++;
                const ok = !isError && (isValidate ? /: valid\b/.test(text) : true);
                if (metrics.firstValidateOk === null) metrics.firstValidateOk = ok;
                if (ok && metrics.attemptsToValid === null) metrics.attemptsToValid = metrics.validateCalls + metrics.submitCalls;
                if (!isValidate && ok) accepted = { text };
            }
            step.calls.push({ name: call.name, structured: call.structured, arguments: call.arguments, isError, result: text.slice(0, 2000) });
            messages.push({ role: "tool", tool_name: call.name, content: text.length > toolOutputLimit ? `${text.slice(0, toolOutputLimit)}\n[truncated]` : text });
        }
        onStep(step);
        if (accepted) {
            outcome = "accepted";
            break;
        }
    }
    return { model, outcome, finalText, metrics: { ...metrics, ms: Date.now() - started }, steps, messages, accepted };
}
