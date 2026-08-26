# Perf pass 1 — the twinkle no longer animates `fill`

`@keyframes twinkle` animated `fill`, a paint property Blink cannot run on the compositor. Every
frame of every dot forced a style recalc, a main-thread repaint and a GPU re-raster, 37 dots to a
busy orb.

**Renderer 47.0% → 34.8%. GPU 9.9% → 8.0%.** Appearance preserved — measured, not asserted.

The brief's premise turned out to be half true, and the half that isn't is the interesting part,
so it is written up below rather than buried.

---

## Method

`dev/perf-orbs.html` + `dev/perf-orbs.tsx` render N real `StatusWave` orbs and nothing else, with
Mission Control dark's tokens applied. `dev/measure-orb-cpu.mjs` opens it in **Chromium** — the
engine the Electron shell actually renders in — and samples the renderer and GPU processes with
`top`, Research's instrument and cadence: `-l 14 -s 1`, discarding the first two samples while the
page settles, twelve counted. Default GPU/raster path; a measurement with the GPU disabled cannot
say anything about a change whose claim is about GPU re-raster.

Seven orbs in `running`, size 24 — the rail's own size, 37 dots each, 259 animated circles, which
is the brief's "7 lanes busy".

**Not the app with seven live lanes.** There is one Operator running this fleet and I am not
starting a second, and a pty's own CPU is noise a 12-point delta cannot survive. What is measured
is exactly the thing that changed, in the engine that renders it. Before and after were run
**alternating** (before, after, before, after, before, after) so machine drift lands on both.

Two guards, both earned. The harness refuses to report a number for a page where
`document.getAnimations()` is empty — a stale dev-server cache served a stylesheet whose
`@keyframes` were missing while the computed `animation-name` still said `twinkle-base`, and that
still page measured a beautiful **1.1%**. And the bench applies real theme tokens: without them
`fill: var(--tw-fill, var(--fg-muted))` is invalid at computed-value time and the dots paint a
colour nobody ships, which moved the numbers by a third.

## The numbers

Renderer and GPU process CPU, mean of 3 alternating runs each (12 × 1s samples per run):

| | animated circles | renderer | GPU | style recalc |
|---|---|---|---|---|
| **before** — one circle, `fill` animated | 259 | **47.0%** | **9.9%** | 59 ms/s |
| **after** — two stacked circles, opacity + transform only | 518 | **34.8%** | **8.0%** | 69 ms/s |
| *variant, not shipped* — one circle, static peak fill | 259 | *22.0%* | *6.0%* | 50 ms/s |

Spread across runs: before 44.7 / 47.0 / 49.3, after 33.5 / 33.7 / 37.2.

**−26% renderer, −19% GPU**, with the orb painting the same pixels.

## Why not the −53% in the third row

Because it is a different-looking orb, and the brief's hard constraint was that this one keeps its
appearance. The two facts collide, and the collision is the finding:

- **Removing `fill` and changing nothing else** was measured directly (single layer, no tint at
  all): **15.5% / 1.0%** on an unthemed bench, 22.0% / 6.0% themed with a static peak fill. That is
  the prize, and it costs the trough its colour: the dot would bloom from a dim ACCENT rather than
  from muted gray. Measured against today's rendering: **max ΔE\*ab 21.3, mean 9.0** across all six
  palettes and all six lane accents. This file's own threshold for "a colour stopped being
  distinguishable" is ~5. It is not the same orb.
- **Keeping the appearance costs a second circle per dot**, and Blink's per-frame cost is per
  animated element. Doubling the elements gives most of the win back. That is the whole trade, and
  it is why the headline is −26% and not −55%.

A third design was tried and rejected on measurement: a STATIC muted underlay (free — it never
animates) beneath one animated peak layer, with the peak's opacity track solved numerically to
minimise the error. Even with the optimal track it peaks at **ΔE 7.2** mid-breath, because a
fixed-size underlay cannot supply the trough ink the dot needs as it grows. Above the ~5 line, so
it was dropped.

**Blink does not composite SVG element animations at all.** `will-change: transform, opacity` on
the circles measured 25.5% against 25.5% — bit for bit no change, twice. So the remaining ~69 ms/s
of style recalc is the floor for this shape, and the only ways further down are fewer animated
elements or HTML/CSS dots instead of SVG ones. Out of scope here, and named for pass 2.

## How the appearance is preserved

Not approximated — derived. Where one circle painted `lerp(muted, peak, p)` at alpha `O(p)`, two
stacked circles paint peak at `Ot` over muted at `Ob`. Compositing them over any background is
algebraically identical to the single circle exactly when

    Ot = O·p                 Ob = O(1-p) / (1 - O·p)

`O(p) = 0.3 + 0.65p` is the opacity track the keyframe always had. The identity holds for every
`p`, every background and every accent — verified numerically at **ΔE 0.00** over six palettes ×
six accents × 21 points of the cycle.

Those two tracks are curves in the eased progress, which a three-stop ease cannot draw, so they are
**sampled every 5% of the cycle** and interpolated linearly. That sampling is the only inexactness
in the change and it is measured: **max ΔE\*ab 0.80, mean 0.16**. Under 1 is under the
just-noticeable difference.

The scale is sampled at the same stops rather than kept as a separate eased animation. That is a
perf decision with a receipt: as two animations per circle (`twinkle-scale` eased + an opacity
track linear) the after-state measured **35.4%** — no win at all; folded into one animation per
circle it measured **25.5%** on the same bench. Same pixels, 28% cheaper. The scale's own sampling
error is **0.005px** on a 24px orb.

### What actually differs on screen

Frozen at seven identical phases and diffed pixel by pixel at the rail's own 24px:

| phase | max ΔE (one pixel) | mean ΔE (whole orb) | pixels differing at all |
|---|---|---|---|
| 0% | 12.55 | 0.034 | 444 / 64000 |
| 10% | 6.92 | 0.026 | 465 / 64000 |
| 20% | 3.46 | 0.005 | 82 / 64000 |
| 25% | 7.54 | 0.016 | 444 / 64000 |
| 30% | 8.71 | 0.022 | 447 / 64000 |
| 40% | 4.35 | 0.014 | 425 / 64000 |
| 50% | 5.08 | 0.009 | 307 / 64000 |

Every differing pixel is a dot's outermost RIM, and the cause is stated rather than waved at: two
antialiased circles composite the edge coverage twice, so a rim pixel keeps slightly more trough
ink than one circle would — `(1 - c·Ot)/(1 - Ot)` of it, which is 1 at full coverage and >1 at
partial. The interiors are bit-identical. Magnified 8× side by side, before and after are
indistinguishable; the amplified diff is a hairline ring.

**The resting path was not touched**, as instructed, and that is checked rather than claimed:
`idle`, `waiting`, `error` and `ended` render **byte-identical** PNGs before and after.

## What changed

| File | Change |
|------|--------|
| `src/renderer/styles.css` | `@keyframes twinkle` → `twinkle-base` + `twinkle-peak`, eleven sampled stops each, opacity + transform only. The derivation, the measurement and the reason for every number are in the comment above them |
| `src/renderer/components/sidebar/StatusWave.tsx` | animated dots render two stacked circles; `TWINKLE_TROUGH_OP` / `TWINKLE_PEAK_OP` replace the `--tw-max` variable, which every animated state set to the same 0.95 and which hid the keyframes' coupling to it |
| `src/renderer/components/sidebar/StatusWave.test.ts` | new — 14 tests: the anchors, every stop against the closed form, and the composite against what the single circle painted |
| `dev/perf-orbs.html` · `dev/perf-orbs.tsx` · `dev/measure-orb-cpu.mjs` | the bench and the instrument, so the next pass measures the same way |

`tsc --noEmit` clean. 942 passing; the 33 failures are pre-existing and unrelated (`localStorage`
undefined in several suites, identical on the main checkout).

## For pass 2

- **259 animated SVG elements is the real ceiling.** Blink ticks every one on the main thread and
  will not composite them. HTML dots (or one dot per orb with a mask) is the only order-of-magnitude
  move left.
- **A busy orb costs ~5% renderer per lane on its own.** Seven busy lanes is 35% of a core before
  anything else draws. Not animating orbs that are scrolled out of the rail, or dropping the
  twinkle to 30fps with `steps()`, are both cheaper than re-architecting it.
