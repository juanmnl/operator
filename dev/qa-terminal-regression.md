# Terminal regression run — 2026-07-23

Regression pass of the four terminal harnesses against the current uncommitted
`TerminalPane.tsx` changes (the `hardRepaint` nudge switching from the inert
`translateZ(0)` no-op to a real `translate3d(0, 0.02px, 0)` sub-pixel
translate, plus the terminal-registry wiring for the ⌘K buffer-dump command),
against the 2026-07-22 baseline in `dev/garble-triage.md`.

## Harness results

| harness | baseline (2026-07-22) | this run | verdict |
|---|---|---|---|
| `npm run verify:dom` | 0/30 row mismatches | **0/30** | PASS — clean |
| `npm run verify:width` | 0/52 glyph, 0/20 wrap-row | **0/52 glyph, 0/20 wrap-row** | PASS — clean |
| `npm run verify:input` | (not in baseline doc; all 6 assertions pass) | **6/6 assertions pass** | PASS — clean |
| `npm run verify:visual` | clean glyph battery, no tofu/garble | **clean** — screenshot inspected by eye, box drawing continuous, no tofu, no ghosting | PASS — clean |

`npm run build` and `npm test` (189/189) also green against the current tree.

**Caveat on `verify:visual`:** its harness (`scripts/visual/harness.ts`) does a
single static `term.write()` and screenshots once — it never calls
`hardRepaint`/the heal interval at all, so it cannot exercise the code path
this diff actually changed. It's a real, clean PASS for glyph/font rendering,
but it is not evidence about the heal-interval regression risk below. That's
what the soak test was for.

## Soak test: does the 1Hz heal nudge cause visible flicker/pulse?

Built a throwaway instrumented harness (`scripts/qa-soak/` — harness.ts +
soak.mjs, **not committed**, removed after this run except the scripts
themselves, which are left untracked in case the team wants to formalize this
into a 5th `verify:*` script) that:

- Copies `TerminalPane.tsx`'s `forceRepaint`/`hardRepaint`/`scheduleRepaint`/
  `healInterval` closures **verbatim** around a real `xterm.Terminal` with
  production font options, in headless WebKit (Playwright — same engine
  family as the app's WKWebView, matching `verify:visual`'s own rationale).
- Writes a **static reference block** once (box + text + divider ornament)
  that must never legitimately change, plus a separate ticking status line
  below it (spinner + elapsed timer + token count, rewritten in place every
  220ms) to mimic the real trigger `garble-triage.md` describes and keep the
  1Hz heal interval active (`lastDataAtRef` recency check) for the whole run.
- Screenshot-loops **only the static reference region** (deliberately cropped
  to exclude the ticking row) at ~110-130ms cadence for a 14s soak (long
  enough to span ~14 heal-interval ticks), then diffs every consecutive frame
  pair with ImageMagick `compare -metric AE` — since that region never
  legitimately changes, any non-zero diff can only come from the repaint/heal
  mechanism itself.
- Ran three variants to isolate cause: `none` (refresh-only, transform line
  skipped entirely), `old` (the previously-shipped `translateZ(0)` no-op),
  `new` (this diff's `translate3d(0, 0.02px, 0)`).

**Results (123-124 frames / ~14s each, first pass had a clip-region bug that
bled into the ticking row — caught, fixed to a tighter crop, and rerun before
trusting these numbers):**

| variant | consecutive-pair diffs | max AE | notes |
|---|---|---|---|
| `none` (refresh only) | **0 / 123** | 0 | `term.refresh()` alone never perturbs already-rendered rows |
| `old` (`translateZ(0)`) | **0 / 123** | 0 | confirms the code comment: identity matrix, WebKit fully collapses it, zero measurable effect |
| `new` (`translate3d(0,0.02px,0)`) | **1 / 122** (frames 83→84→85) | 19,678 px differ (~16% of the clipped region), max per-channel delta 206/255 | fires, but self-heals in exactly one frame |

For the one `new`-variant transient: frame 82 vs 85 (bracketing it) is **AE=0
— pixel-exact**, and frame 0 vs the last frame (122) across the full 14s soak
is also **AE=0**. So there is a real, non-zero, single-frame transient, but
zero cumulative drift — it fully reverts every time.

Visually inspecting the bracketing frames (83 vs 84) side by side: **no
perceptible difference to the eye** — no shift, no ghosting, no flash of wrong
color. The pixel diff is confined entirely to anti-aliased edges of text
glyphs and box-drawing lines (consistent with a genuine but sub-pixel
snap-recompute at the moment the transform is applied), not a content shift
or a visible frame of blank/wrong color (the failure mode the code comments
explicitly warn about for the *rejected* opacity-nudge approach — that one
is NOT reproduced here).

One nuance worth flagging honestly: my screenshot sampling (~110-130ms
cadence) only caught this transient once in 14s / ~14 heal ticks, but the
transient itself is only ~1 rendered frame (~16ms) wide, so the real
occurrence rate is very likely closer to **once per heal tick (≈1/sec)** —
my capture just has a low chance of landing inside any single ~16ms window.
That's consistent with what the code intends (it fires every tick by design),
not a sign it's rarer than expected.

### Verdict on the flagged risk

**No visible flicker/pulse in this soak.** The new sub-pixel value is not a
no-op like the old one — it does cause a measurable, single-frame
anti-aliasing perturbation on (very likely) every heal tick, which is a
genuine behavioral difference from the previously-shipped code. But it is
confined to glyph/line edge anti-aliasing, fully self-heals with zero
residual drift, and was not perceptible on direct visual inspection of the
bracketing frames. I'd call this an acceptable trade — it's the mechanism
working as designed (forcing a real compositor commit necessarily perturbs
something) — but flag it as instrumented-but-real for the record, since "0.02px
is far below one device pixel so nothing visibly moves" (the code's own
justification) is true for *position*, not quite true for *anti-aliasing
sampling*. If anyone wants a second opinion, live-eyeball a long-running tool
call for a minute or two; I wouldn't block the release on this.

## Cleanup

Soak harness scripts (`scripts/qa-soak/{harness.ts,index.html,soak.mjs}`) are
left in the tree, untracked — small and reusable if this ever needs re-running
or becomes a real `verify:heal`-style 5th harness. All generated frame PNGs
(~370 files, ~12MB total across 3 variants) were deleted after analysis. No
stray dev-server processes left running (all 5 ports the soak used were
confirmed down after the run).
