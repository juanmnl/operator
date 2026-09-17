// TOOLBAR ICONS, on one grid. The Preview toolbar used to draw its controls as Unicode text
// (◀ ▶ ⟳ ↩ ↗ ▾ ▴ ●). Each of those falls back to whichever installed font has it, with that font's
// own metrics, so at one font size they rendered at visibly different optical sizes: the reload
// arrow was the smallest thing on the bar.
//
// THE GRID: a 16-unit viewBox, a 1.5-unit stroke with round caps and joins, `currentColor`, and
// every mark drawn inside 3–13 so they share one optical size. Rendered at 12px by default, which is
// a 1.125px stroke: the weight of the rail foot's glyphs (ProjectRail `FootItem`, 1.2 on 16 at 14px
// ≈ 1.05px).
//
// Two verbs never share a glyph: `back` is a chevron (address history), `root` is a return arrow
// (go to `/`), `reload` is a circular arrow.

export type ToolbarIconName = 'back' | 'forward' | 'reload' | 'root' | 'external' | 'caret-down' | 'caret-up'

const PATHS: Record<ToolbarIconName, string[]> = {
  back: ['M10 3.5 5.5 8 10 12.5'],
  forward: ['M6 3.5 10.5 8 6 12.5'],
  // An open circle with its arrowhead at the top right.
  reload: ['M12.5 8A4.5 4.5 0 1 1 11.2 4.8', 'M12.8 2.8V5.3H10.3'],
  // Down from the top right, then left to the arrowhead: "back up to the root".
  root: ['M12.5 3.5V6.5A2.5 2.5 0 0 1 10 9H3.8', 'M6.3 6.5 3.8 9 6.3 11.5'],
  // A box with an arrow leaving its corner.
  external: ['M9 3H13V7', 'M13 3 7.5 8.5', 'M11.5 9.5V12A1 1 0 0 1 10.5 13H4A1 1 0 0 1 3 12V5.5A1 1 0 0 1 4 4.5H6.5'],
  // Disclosure carets, drawn smaller inside the same grid so the stroke stays the same weight.
  'caret-down': ['M5 6.5 8 9.5 11 6.5'],
  'caret-up': ['M5 9.5 8 6.5 11 9.5'],
}

export const TOOLBAR_ICON_NAMES = Object.keys(PATHS) as ToolbarIconName[]

export function ToolbarIcon({ name, size = 12 }: { name: ToolbarIconName; size?: number }) {
  return (
    <svg
      data-toolbar-icon={name}
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  )
}

/** A status dot drawn as a box, not a `●` glyph: a glyph's size depends on the fallback font. A
 *  dynamic background on a round box is cheap; there is no border to re-rasterise. */
export function StatusDot({ color, size = 6 }: { color: string; size?: number }) {
  return <span aria-hidden data-status-dot style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
}
