// The editor sidebar: opens and closes with a tab on its edge, and is resized by dragging that
// edge (or with the arrow keys). The width is kept between visits.

const MIN_WIDTH = 300;
const MIN_PAGE = 480;
const KEY = "bo-sidebar-width";

/**
 * @param {object} parts
 * @param {HTMLElement} parts.layout the element that holds the sidebar column (gets the "editor-open" class)
 * @param {HTMLElement} parts.content the sidebar's clipped content (made inert while closed)
 * @param {HTMLElement} parts.toggle the tab button on the sidebar's edge
 * @param {HTMLElement} parts.resizer the draggable edge (role="separator")
 * @param {(open: boolean) => void} [parts.onChange] called after the sidebar opened or closed
 * @param {() => void} [parts.onResize] called when the width changed
 * @param {() => Promise<boolean>} [parts.beforeOpen] asked before the tab opens the sidebar; false keeps it closed
 */
export function createSidebar({ layout, content, toggle, resizer, onChange = () => {}, onResize = () => {}, beforeOpen = async () => true }) {
    // the page next to the sidebar keeps at least MIN_PAGE pixels
const maxWidth = () => Math.max(MIN_WIDTH, Math.min(900, window.innerWidth - MIN_PAGE));
    const clamp = (px) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(px)));
    const isOpen = () => layout.classList.contains("editor-open");
    const currentWidth = () => Math.round(content.getBoundingClientRect().width) || clamp(window.innerWidth * 0.34);

    function setWidth(px, { save = false } = {}) {
        const width = clamp(px);
        layout.style.setProperty("--sidebar-w", `${width}px`);
        resizer.setAttribute("aria-valuenow", String(width));
        if (save) {
            try {
                localStorage.setItem(KEY, String(width));
            } catch (error) {
                // the width just is not remembered
            }
        }
        onResize();
        return width;
    }

    function resetWidth() {
        layout.style.removeProperty("--sidebar-w");
        try {
            localStorage.removeItem(KEY);
        } catch (error) {
            // nothing to forget
        }
        resizer.setAttribute("aria-valuenow", String(currentWidth()));
        onResize();
    }

    function setOpen(open) {
        layout.classList.toggle("editor-open", open);
        content.inert = !open;
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Hide the editor" : "Show the editor");
        resizer.hidden = !open;
        onChange(open);
    }

    toggle.addEventListener("click", async () => {
        const opening = !isOpen();
        if (opening && !(await beforeOpen())) return;
        setOpen(opening);
    });

    // dragging the edge
    resizer.setAttribute("aria-valuemin", String(MIN_WIDTH));
    resizer.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        layout.classList.add("resizing"); // no slide while the pointer drives the width
        const left = layout.getBoundingClientRect().left;
        const move = (e) => setWidth(e.clientX - left);
        const stop = (e) => {
            resizer.removeEventListener("pointermove", move);
            resizer.removeEventListener("pointerup", stop);
            resizer.removeEventListener("pointercancel", stop);
            layout.classList.remove("resizing");
            setWidth(e.clientX - left, { save: true });
        };
        resizer.addEventListener("pointermove", move);
        resizer.addEventListener("pointerup", stop);
        resizer.addEventListener("pointercancel", stop);
    });
    resizer.addEventListener("keydown", (event) => {
        const step = event.shiftKey ? 80 : 24;
        if (event.key === "ArrowLeft") setWidth(currentWidth() - step, { save: true });
        else if (event.key === "ArrowRight") setWidth(currentWidth() + step, { save: true });
        else return;
        event.preventDefault();
    });
    resizer.addEventListener("dblclick", resetWidth);

    // restore the saved width, and keep it valid when the window shrinks
    try {
        const saved = Number(localStorage.getItem(KEY));
        if (saved) setWidth(saved);
    } catch (error) {
        // no saved width
    }
    window.addEventListener("resize", () => {
        if (layout.style.getPropertyValue("--sidebar-w")) setWidth(parseInt(layout.style.getPropertyValue("--sidebar-w"), 10));
    });

    setOpen(false);
    resizer.setAttribute("aria-valuemax", String(maxWidth()));
    return { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!isOpen()), isOpen };
}
