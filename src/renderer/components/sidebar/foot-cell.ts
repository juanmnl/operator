// THE FOOT CELL — one shape, shared by the seven plain controls and by `PlanMeter`, which brings
// its own button and therefore cannot be wrapped in one.
//
// THE RULE, and it is the whole reason this module exists: **the CELL is the button.** The label is
// inside it, not beside it. A labelled row whose label does nothing is a worse target than a bare
// glyph, because it advertises a hit area that is not there — and that is exactly what shipped: a
// `<div>` holding a 24px glyph button plus a separate `<span>`, so `Agents`, `Plan usage`,
// `.claude`, `~/.claude`, `Preferences` and the theme toggle were dead words with dead space around
// them. If a future item grows a label, it goes INSIDE the button.
//
// It lives in its own module rather than in `ProjectRail` because `PlanMeter` needs the identical
// treatment and importing it from the component that renders `PlanMeter` would be a cycle.

/** The glyph box, and the collapsed cell — two of them plus their gap are the collapsed field
 *  exactly (24 + 4 + 24 = 52). */
export const FOOT_BOX = 24
export const FOOT_GAP = 4

/** The cell's own chrome. Background-only for hover and current, on a radiused element: a
 *  colour-CHANGING border on a radiused box re-rasterizes in WKWebView.
 *
 *  No `opacity` anywhere. `--fg-muted` IS the recede, and multiplying it lands at 1.8–2.9:1 on the
 *  three light palettes; disabled recedes by mixing toward the strip's own background — a real
 *  colour that stays measurable — and by going inert to the pointer. */
export function footCellStyle(
  { collapsed, active, disabled }: { collapsed: boolean; active?: boolean; disabled?: boolean },
): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    // Collapsed the cell IS the glyph box; expanded it takes its half of the row. Either way the
    // glyph leads it, so the left glyph column holds its x across ⌘B.
    ...(collapsed ? { width: FOOT_BOX, flexShrink: 0 } : { flex: 1, minWidth: 0 }),
    height: FOOT_BOX, padding: 0, boxSizing: 'border-box',
    background: active ? 'var(--overlay-subtle)' : 'transparent',
    border: 'none', borderRadius: 7,
    color: disabled
      ? 'color-mix(in srgb, var(--fg-muted) 65%, var(--bg-sidebar))'
      : active ? 'var(--fg)' : 'var(--fg-muted)',
    cursor: disabled ? 'default' : 'pointer', outline: 'none', textAlign: 'left',
    transition: 'background 120ms ease, color 120ms ease',
  }
}

/** The label inside the cell — the part that used to be a separate span. Never `flex: none`: it has
 *  to be able to ellipsise, or a long word widens the foot. */
export function footLabelStyle(mono?: boolean): React.CSSProperties {
  return {
    minWidth: 0,
    fontFamily: mono ? 'var(--font-mono)' : 'var(--font-body)',
    fontSize: mono ? 10 : 11,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }
}
