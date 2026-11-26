// Plays an agent's steps into the playground page, one at a time, as if someone typed them at the prompt.
// It knows nothing of the DOM: `page` does the typing (see page-control.mjs), so that this can be tested
// with a fake page and a virtual clock. Steps may arrive while it plays (a live run), and `stop` ends it at once.
//
// Pace. A step of a recorded run has `at`, the time it happened, so the wait before it is the real gap since
// the step before: with an agent, mostly the model thinking. That can be minutes, so there are three speeds:
// "real" (the gap as it was), "compressed" (no wait longer than COMPRESSED_CAP_MS) and "fast". A live run
// needs no waiting at all (`live`): its steps arrive when they happen. `instant` plays steps with no waiting
// and no typing, to bring the page up to date.

export const TYPING_MS = 450; // how long a line stays in the prompt before it is run
export const COMPRESSED_CAP_MS = 4000;
export const FAST_CAP_MS = 600;
export const SPEEDS = ["real", "compressed", "fast"];
const NEVER_FINISHED = /did not finish within/;
const SLICE_MS = 250; // a wait is made of slices, so that a change of speed or a stop is noticed

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait for a gap of `gap` ms at `speed`. */
export function shownGap(gap, speed) {
    if (speed === "real") return gap;
    if (speed === "fast") return Math.min(gap / 10, FAST_CAP_MS);
    return Math.min(gap, COMPRESSED_CAP_MS);
}

/**
 * @param {{page: {setPrompt(text: string): void, submit(code: string): Promise<boolean>}, sleep?: (ms: number) => Promise<void>,
 *   clock?: () => number, speed?: "real" | "compressed" | "fast", typing?: number, onStep?: (step: object) => void}} options
 *   `onStep` is told of each step as it starts (with `skipped: true` for a line that never finished on the
 *   server, which is not run here: it would hang the page's machine too).
 */
export function createStepPlayer({ page, sleep = sleepFor, clock = Date.now, speed = "compressed", typing = TYPING_MS, onStep = () => {} }) {
    const queue = [];
    let playing = false;
    let stopped = false;
    let lastAt = 0; // the `at` of the step played last
    let idleWaiters = [];

    /** Waits for the gap before a step, at the speed it has now (which may change meanwhile). */
    async function wait(gap, reserved) {
        const started = clock();
        for (;;) {
            const left = Math.max(shownGap(gap, speed) - reserved, 0) - (clock() - started);
            if (stopped || left <= 0) return;
            await sleep(Math.min(SLICE_MS, left));
        }
    }

    async function play({ step, mode }) {
        const isLine = step.kind === "run" || step.kind === "guess" || step.kind === "hint";
        if (mode === "paced") {
            const gap = Math.max((step.at ?? lastAt) - lastAt, 0);
            await wait(gap, isLine ? typing : 0);
            if (stopped) return;
        }
        if (step.at !== undefined) lastAt = step.at;
        if (!isLine) return onStep(step);
        if (step.error && NEVER_FINISHED.test(step.error)) return onStep({ ...step, skipped: true });
        onStep(step);
        if (mode !== "instant") {
            page.setPrompt(step.code);
            await sleep(typing);
            if (stopped) return;
        }
        await page.submit(step.code);
    }

    async function kick() {
        if (playing) return;
        playing = true;
        while (queue.length && !stopped) await play(queue.shift());
        playing = false;
        if (!queue.length || stopped) for (const done of idleWaiters.splice(0)) done();
    }

    return {
        /**
         * Adds steps to play, in order. By default they are paced by their `at`; `live` steps are not waited for,
         * and `instant` ones are played at once, without typing.
         */
        push(steps, { live = false, instant = false } = {}) {
            if (stopped) return;
            const mode = instant ? "instant" : live ? "live" : "paced";
            queue.push(...steps.map((step) => ({ step, mode })));
            kick();
        },
        /** Changes the speed from now on (also for a wait that is going on). */
        setSpeed(next) {
            if (SPEEDS.includes(next)) speed = next;
        },
        /** Ends the playing now: what is queued is dropped, and a line that is waiting to be typed is not run. */
        stop() {
            stopped = true;
            queue.length = 0;
            page.setPrompt("");
            for (const done of idleWaiters.splice(0)) done();
        },
        /** Resolves when everything pushed so far has been played (or it was stopped). */
        idle: () => ((!playing && !queue.length) || stopped ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
        get stopped() {
            return stopped;
        },
    };
}
