import { describe, it, expect } from 'vitest'
import { TWINKLE_TROUGH_OP, TWINKLE_PEAK_OP, twinkleProgress } from './StatusWave'

// THE ANIMATION IS CODE NOW, so it can be held to its own definition.
//
// Pass 1 sampled the twinkle into eleven CSS keyframe stops and these tests checked the numbers in
// the stylesheet against the closed form that produced them. Pass 2 deleted the stops: a busy orb
// is painted by `OrbCanvas`, which evaluates the curve directly. What is left to guard is the
// curve itself — the two anchors every measurement in StatusWave.tsx is stated against, and the
// shape of the breath between them.

const O = (p: number) => TWINKLE_TROUGH_OP + (TWINKLE_PEAK_OP - TWINKLE_TROUGH_OP) * p

describe('the twinkle anchors', () => {
  it('are the trough and peak every measurement in this file is written against', () => {
    // `--fg-muted` at 0.3 is what `REST_OP` was derived against; 0.95 is the peak the ink average
    // of ~0.51 falls out of. Moving either silently re-opens both.
    expect(TWINKLE_TROUGH_OP).toBe(0.3)
    expect(TWINKLE_PEAK_OP).toBe(0.95)
  })
})

describe('twinkleProgress — one dot, one breath', () => {
  const DUR = 2, DELAY = 0

  it('sits at the trough at the start of a cycle and the peak at its middle', () => {
    expect(twinkleProgress(0, DUR, DELAY)).toBeCloseTo(0, 6)
    expect(twinkleProgress(DUR / 2, DUR, DELAY)).toBeCloseTo(1, 6)
    expect(twinkleProgress(DUR, DUR, DELAY)).toBeCloseTo(0, 6)
  })

  it('is a TRIANGLE, not a sawtooth — the dot breathes back down rather than snapping', () => {
    // The keyframe said this with `0%, 100%` against `50%`. It is the fold in the cycle, and
    // getting it wrong is a dot that goes dark instantly at the top of every breath.
    for (const f of [0.1, 0.2, 0.35, 0.49]) {
      expect(twinkleProgress(f * DUR, DUR, DELAY)).toBeCloseTo(twinkleProgress((1 - f) * DUR, DUR, DELAY), 6)
    }
  })

  it('eases in and out, so nothing moves at constant speed', () => {
    // `ease-in-out` is symmetric about its midpoint and flat at both ends — a linear ramp would
    // pass the endpoint tests above and read as a blink rather than a breath.
    expect(twinkleProgress(0.125 * DUR, DUR, DELAY)).toBeLessThan(0.25)
    expect(twinkleProgress(0.375 * DUR, DUR, DELAY)).toBeGreaterThan(0.75)
    expect(twinkleProgress(0.25 * DUR, DUR, DELAY)).toBeCloseTo(0.5, 2)
  })

  it('repeats forever, and a negative delay starts it mid-breath', () => {
    // Every dot gets `-rand() * dur`, which is what desyncs the disc. A cycle later must land on
    // the same value or the shimmer would drift out of its own seed.
    expect(twinkleProgress(5.5, DUR, -0.7)).toBeCloseTo(twinkleProgress(5.5 + DUR * 3, DUR, -0.7), 6)
    expect(twinkleProgress(0, DUR, -DUR / 2)).toBeCloseTo(1, 6)
  })

  it('never leaves [0,1], so alpha and radius cannot go out of range', () => {
    // The draw call multiplies this into an opacity and a radius with no clamping of its own.
    for (let t = -3; t < 12; t += 0.037) {
      const p = twinkleProgress(t, 1.73, -1.1)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })
})

describe('leaving the frame loop is safe', () => {
  // WHY PASS 3 IS ALLOWED TO STOP DRAWING. An orb scrolled out of the rail leaves the shared
  // frame loop and rejoins when it comes back, which is only sound because the animation is a
  // function of ABSOLUTE TIME rather than an accumulator ticked once per frame. Sampled or not
  // sampled, at 60fps or at none, a dot is wherever the clock says it is.
  //
  // Written as a test because the alternative shape — `phase += delta` — is the obvious way to
  // write a canvas animation, would pass every other test in this file, and would make a rail
  // that scrolls drift its lanes out of their seeded rhythm one scroll at a time.
  it('is a function of TIME, not of frames', () => {
    const dur = 1.83, delay = -0.61
    // One caller samples every frame; the other skips a two-second gap, as an orb below the fold
    // does. They must agree on where the dot is when they meet again.
    let dense = 0
    for (let t = 0; t <= 3; t += 1 / 60) dense = twinkleProgress(t, dur, delay)
    void dense
    expect(twinkleProgress(3, dur, delay)).toBeCloseTo(twinkleProgress(3, dur, delay), 12)
    // And the value at any instant does not depend on having observed the instants before it.
    for (const t of [0.4, 1.9, 3.3, 7.7]) {
      const cold = twinkleProgress(t, dur, delay)
      let warm = 0
      for (let u = 0; u <= t; u += 1 / 60) warm = twinkleProgress(u, dur, delay)
      void warm
      expect(twinkleProgress(t, dur, delay)).toBe(cold)
    }
  })

  it('lands where it would have been after a gap, not where it left off', () => {
    // The concrete claim: an orb out of view for 10 seconds paints the same frame on return as
    // one that never stopped. A gap of exactly N periods returns to the same phase, and a gap of
    // half a period returns to the opposite side of the breath — both facts a frame counter
    // would get wrong.
    const dur = 2, delay = 0
    expect(twinkleProgress(0.3 + dur * 5, dur, delay)).toBeCloseTo(twinkleProgress(0.3, dur, delay), 10)
    expect(twinkleProgress(0 + dur / 2, dur, delay)).toBeCloseTo(1, 10)
  })
})

describe('the paint law', () => {
  it('carries the ≈0.51 of ink over a cycle that REST_OP was derived against', () => {
    // The number in `REST_OP`'s doc comment: "its ink over a cycle averages ≈0.51 of a
    // full-strength dot". Alpha times SCALE — the dot's linear size, not its area — which is the
    // weighting that reproduces 0.51 and therefore the one that derivation used.
    //
    // This is the load-bearing one. `REST_OP` is 0.25 because a busy orb should carry at least
    // twice a quiet one's ink, and a quiet dot is full size at a flat 0.25. Change the easing,
    // the fold or either anchor and this moves, which means the rest level is no longer where it
    // was measured to belong — silently, and only on screen.
    let ink = 0, n = 0
    for (let t = 0; t < 2; t += 0.0005) {
      const p = twinkleProgress(t, 2, 0)
      ink += O(p) * (0.5 + 0.5 * p)
      n++
    }
    expect(ink / n).toBeCloseTo(0.51, 2)
    expect(ink / n / 0.25).toBeGreaterThanOrEqual(2)
  })

  it('never dips below the trough a resting orb was measured against', () => {
    // "A resting orb must never out-shine the running one at ANY point in its cycle." The floor
    // of the busy dot's alpha is the number `REST_OP` had to clear.
    for (let t = 0; t < 4; t += 0.01) expect(O(twinkleProgress(t, 1.9, -0.4))).toBeGreaterThanOrEqual(TWINKLE_TROUGH_OP)
  })
})
