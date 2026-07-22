// The accent swatches offered by the orb colour picker.
//
// Lane accents are DATA (they live on the Project roster, per role), not theme tokens —
// which is why they're literal hexes here rather than CSS vars: a var would resolve to a
// different colour per theme, so a lane would change identity when the theme changed, and
// the value persisted into projects.json has to be a real colour. Every one of these is
// run through `laneTextColor` before being drawn as text, so they stay readable on light
// themes (see lib/lane-color).
import { defaultRoster } from './roster'

/** The six default lane accents, taken from the roster itself so the picker can never
 *  drift from the colours a fresh project is seeded with. */
export const DEFAULT_LANE_ACCENTS: string[] = defaultRoster()
  .map((r) => r.accent)
  .filter((a): a is string => !!a)

/** A small extension so a project with more agents than default lanes still has distinct
 *  choices — same saturation/lightness family as the defaults, so the set reads as one
 *  palette on both canvases. */
export const EXTRA_LANE_ACCENTS: string[] = [
  '#4ade80', // mint
  '#38bdf8', // sky
  '#a78bfa', // periwinkle
  '#fb7185', // rose
  '#f59e0b', // amber
  '#94a3b8', // slate — the deliberate "no colour" choice
]

export const ACCENT_SWATCHES: string[] = [...DEFAULT_LANE_ACCENTS, ...EXTRA_LANE_ACCENTS]

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Accept `#abc` / `#aabbcc` (case-insensitive), normalised to lowercase 6-digit form.
 *  Returns null for anything else, so a half-typed value never reaches the roster. */
export function normalizeHex(input: string): string | null {
  const v = input.trim().toLowerCase()
  if (!HEX.test(v)) return null
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  return v
}

/** Same colour? Compares normalised, so `#FFF` and `#ffffff` count as one swatch. */
export function sameAccent(a?: string, b?: string): boolean {
  if (!a || !b) return false
  return (normalizeHex(a) ?? a.trim().toLowerCase()) === (normalizeHex(b) ?? b.trim().toLowerCase())
}
