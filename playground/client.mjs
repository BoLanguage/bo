// Clients with the session's async interface: one talking to a Web Worker, one in-process.
import { createSession, SESSION_METHODS } from "./session.mjs";

/**
 * A session running in a Web Worker. `onOutput` receives program output; `terminate()` kills the
 * worker (a stuck program), after which the client must not be used.
 */
export function createWorkerClient(workerUrl, onOutput = () => {}) {
    const worker = new Worker(workerUrl, { type: "module" });
    const pending = new Map();
    let nextId = 1;
    worker.onmessage = ({ data }) => {
        if (data.event === "output") return onOutput(data.text, data.stream);
        const call = pending.get(data.id);
        pending.delete(data.id);
        if (data.error !== undefined) call.reject(new Error(data.error));
        else call.resolve(data.result);
    };
    worker.onerror = (event) => {
        for (const call of pending.values()) call.reject(new Error(event.message));
        pending.clear();
    };
    const client = { terminate: () => worker.terminate() };
    for (const method of SESSION_METHODS)
        client[method] = (...args) =>
            new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject });
                worker.postMessage({ id, method, args });
            });
    return client;
}

/** A session in this thread (tests, Node). Each call yields to the event loop first, like a worker would. */
export function createLocalClient(onOutput = () => {}) {
    const session = createSession(onOutput);
    const yielded = () => new Promise((resolve) => setTimeout(resolve, 0));
    const client = { terminate() {} };
    for (const method of SESSION_METHODS)
        client[method] = async (...args) => {
            await yielded();
            return session[method](...args);
        };
    return client;
}
