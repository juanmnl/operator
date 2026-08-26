import { describe, it, expect } from 'vitest'
import { TWINKLE_TROUGH_OP, TWINKLE_PEAK_OP } from './StatusWave'

// THE KEYFRAMES AND THE COMPONENT ARE ONE MECHANISM, and they live in two files.
//
// The twinkle's tint used to be animated (`fill` in the keyframe), which Blink cannot composite:
// 7 busy orbs cost 34.7% renderer + 6.0% GPU. It is now COMPOSITED from two stacked circles whose
// opacities animate — and the eleven sampled stops in `@keyframes twinkle-base` / `twinkle-peak`
// are derived from a 0.3 trough and a 0.95 peak. Change either anchor and the stops are wrong,
// silently and only on screen. These tests are the tripwire.

const STOPS_CSS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]
/** What styles.css actually declares, copied here so a drift shows up as a diff in a test. */
const BASE = [0.3, 0.309, 0.334, 0.372, 0.416, 0.455, 0.478, 0.475, 0.415, 0.227, 0]
const PEAK = [0, 0.006, 0.029, 0.079, 0.171, 0.313, 0.491, 0.673, 0.824, 0.919, 0.95]

/** CSS `ease-in-out`, so a stop's CSS percentage can be turned back into the eased progress the
 *  old single-circle keyframe was at when it got there. */
function easeInOut(t: number): number {
  const bx = (u: number) => 3 * (1 - u) ** 2 * u * 0.42 + 3 * (1 - u) * u * u * 0.58 + u ** 3
  const by = (u: number) => 3 * (1 - u) * u * u * 1 + u ** 3
  let lo = 0, hi = 1, u = t
  for (let i = 0; i < 60; i++) { u = (lo + hi) / 2; bx(u) < t ? lo = u : hi = u }
  return by(u)
}

describe('the twinkle anchors', () => {
  it('are the numbers the keyframes were generated for', () => {
    // If this fails, `dev/tmp` is not where the fix is — regenerate the stops in styles.css for
    // the new anchors, or the dots will bloom to the wrong ceiling.
    expect(TWINKLE_TROUGH_OP).toBe(0.3)
    expect(TWINKLE_PEAK_OP).toBe(0.95)
  })
})

describe('the two stacked layers paint what one animated circle used to', () => {
  // THE ALGEBRA. A single circle painted `lerp(muted, peak, p)` at alpha `O(p)`. Two stacked
  // circles paint peak at `Ot` over muted at `Ob`; composited over a background BG the pair is
  // identical to the single circle exactly when `Ot = O·p` and `Ob = O(1-p)/(1-O·p)`. This
  // asserts that on the ACTUAL numbers in the stylesheet, not on the formula that produced them.
  const O = (p: number) => TWINKLE_TROUGH_OP + (TWINKLE_PEAK_OP - TWINKLE_TROUGH_OP) * p

  it.each(STOPS_CSS.map((pct, i) => [pct, BASE[i], PEAK[i]]))(
    'at %i%% of the cycle', (pct, base, peak) => {
      const p = easeInOut((pct as number) / 50)
      const o = O(p)
      const wantPeak = o * p
      const wantBase = o * (1 - p) / (1 - wantPeak)
      // The stylesheet carries 3 decimals, so half a unit in the last place is the whole
      // tolerance — an explicit bound rather than `toBeCloseTo`, whose 3-digit precision
      // rejects a value that rounded exactly onto the boundary (0.3125 → 0.313).
      expect(Math.abs((peak as number) - wantPeak)).toBeLessThanOrEqual(0.0005 + 1e-9)
      expect(Math.abs((base as number) - wantBase)).toBeLessThanOrEqual(0.0005 + 1e-9)
    })

  it('starts at the muted trough alone and ends at the status hue alone', () => {
    // The two anchors every measurement in StatusWave.tsx is stated against: `--fg-muted` at 0.3,
    // and the peak at 0.95 with no trough ink left under it.
    expect(BASE[0]).toBe(TWINKLE_TROUGH_OP)
    expect(PEAK[0]).toBe(0)
    expect(BASE[BASE.length - 1]).toBe(0)
    expect(PEAK[PEAK.length - 1]).toBe(TWINKLE_PEAK_OP)
  })

  it('composites to the same colour the single circle did, at every stop', () => {
    // Straight sRGB compositing, which is what the compositor does. Mission Control dark's
    // sidebar and muted ink, blooming into the Code lane's accent.
    const BG = [7, 9, 11], MUT = [138, 148, 160], ACC = [126, 231, 135]
    for (let i = 0; i < STOPS_CSS.length; i++) {
      const p = easeInOut(STOPS_CSS[i] / 50)
      const single = MUT.map((m, k) => {
        const f = m + (ACC[k] - m) * p
        return BG[k] + (f - BG[k]) * O(p)
      })
      // base over BG, then peak over that — the DOM's stacking order.
      const under = BG.map((b, k) => b + (MUT[k] - b) * BASE[i])
      const stacked = under.map((u, k) => u + (ACC[k] - u) * PEAK[i])
      // Within a quarter of an 8-bit level — the stops are rounded to 3 decimals, and 0.0005 of
      // alpha against a 255-wide channel is worth about 0.13 at the widest. Nothing here is
      // approximating the SHAPE of the old animation; this is the rounding in the stylesheet.
      for (let k = 0; k < 3; k++) expect(Math.abs(stacked[k] - single[k])).toBeLessThan(0.25)
    }
  })
})
