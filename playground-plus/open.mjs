// Opening a page in the user's browser, and nothing more: there is no dependency for it. The command
// depends on the platform; if none is available (a server without a display, say), `openBrowser`
// reports false and the caller just prints the URL.
import { spawn } from "node:child_process";

/**
 * The program and arguments that open `url`, or null when this machine has no way to (a Linux session
 * without a display).
 */
export function openerCommand(url, { platform = process.platform, env = process.env } = {}) {
    if (platform === "darwin") return ["open", [url]];
    if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
    if (env.WSL_DISTRO_NAME && !env.DISPLAY && !env.WAYLAND_DISPLAY) return ["cmd.exe", ["/c", "start", "", url]];
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    return ["xdg-open", [url]];
}

/** Starts the browser without waiting for it. Resolves to whether it could be started. */
export function openBrowser(url, options) {
    const command = openerCommand(url, options);
    if (!command) return Promise.resolve(false);
    return new Promise((resolve) => {
        const child = spawn(command[0], command[1], { stdio: "ignore", detached: true });
        child.on("error", () => resolve(false));
        child.on("spawn", () => {
            child.unref();
            resolve(true);
        });
    });
}
