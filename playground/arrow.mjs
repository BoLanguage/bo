// Where the guide's small arrow stands. Pure functions over rectangles `{left, top, width, height}` (as
// getBoundingClientRect gives), so they need no DOM.

export const ARROW = { length: 40, thickness: 24, gap: 8, margin: 4 };

// the arrow is drawn pointing left; turning it clockwise by these angles makes it point at its target
const ROTATION = { right: 0, bottom: 90, left: 180, top: 270 };

/**
 * The arrow on `side` of `target`, pointing at it: `{x, y, rotate}` (the arrow's centre in pixels and its turn in
 * degrees), or null when it would not fit in `viewport` (`{width, height}`). `along` (0 to 1, default the middle) is
 * where along that side it stands. `side` is the side of the target the arrow is on, so an arrow on the "right"
 * points left.
 */
export function arrowPlacement(target, side, viewport, { along = 0.5 } = {}) {
    if (!(side in ROTATION)) return null;
    const { length, thickness, gap, margin } = ARROW;
    const horizontal = side === "left" || side === "right";
    const reach = gap + length / 2;
    const x = horizontal
        ? (side === "right" ? target.left + target.width + reach : target.left - reach)
        : target.left + target.width * along;
    const y = horizontal
        ? target.top + target.height * along
        : (side === "bottom" ? target.top + target.height + reach : target.top - reach);
    const halfWidth = (horizontal ? length : thickness) / 2;
    const halfHeight = (horizontal ? thickness : length) / 2;
    const fits = x - halfWidth >= margin && x + halfWidth <= viewport.width - margin &&
                 y - halfHeight >= margin && y + halfHeight <= viewport.height - margin;
    return fits ? { x: Math.round(x), y: Math.round(y), rotate: ROTATION[side] } : null;
}

/** The rectangle an arrow placement covers. */
export function arrowRect({ x, y, rotate }) {
    const horizontal = rotate === 0 || rotate === 180;
    const width = horizontal ? ARROW.length : ARROW.thickness;
    const height = horizontal ? ARROW.thickness : ARROW.length;
    return { left: x - width / 2, top: y - height / 2, width, height };
}

/**
 * Which side of the window the card sits on, so that it stays clear of its target: the top when the target is low
 * and in the card's own column. A target to the side leaves the card at the bottom.
 */
export function cardPlacement(target, viewportHeight, card = null) {
    const low = target.top + target.height / 2 > viewportHeight * 0.6;
    const beside = card && (target.left + target.width <= card.left || target.left >= card.left + card.width);
    return low && !beside ? "top" : "bottom";
}

/** The smallest rectangle holding both. */
export function union(a, b) {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    return {
        left,
        top,
        width: Math.max(a.left + a.width, b.left + b.width) - left,
        height: Math.max(a.top + a.height, b.top + b.height) - top,
    };
}
