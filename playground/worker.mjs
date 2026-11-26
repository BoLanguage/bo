// Runs one session inside a module Web Worker, so a long or endless program never blocks the page.
import { createSession } from "./session.mjs";

const session = createSession((text, stream) => postMessage({ event: "output", text, stream }));

onmessage = async ({ data: { id, method, args } }) => {
    try {
        postMessage({ id, result: await session[method](...args) });
    } catch (error) {
        postMessage({ id, error: String(error?.message ?? error) });
    }
};
