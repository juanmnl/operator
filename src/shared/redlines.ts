// Redlines: Figma-style measurement against the live page in the Preview's native inspect view.
// The math is here, pure. The drawing is `src/shared/preview-overlay.js`, which runs inside the
// page and gets these functions as source from the main process.
//
// Every exported function is SELF-CONTAINED: no runtime imports, no module constants, and no calls
// to each other. That is what lets `String(fn)` be a working copy inside the page, and tests run
// each one rebuilt from its string. Keep it that way.

/** A box in CSS px of the page, as `getBoundingClientRect` reports it. */
export interface Box { left: number; top: number; right: number; bottom: number }

/** One line to draw. `value` is its length in CSS px. `null` marks a dashed extension line, which
 *  carries no number. Horizontal when `y1 === y2`. */
export interface Segment { x1: number; y1: number; x2: number; y2: number; value: number | null }

/** The distances between two boxes, per the design spec's rules:
 *
 *  1. One contains the other → four insets from inner to outer, each drawn through the inner box's
 *     centre line. Zero-length insets are not drawn.
 *  2. Separated horizontally → one horizontal line between the facing edges, at the middle of the
 *     vertical overlap. With no vertical overlap it runs at A's vertical centre, and a dashed
 *     extension runs along B's edge to meet it.
 *  3. Separated vertically → the same on the other axis. Diagonal neighbours get both lines.
 *  4. Overlapping, neither contains → the left-edge offset and the top-edge offset.
 *
 *  `a` is the anchor (or the hovered element); `b` is the other element or the container. */
export function measureBetween(a: Box, b: Box): Segment[] {
  const eps = 0.01
  const segs: Segment[] = []
  const aInB = b.left <= a.left && b.top <= a.top && b.right >= a.right && b.bottom >= a.bottom
  const bInA = a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom

  if (aInB || bInA) {
    const outer = aInB ? b : a
    const inner = aInB ? a : b
    const cx = (inner.left + inner.right) / 2
    const cy = (inner.top + inner.bottom) / 2
    if (inner.left - outer.left > eps) segs.push({ x1: outer.left, y1: cy, x2: inner.left, y2: cy, value: inner.left - outer.left })
    if (outer.right - inner.right > eps) segs.push({ x1: inner.right, y1: cy, x2: outer.right, y2: cy, value: outer.right - inner.right })
    if (inner.top - outer.top > eps) segs.push({ x1: cx, y1: outer.top, x2: cx, y2: inner.top, value: inner.top - outer.top })
    if (outer.bottom - inner.bottom > eps) segs.push({ x1: cx, y1: inner.bottom, x2: cx, y2: outer.bottom, value: outer.bottom - inner.bottom })
    return segs
  }

  const toRight = b.left >= a.right
  const toLeft = b.right <= a.left
  const below = b.top >= a.bottom
  const above = b.bottom <= a.top

  if (toRight || toLeft) {
    const x1 = toRight ? a.right : b.right
    const x2 = toRight ? b.left : a.left
    const overlapTop = Math.max(a.top, b.top)
    const overlapBottom = Math.min(a.bottom, b.bottom)
    let y = (overlapTop + overlapBottom) / 2
    if (overlapBottom <= overlapTop) {
      y = (a.top + a.bottom) / 2
      const edge = toRight ? b.left : b.right
      segs.push({ x1: edge, y1: y, x2: edge, y2: y < b.top ? b.top : b.bottom, value: null })
    }
    segs.push({ x1, y1: y, x2, y2: y, value: x2 - x1 })
  }

  if (below || above) {
    const y1 = below ? a.bottom : b.bottom
    const y2 = below ? b.top : a.top
    const overlapLeft = Math.max(a.left, b.left)
    const overlapRight = Math.min(a.right, b.right)
    let x = (overlapLeft + overlapRight) / 2
    if (overlapRight <= overlapLeft) {
      x = (a.left + a.right) / 2
      const edge = below ? b.top : b.bottom
      segs.push({ x1: x, y1: edge, x2: x < b.left ? b.left : b.right, y2: edge, value: null })
    }
    segs.push({ x1: x, y1, x2: x, y2, value: y2 - y1 })
  }

  if (segs.length) return segs

  const midY = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2
  const midX = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2
  const dx = Math.abs(a.left - b.left)
  const dy = Math.abs(a.top - b.top)
  if (dx > eps) segs.push({ x1: Math.min(a.left, b.left), y1: midY, x2: Math.max(a.left, b.left), y2: midY, value: dx })
  if (dy > eps) segs.push({ x1: midX, y1: Math.min(a.top, b.top), x2: midX, y2: Math.max(a.top, b.top), value: dy })
  return segs
}

/** Rule 5: CSS px as an integer when within 0.01 of one, otherwise one decimal (`12.5`). */
export function formatPx(v: number): string {
  const r = Math.round(v)
  return Math.abs(v - r) <= 0.01 ? String(r) : v.toFixed(1)
}

/** Where a segment's value chip goes: centred on its line; outside the line's end when the line is
 *  shorter than the chip (before its start if the end is at the viewport edge); and always kept
 *  inside the viewport. All in CSS px of the page. */
export function placeChip(seg: Segment, chipW: number, chipH: number, viewW: number, viewH: number): { left: number; top: number } {
  const gap = 4
  const horizontal = seg.y1 === seg.y2
  let cx = (seg.x1 + seg.x2) / 2
  let cy = (seg.y1 + seg.y2) / 2
  if (horizontal && Math.abs(seg.x2 - seg.x1) < chipW + gap) {
    const after = Math.max(seg.x1, seg.x2) + gap + chipW / 2
    cx = after + chipW / 2 <= viewW ? after : Math.min(seg.x1, seg.x2) - gap - chipW / 2
  }
  if (!horizontal && Math.abs(seg.y2 - seg.y1) < chipH + gap) {
    const after = Math.max(seg.y1, seg.y2) + gap + chipH / 2
    cy = after + chipH / 2 <= viewH ? after : Math.min(seg.y1, seg.y2) - gap - chipH / 2
  }
  return {
    left: Math.max(0, Math.min(cx - chipW / 2, viewW - chipW)),
    top: Math.max(0, Math.min(cy - chipH / 2, viewH - chipH)),
  }
}
