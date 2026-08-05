# RESULT — Preview: the preset is centred, and the stage is now the only coordinate system

Branch `operator/ac9328`. Two files: `src/renderer/components/session/AppPreviewPanel.tsx` (the
fix) and `dev/drive-preview-centre.mjs` (new — the harness).

## What changed

**One stage element**, as the brief specified, and it does both jobs.

- `<div data-preview-stage>` — absolutely positioned in the wrapper, `top: 0`, `left: gutter`,
  `width: stageW`, `height: 100%`. It IS the frame's visible box.
- The iframe, the annotation pins, the capture overlay **and** the draft note card are now its
  children. `transformOrigin: 'top left'` is kept, inside the stage, where it has nothing left to
  pin the page against — the stage is already the page's box, so the page just fills it.
- The geometry, derived once:

      const fitting = preset === 'fit' || box.w === 0
      const scale   = fitting ? 1 : Math.min(1, box.w / preset)
      const stageW  = fitting ? box.w : Math.min(preset, box.w)
      const gutter  = fitting ? 0 : Math.max(0, (box.w - stageW) / 2)

  `Math.min(preset, box.w)` rather than `preset * scale`: mathematically the same number, but it
  states the wide case in integers instead of trusting a float to land exactly on `box.w`. The
  gutter is **not rounded** — half of an odd remainder is what makes the two gutters equal instead
  of off by one.

**The wide case is untouched by construction**: when `preset > box.w`, `stageW === box.w` and
`gutter === 0`, so the stage is the wrapper and the render is what it was. Measured, not assumed —
see C3/C4 below.

## Was the annotation / inspect drift fixed? Yes — and it was worse than the centring.

All three consumers now read the stage:

- **Pins and the capture overlay** are children of the stage, so `left: ${xPct}%` and `inset: 0`
  resolve against the page rather than against the page-plus-gutter.
- **The inspect webview** takes `stageRef.getBoundingClientRect()`. It was being handed the
  wrapper: at 375 in a 1356px panel the native inspector was laid over a box **3.6× too wide**, so
  every hover outline was offset by half the slack.
- **The re-align effect gained `preset` as a trigger.** This is new and it is load-bearing: the
  stage now moves and resizes when the preset changes *without `box` changing at all*, so an effect
  keyed only on `[box, inspecting]` would have stranded the webview at the previous width. The
  brief asked that the `:231` effect keep working; it needed one more dependency to.

Two coordinate readouts followed the percentages into page space, because leaving them would have
quoted pixels that do not exist on the page:

- `buildAnnotation`'s `viewport` is now the **page's** box (`preset` × `box.h / scale`), not the
  panel's. `Annotation.viewport` is documented as "pixel viewport of the preview frame" and
  `lib/annotations.pxOf` multiplies the percentages by it — with page-relative percentages and a
  panel-sized viewport, the composed message would have named a coordinate off the end of a 375px
  page. Same for `composeMessage`'s fallback and the draft card's `123,456px` hint.

### Existing annotations ARE migrated (added on your call, after the first pass)

Notes already on disk were percentages of the panel. They are now re-based onto the page, in
`lib/annotations.ts`:

- **`Annotation.v`** — the geometry generation. Absent/1 = panel-relative, 2 = page-relative. It is
  what makes this a one-time upgrade instead of a rebase that compounds on every load, and it is
  the thing whose absence made me hold off in the first pass.
- **`migrateAnnotations(list)`** — pure, and returns the **same array reference** when there is
  nothing to do, which is how `loadAnnotations` knows whether to write back. A load that changes
  nothing never touches localStorage.
- **`loadAnnotations`** upgrades on read and persists once. Migrating in the panel instead would
  leave the stored copy in the old system, so every load would rebase again from a moving baseline.
- **`buildAnnotation`** stamps `v` on new notes. That is a no-op on today's records by coincidence
  (the recorded viewport IS the page box, so the factor is 1) — relying on the coincidence is how a
  future rebase eventually lands on a note it shouldn't.

**The rebase is recoverable because a v1 note recorded the two numbers it needs**: `viewport` (the
wrapper's pixel box at capture) and `device` (the preset).

    pageW = min(preset, viewport.w)        the page's painted width inside that wrapper
    xPct' = xPct × (viewport.w / pageW)    and the same factor on wPct

Four properties worth stating, because each is a decision:

- **Only the horizontal axis moves.** The frame was always full-height (a preset scales the
  iframe's own height by `1/scale`, so the painted height stayed the panel's), so `yPct`/`hPct`
  already meant "of the page" and are left exactly as they are.
- **A preset wider than the panel is a geometry no-op** — `pageW` clamps to `viewport.w` and the
  factor is 1. Right, because the page filled the wrapper there and never drifted. Its `viewport`
  is still restated in page pixels so `pxOf` quotes page coordinates.
- **`Fit` and bare notes are not moved**, only stamped — the stamp records that they were
  examined, so they are not re-examined and re-written on every load.
- **Pins dropped in the GUTTER are not clamped.** The old overlay covered the whole wrapper, so a
  note could be left beside the page; rebasing puts it past 100%, which is where its author left
  it, and the stage does not clip so it still renders there. Clamping would silently move a note
  onto a feature it was never about.

## The gutter's tone

The brief left this optional; I took it, because a white page in a white panel has no visible edge
and a centred 375 would have looked like nothing happened. `#fff` moved off the wrapper and onto
the **stage**, where it belongs (it is the page's own backdrop, for an app with a transparent
body), and the wrapper became `var(--bg-deep)` — the app field in every palette. A token, never a
hex; a background, so no colour-changing border on a radiused element. Checked rendered in both
Mission Control dark and light: the page edge reads against the gutter in both.

## Verification

`npm run build` — clean. `npm test` — **612 passed / 53 files**: the brief's 603 baseline plus the
9 new migration cases in `src/renderer/lib/annotations.test.ts` (narrow rebase, box width, the wide
no-op, `Fit`, a bare note, idempotence twice over, a gutter pin past 100%, and a migrated pixel
hint reading against the page).

### New harness: `dev/drive-preview-centre.mjs`

It serves its own page to preview on **1438** (pointing the preview at the harness on 1437 makes
Operator load a second copy of itself inside its own iframe), drives the real panel — open a lane →
Preview → pin the port through the panel's own URL editor → switch presets — and measures.

    ./node_modules/.bin/vite --port 1437 --strictPort
    node dev/drive-preview-centre.mjs

It is **implementation-agnostic**: "the stage" falls back to the iframe's *painted* box when no
`[data-preview-stage]` exists, so the same assertions run against the code before and after. A
harness keyed to an element the fix introduces would only prove the element is new — the pre-fix
numbers are the diagnosis, and they should be readable.

**After (all pass):**

```
ok  C1 fit: stage == wrapper (1356.0 wide at x 76.0)     ok  C1 fit: full height, no letterbox
ok  C2 375: gutters EQUAL — left 490.5px, right 490.5px  ok  C2 375: stage is the preset wide
ok  C2 375: still TOP-aligned                            ok  C4 375: iframe's box == the stage
ok  C2 768: gutters EQUAL — left 294.0px, right 294.0px
ok  C5 375: inspect rect == STAGE (375.0 at 566.5; wrapper is 1356.0 at 76.0)
ok  C5 768: inspect FOLLOWS the preset switch — moved to 768.0 at 370.0
ok  C6: a pin at 25% across the PAGE stores xPct 24.93
ok  C6: the note records the PAGE's viewport — 375×768, device 375px
ok  C6: after switching to 768 the pin is still 25% across the page — x 561.5 vs 562.0
ok  C6: after resizing the window the pin is still 25% across the page — x 431.5 vs 432.0
ok  C2 after resize: gutters still equal — 164.0 / 164.0
ok  C7: the stored note was re-based on read — 6.91% of the panel → 25.00% of the page
ok  C7: written back once, stamped v2, viewport restated as the page (375×768)
ok  C7: the migrated pin renders on its page feature — x 660.3 vs 660.3
    (un-migrated it would have drawn at 169.8)
ok  C7: a second load does NOT rebase again — still 25.00%
ok  C3 setup: the panel (916.0) really is narrower than the preset
ok  C3 1280: stage == wrapper, gutter 0 — pixel-identical to before (916.0 at 76.0)
ok  C4 1280: the scaled iframe still paints edge to edge — 916.0 at 76.0
ok  C3 1280: no new letterbox — painted height 668.0 of 668.0
```

**C7 is the migration end-to-end**, and it is deliberately not a unit test: it seeds a genuine v1
record (no `v`, `viewport` = the WRAPPER's box, exactly as the old panel wrote it), **reloads the
app** so the real `loadAnnotations` path runs, and then measures where the pin lands. 490px of drift
removed on one note. The second reload asserts idempotence against the real store rather than
against an array in memory.

**Before (same harness, `AppPreviewPanel.tsx` stashed):**

```
FAIL C2 375: gutters EQUAL — left 0.0px, right 981.0px          ← the reported defect
FAIL C2 768: gutters EQUAL — left 0.0px, right 588.0px
FAIL C5 375: inspect rect == STAGE (1356.0 at 76.0; stage 375.0)  ← 3.6× too wide
FAIL C5 768: inspect FOLLOWS the preset switch — still 1356.0
FAIL C6: a pin at 25% across the PAGE stores xPct 6.86
FAIL C6: the note records the PAGE's viewport — 1356×768, device 375px
FAIL C6: after switching to 768 the pin is still 25% — x 169.0 vs 268.0   ← 99px of drift
FAIL C2 after resize: gutters still equal — 0.0 / 328.0
ok   C1 fit … ok C3 1280 … ok C4 1280           ← the cases that had to stay identical, and did
```

The last line is the one to read twice: `fit` and the wide preset pass **in both runs**, which is
the evidence that the brief's "keep the wide case pixel-identical" constraint held.

### Against each of the brief's verify bullets

- *Narrow preset (390-ish) in a wide panel: equal gutters, top-aligned* — C2, at 375 and 768.
  490.5/490.5 and 294.0/294.0, stage top == wrapper top. Screenshotted at 375 in dark and light.
- *A preset wider than the panel renders exactly as before* — C3, forced by a 1000px window (panel
  916 < 1280): stage == wrapper, gutter 0, no new letterbox, and the same assertions pass on the
  pre-fix code.
- *`fit` unchanged* — C1, and it passes on both revisions.
- *A pin stays on its feature across preset switch and panel resize* — C6. Clicked at 25% across
  the page (deliberately off-centre: the stage's centre is also the wrapper's, so a middle click
  would agree under the bug and prove nothing), stored 24.93%, and it lands back on 25% of the page
  after switching 375→768 and after resizing the window to 1180.
- *Inspect tracks the real element at a narrow preset* — C5, as far as this can honestly be
  measured: `previewInspectOpen`/`Move` are noops in the mock bridge, so the harness records the
  **rect handed to them** and asserts it equals the stage's. That proves the webview is placed over
  the page rather than the gutter; it does not prove the native inspector's own hit-testing.
- *`npm test` green, build clean* — both.

## Not done

- **No run against the real native inspector.** The rect is asserted; the embedded webview itself
  is a noop in the mock bridge. Worth one look in the real app at 375 to confirm the outline tracks.
- **Notes with no `device`/`viewport` cannot be re-based** — there is nothing recorded to compute
  the factor from. They are left where they are and stamped. In practice these are pre-`device`
  records; anything captured since carries both.
- **No screenshot committed** — rendered and inspected in two palettes, but the images are
  session-scratch, not repo files.
