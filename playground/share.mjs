// Sharing the program of the editor (and the standard input text) as a link: the data lives in
// the URL fragment, compressed when the browser can, so no server is involved. Opening such a
// link loads the program into the editor but does not run it.

const PARAMETER = "share";

const toBase64Url = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (text) => {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** The fragment payload for a program and its standard input: "z" + deflate, or "r" + raw. */
export async function encodeShare({ program, input = "" }) {
    const bytes = new TextEncoder().encode(JSON.stringify({ p: program, i: input }));
    if (typeof CompressionStream === "function")
        return "z" + toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw")));
    return "r" + toBase64Url(bytes);
}

/** The program and input in a payload, or null if it is not valid. */
export async function decodeShare(payload) {
    try {
        const kind = payload[0];
        let bytes = fromBase64Url(payload.slice(1));
        if (kind === "z") bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
        else if (kind !== "r") return null;
        const data = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof data.p !== "string" || typeof (data.i ?? "") !== "string") return null;
        return { program: data.p, input: data.i ?? "" };
    } catch (error) {
        return null;
    }
}

/** `base` is the page's URL; the result is a link that opens the shared program. */
export async function shareLink(base, content) {
    const url = new URL(base);
    url.hash = `${PARAMETER}=${await encodeShare(content)}`;
    return url.toString();
}

/** The shared content in a page URL's fragment, or null when there is none (or it is invalid). */
export async function readShare(hash) {
    const match = new RegExp(`^#?${PARAMETER}=([A-Za-z0-9_-]+)$`).exec(hash);
    return match ? decodeShare(match[1]) : null;
}
