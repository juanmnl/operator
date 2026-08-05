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

### ⚠ One thing I did NOT do, and it is a judgement call worth your eye

**Annotations captured at a narrow preset *before* this change are not migrated.** They were stored
as a percentage of the wrapper; they are now read as a percentage of the page, so such a pin will
shift. I left them alone deliberately: those pins were already pointing at the wrong place (that is
the drift being fixed), so there is no correct prior meaning to preserve — and a migration would
have to infer the capture geometry from the stored `device` + `viewport`, with no version field on
`Annotation` to stop a second run re-migrating and corrupting them. Adding one is a change to
`lib/annotations` that the brief did not ask for. Annotations made in `fit` mode — where wrapper
and stage are identical — are unaffected either way. Say the word if you want the migration.

## The gutter's tone

The brief left this optional; I took it, because a white page in a white panel has no visible edge
and a centred 375 would have looked like nothing happened. `#fff` moved off the wrapper and onto
the **stage**, where it belongs (it is the page's own backdrop, for an app with a transparent
body), and the wrapper became `var(--bg-deep)` — the app field in every palette. A token, never a
hex; a background, so no colour-changing border on a radiused element. Checked rendered in both
Mission Control dark and light: the page edge reads against the gutter in both.

## Verification

`npm run build` — clean. `npm test` — **603 passed / 53 files**, the brief's baseline.

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
ok  C3 setup: the panel (916.0) really is narrower than the preset
ok  C3 1280: stage == wrapper, gutter 0 — pixel-identical to before (916.0 at 76.0)
ok  C4 1280: the scaled iframe still paints edge to edge — 916.0 at 76.0
ok  C3 1280: no new letterbox — painted height 668.0 of 668.0
```

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

- **The pre-existing-annotation migration** described above.
- **No run against the real native inspector.** The rect is asserted; the embedded webview itself
  is a noop in the mock bridge. Worth one look in the real app at 375 to confirm the outline tracks.
- **No screenshot committed** — rendered and inspected in two palettes, but the images are
  session-scratch, not repo files.
