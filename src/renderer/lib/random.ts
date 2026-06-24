// Deterministic seeded pseudo-randomness for the status-wave / brand-mark dots.
// Sine-hash (not cryptographic) — stable per index so a session's dot rhythm is
// reproducible. Mirrors the Rust tray_anim::rand so the menu-bar icon matches.

/** Deterministic pseudo-random in [0,1) from a numeric seed. */
export function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** Fold a string (or pass a number through) into a stable numeric seed, so two
 *  different session ids land on different parts of the sine curve. */
export function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') return seed
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1000003
  return h
}

/** Grid-cell centres that fall within a disc — the dot layout of the brand mark.
 *  `cells`×`cells` grid, centre at (cells-1)/2+0.5, radius in cell units (with a
 *  1.04 tolerance to include cells grazing the edge). */
export function gridPointsInDisc(cells: number, radius: number): { cx: number; cy: number }[] {
  const out: { cx: number; cy: number }[] = []
  const center = (cells - 1) / 2 + 0.5
  const max = radius * radius * 1.04
  for (let c = 0; c < cells; c++) {
    for (let r = 0; r < cells; r++) {
      const cx = c + 0.5, cy = r + 0.5
      const dx = cx - center, dy = cy - center
      if (dx * dx + dy * dy <= max) out.push({ cx, cy })
    }
  }
  return out
}
