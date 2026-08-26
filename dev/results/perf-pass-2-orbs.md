# Perf pass 2 — a busy orb is painted, not animated

**Renderer 35.4% → 7.3%. GPU 9.0% → 1.8%.** Renderer RSS 580 → 430 MB, GPU RSS 58 → 44 MB.
Seven busy orbs, and the orb draws the same dots — measurably closer to the original than the
implementation it replaces.

Pass 1 found the floor and named it: Blink never composites SVG element animations, so 518
elements are 518 style recalcs a frame whatever is animated on them. Both ways past it were
measured. Only one of them worked, and it was not the one the premise expected.

---

## The two candidates

Same bench and same protocol as pass 1 — `dev/perf-orbs.html` with seven `running` orbs at the
rail's own 24px, Chromium, `top -l 14 -s 1` with the first two samples discarded, three
alternating runs. `dev/measure-orb-cpu.mjs` now also samples resident memory, because the cheapest
CPU here is bought with compositor layers and a layer is a texture.

| | elements | renderer | GPU | style recalc | renderer RSS | GPU RSS |
|---|---|---|---|---|---|---|
| **before** — two stacked SVG circles per dot | 518 | **35.4%** | **9.0%** | 69 ms/s | 580 MB | 58 MB |
| (a) HTML `<div>` dots | 518 | 33.8% | 8.2% | 83 ms/s | 567 MB | 58 MB |
| (b) **one canvas per orb** ← shipped | 7 | **7.3%** | **1.8%** | **0 ms/s** | 430 MB | 44 MB |

At `devicePixelRatio: 2`, which is what the user's machine actually runs: SVG 39.6% / 8.7%, HTML
37.4% / 8.9%, canvas **7.7% / 2.0%**. The canvas is the only one that does not care.

### (a) HTML dots — Blink promotes them, and it changes nothing

The premise was right about the mechanism and wrong about the outcome. Asked directly through
`LayerTree.compositingReasons`, Blink reports `ActiveTransformAnimation, ActiveOpacityAnimation`
on the dot layers: they ARE composited, exactly as hoped. The CPU does not move — 33.8% against
33.2% for the SVG it replaced, and main-thread style recalc goes UP (83 ms/s against 67).

518 compositor layers of three-and-a-half pixels each cost in bookkeeping and blending what they
save in style. It is not a layer-budget cliff either: one orb alone (74 dots) measured 8.5%
against SVG's 7.1%, so it is worse per element at every scale, not past some threshold.

There was no layer-memory explosion to report — the layers are tiny — but there was a fidelity
cost nobody asked for: a `border-radius: 50%` box antialiases differently from a circle, and the
HTML orb lost **16% of its total ink** and measured ΔE\*ab 10.6 mean against the original. It
loses on both axes.

### (b) One canvas per orb — 37 elements become 1

Nothing is CSS-animated. One shared `requestAnimationFrame` paints every orb on the page, so
seven busy lanes are seven elements and one callback. Style recalc and layout both go to **zero**;
the cost becomes 23 ms/s of script, which is the drawing.

## It is more faithful than what it replaces

This was the surprise, and it inverts how the fidelity bar has to be read.

Measured against the orb's own **static geometry** — the same dots at the same instant with the
opacity, radius and colour baked into plain SVG attributes, nothing animated:

| | mean ΔE | p50 | p95 | max | pixels differing >1 level |
|---|---|---|---|---|---|
| **shipped canvas** | **0.66** | 0.69 | 1.32 | 1.83 | **9 / 18000** |
| pass-1 two-layer SVG | 5.77 | 4.81 | 13.86 | 25.72 | 2740 / 18000 |
| pre-pass-1 original SVG | 5.62 | 4.63 | 13.81 | 23.47 | 2803 / 18000 |

The canvas is a pixel-exact rendering of the geometry. **Both** SVG implementations sit ~5.7 away
from that same geometry, and they sit that far away from each other's ancestor for the same
reason: an animated SVG transform is rasterised and then scaled, which softens every dot's edge.
That softness is why "canvas vs the shipped orb" reads as ΔE 5.6 — it is the shipped orb's blur,
not the canvas's error. At 120px, where a dot is mostly interior rather than edge, canvas-vs-SVG
median ΔE collapses to 0.85; at 24px a 3.4px dot is nearly all edge, which is where the number
comes from.

Total ink says the same thing from the other side. Against the pre-pass-1 original: the shipped
SVG carries **+3.8%**, the canvas **+1.6%**, the static geometry +0.7%. The canvas is closer to
the orb as designed than the build now in the repo is.

So the pass-1 bar is met in the way that matters: same dots, same size, same colour, same phase,
same seeded rhythm. What changed is that they are no longer drawn through a blur.

**The resting path was not touched at all** and still renders **byte-identical** PNGs for `idle`,
`waiting`, `error` and `ended`. Rest is most of the rail most of the time, it already costs
nothing, and its ink levels carry measured receipts that a change of rasteriser would reopen.

## Fixed on the way past: the brand mark has not shimmered since pass 1

`LogoMark` animated its dots with `@keyframes twinkle`. Pass 1 renamed that keyframe to
`twinkle-base`/`twinkle-peak` for the orb and left the mark pointing at a rule that no longer
existed, so the empty-gallery logo has been frozen since `005907c`. My regression, caught only
because pass 2 went to delete those keyframes and asked who else used them.

It now has `@keyframes twinkle-logo` — its own rule, carrying its own 0.85 ceiling, animating
`fill` exactly as the mark always did. Animating a paint property is affordable there in a way it
never was in the rail: one mark, on a screen with nothing else on it. `dev/logo-check.html` +
`dev/tmp/logo.mjs` confirm 97 running animations and moving pixels.

## What a painted orb has to answer for

- **Colours must be resolved, not referenced.** A canvas cannot read `var(--fg-muted)`.
  `resolveColor` asks the browser through one hidden probe element (shared by the whole app,
  cached per value), so a var chain or a `color-mix` resolves the way CSS says it does rather than
  the way a hand-written parser guesses.
- **A theme swap has to be noticed.** A CSS-var orb re-tints for free; a painted one holds
  resolved colours. One `MutationObserver` on `<html>`'s `style`/`class`/`data-theme` clears the
  cache and bumps an epoch every canvas subscribes to. Verified: rewriting `--fg-muted` and
  `--status-running` at runtime repaints the dots.
- **`devicePixelRatio` can change mid-life** when the window moves to another display. The ratio
  is re-read each frame (a number comparison) and the backing store resized only when it actually
  changed.
- **One loop, not one per orb.** A rail with nothing running cancels the frame callback entirely.

## What changed

| File | Change |
|------|--------|
| `src/renderer/components/sidebar/StatusWave.tsx` | `OrbCanvas` + a shared frame loop + `resolveColor` + theme epoch; animated dots carry timing instead of styles; resting path untouched |
| `src/renderer/styles.css` | `twinkle-base`/`twinkle-peak` deleted (nothing animates them now); `twinkle-logo` added, restoring the brand mark |
| `src/renderer/components/LogoMark.tsx` | points at `twinkle-logo`; drops the dead `--tw-max` |
| `src/renderer/components/sidebar/StatusWave.test.ts` | rewritten — the curve is code now, so the tests hold the curve: anchors, the triangle fold, the easing, and the ≈0.51 cycle ink that `REST_OP` was derived against |
| `dev/orb-candidates.tsx` | both candidates plus two references (the pre-pass-1 orb, and the geometry with no animation) — kept, because the next pass will want the same comparison |
| `dev/perf-orbs.tsx` · `dev/measure-orb-cpu.mjs` | `?impl=`, `?at=`, `?initial=`; memory and layer counts; the liveness guard now diffs two screenshots |
| `dev/logo-check.html` · `dev/logo-check.tsx` | the brand mark on its own, so the next rename gets caught |

`tsc --noEmit` clean. 936 passing; the 33 failures are pre-existing and unrelated (`localStorage`
undefined in several suites, identical on the main checkout).

## Two method notes, both earned

**The liveness guard had to change.** Pass 1's guard was `document.getAnimations().length`, which
is blind in both directions here: a canvas orb has no CSS animations and would have been called
still, and a broken CSS orb whose `@keyframes` is missing still computes an `animation-name`. It
now takes two screenshots a third of a second apart and refuses to report a number unless the
pixels moved.

**`animation-play-state: paused` is not a freeze.** The first equivalence runs paused the
animations with an injected rule and diffed the results — and same-versus-same diffed to zero, so
the method looked sound. It was not: the rule lands whenever it lands, so both sides were frozen
at "roughly 800ms in", reproducibly. Two identical animations then looked like different ones.
The fix is to name the instant — `Animation.currentTime = T` for the CSS candidates, and a pinned
`performance.now()` for the painted one, which needs no seam in the component.

## For pass 3

- **A canvas orb still paints when nobody can see it.** An `IntersectionObserver` that drops
  scrolled-out orbs from the frame loop is now a two-line change, where under CSS animations it
  was impossible.
- **23 ms/s of script is the new floor**, and it is 259 `arc()` calls a frame. Drawing the dots
  once into an offscreen sprite and blitting scaled copies would cut most of it, if it ever
  matters — at 7.3% for the whole rail, it does not yet.
