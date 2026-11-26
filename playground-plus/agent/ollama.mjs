// A minimal client of Ollama's HTTP API, enough to run a tool-calling conversation. It has no
// dependencies, and `fetch` is injectable so the tests can talk to a fake server.

export const DEFAULT_HOST = "http://127.0.0.1:11434";

/** Settings some models need that others reject (sending `think` to a model without it is an error). */
export function modelTraits(model) {
    if (/^gpt-oss/.test(model)) return { think: "low" };
    if (/^qwen3(\.\d+)?(:|$)/.test(model)) return { think: false };
    return {};
}

/**
 * @param {{host?: string, fetch?: typeof fetch}} [options] `host` defaults to $OLLAMA_HOST or the local server
 */
export function createOllama({ host = process.env.OLLAMA_HOST ?? DEFAULT_HOST, fetch: fetchFn = fetch } = {}) {
    const base = /^https?:\/\//.test(host) ? host : `http://${host}`;
    const call = async (path, body, timeoutMs, signal) => {
        const response = await fetchFn(new URL(path, base), {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? {} : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Ollama ${path}: ${response.status} ${text.slice(0, 300)}`);
        return JSON.parse(text);
    };

    return {
        base,

        /** The installed models: `[{name, parameterSize, capabilities}]`; throws if the server is not reachable. */
        async listModels() {
            const { models } = await call("/api/tags", undefined, 5000);
            return models.map((m) => ({ name: m.name, parameterSize: m.details?.parameter_size ?? null, capabilities: m.capabilities ?? [] }));
        },

        /**
         * One non-streaming chat turn. Resolves to `{message, done_reason, promptTokens, outputTokens, ms}`.
         * `message` has `content`, optionally `thinking`, and `tool_calls` as `[{function: {name, arguments}}]`.
         */
        async chat({ model, messages, tools = [], options = {}, think, timeoutMs = 600_000, signal }) {
            const started = Date.now();
            const body = { model, messages, stream: false, options };
            if (tools.length) body.tools = tools;
            if (think !== undefined) body.think = think;
            const reply = await call("/api/chat", body, timeoutMs, signal);
            return {
                message: reply.message,
                done_reason: reply.done_reason ?? null,
                promptTokens: reply.prompt_eval_count ?? 0,
                outputTokens: reply.eval_count ?? 0,
                ms: Date.now() - started,
            };
        },
    };
}
