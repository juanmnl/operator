# Re-review: Preview screenshot, round 2 (operator/3c5b40 @ ec24959)

Reviewed 2026-10-07 by the Review lane. Diff: `git diff a6b267f ec24959` (14 files). First-round
findings are in `preview-screenshot-review-2026-10-07.md`. Read only. No GUI run, and I did not run
the probe.

**Merge and tests:**
- `git merge-tree --write-tree main operator/3c5b40` (main @ 2fcaed1, still its head): exit 0.
- I extracted ec24959 to my scratchpad and ran:
  - electron `preview-screenshot.test.ts` + `preview-shots.test.ts`: 34/34;
  - renderer `lib/preview-screenshot.test.ts` + shared `preview-screenshot.test.ts` +
    `preview-toolbar-icons.test.ts`: 42/42.

Verdict: M1, M3 and L1 are closed. M2, L3 and L4 are closed. L2 has a mitigation that the probe
could not show is needed. The regression checks the brief asked for are clean, with one sizing
note on the cap (R2-1). Nothing blocks merge.

## Status of the round-1 findings

| Finding | Status | How it was checked |
|---|---|---|
| M1 overlaid panel captured | **Closed** | `hideLayersOver` hides the known layers plus whatever a 9×9 hit-test finds over the stage, before every tile, and restores each layer's own inline value. Details below. |
| M2 zoom | **Closed** | Main converts each tile rect to DIPs (`dipRect`, grown to whole DIPs), records where the CSS rect starts inside the capture (`tileOffset`), and stitches at screen scale × zoom. A zoom or scale change between tiles fails the capture. The probe passes at 1.25 (from Code's notes). |
| M3 resize / stall / restore | **Closed** | `runTileLoop` checks stage rect, viewport and `devicePixelRatio` before and after each tile and aborts with a reason on any change. Tiles have a 4 s renderer timeout and a 3 s main timeout (a late answer is dropped); hide/show are bounded at 1.5 s and 1 s; save and CDP at 20 s. `finally` writes `wantTransformRef.current`, the transform React wants now. |
| L1 clipboard before file | **Closed** | `deliverScreenshot` copies, then writes; each failure is independent. `saveErrorReason` maps EPERM/EACCES/ENOENT/ENOSPC. The renderer has separate toasts for saved, copied-not-saved, neither, and capture failed. |
| L2 OOPIF raster | **Mitigated** | `framePainted` waits two rAFs inside the frame (bounded at 500 ms) before each tile. Code's heavier probe page passes with and without it, so the wait is unproven but cheap (about 20 ms a tile). |
| L3 input and late drawing | **Closed** | An input shield covers the stage while `shooting`. A MutationObserver re-hides Operator elements added or restyled during the capture. Keyboard input into a focused page is not blocked, as documented. |
| L4 size cap | **Closed** | `screenshotTooLarge` (16384 px a side, 16M px) is checked in the renderer before the page is touched, and again in main before the stitch. Sizing note in R2-1. |

**M1 details.**
- `hideLayersOver` hides `[data-side-panel-slot="overlay"]`, the toast stack, and whatever the
  hit-test finds over the stage, at every tile.
- Each layer is hidden with inline `visibility: hidden !important` and gets its own inline value
  back.
- A layer that contains the stage is skipped, so the side panel's own Preview is not hidden.

## Regression checks requested

- **Can the hit-test hide something it then fails to restore, or hide page content?** No.
  - `restore()` runs in `captureWebTiles`'s `finally` for every outcome. It writes back the
    saved inline value and priority, or removes the property.
  - `elementsFromPoint` works per document and never returns elements inside the iframe, so page
    content cannot be hidden. The walk stops at the frame, the stage or any stage ancestor, and
    skips the stage's own children (the shield).
  - Only Operator's own DOM above the stage is touched.
  - The one theoretical stale-restore case: a hidden element whose React-managed style includes
    `visibility` changes during the capture, and the saved value is written back over React's.
    The known layers have no React `visibility`. The elements React does manage that way (the
    terminal panes, `paneVisibility`) sit below the main-view overlay and are never above the
    side panel's stage, so the walk stops before them.
- **Can the input shield or the MutationObserver be left in place after an abort or timeout?** No.
  - The shield renders from `shooting`, which the outer `finally` clears on every path. The
    renderer-side timeouts resolve rather than hang, so that `finally` is always reached.
  - The wheel listener lives on the shield element and goes with it. The ref callback re-adds the
    same function, which `addEventListener` deduplicates.
  - `hide(false)` disconnects the observer. Main's `inFrame` resolves after 1 s even if the page
    is busy, but `executeJavaScript` calls on one frame run in order, so a slow `hide(true)` cannot
    land after the `hide(false)` that follows it.
  - A page that navigates during the capture takes its observer with it.
- **Does the zoom conversion change the Inspect note crops at 100%?** Not for a whole-pixel crop.
  - With integer CSS coordinates at zoom 1, `dipRect` returns the same rect.
  - With fractional coordinates, the old code passed fractions that Electron's rect conversion
    truncates. `dipRect` now floors the start and ceils the end, and `finishShot` measures the
    outline against the rect actually captured, so the outline is placed more exactly. The image
    can be one DIP larger on a side. `preview-shots.test.ts` passes.
- **Can the abort-on-layout-change fire on every capture?** I found nothing in the capture itself
  that moves the stage, the viewport or the pixel ratio:
  - the pins, grid and tint, the `data-preview-shot` toast hide and `hideLayersOver` all change
    only visibility or paint, not layout;
  - the shield is absolutely positioned and renders before `stage0` is read;
  - the iframe's `translate` does not change the stage's rect, and the wrapper's
    `overflow: hidden` keeps the shifted iframe from adding scrollable overflow or a scrollbar
    above it;
  - toasts are `position: fixed`;
  - the comparison has 0.01 px slack for the rect and is exact for the ratio, which is stable.

  So aborts should come only from a real resize or panel move, a panel toggle, or a display
  change. Not verified in a window.

## New findings

### R2-1. The 16M-pixel cap refuses 1280 in a narrow side panel (Low, by design, worth knowing)

There are no 1440 or 1920 presets: they are Fit, 375, 768 and 1280 (`AppPreviewPanel.tsx:34`).
The cap only bites on 1280 at 2x:
- the image is 2560 wide, so the page may be at most 3276 CSS px tall;
- the page height is `stageH × 1280 / stageW`;
- so a capture is refused when the stage is more than 2.56 times as tall as it is wide.

At `PANEL_MIN_W` (300) that is a stage taller than about 740 px. At 400 wide, taller than about
1020 px. A narrow side panel on a normal laptop window therefore refuses 1280 with "over the 64 MB
limit".

Fit and 768 at 2x, and every main-view capture I worked out, stay under the cap. The largest is a
Fit stage of about 2500×1550 on a 6K display: 15.5M px.

The message names the fix (a narrower preset or a shorter panel). If refusing 1280 in a narrow
panel is not wanted, raising `SCREENSHOT_MAX_PIXELS` to 32M (128 MB, about 384 MB at peak) covers
it.

### Nits

- `layersOver` samples a 9×9 grid, so a layer smaller than the grid spacing over the stage (a
  small badge or tooltip) can slip through. That is documented next to the `pointer-events: none`
  limit.
- In the CDP path, the page-drawing observer is installed in the attached app's page. If the CDP
  connection drops between hide and show, it stays there and keeps Operator's drawing hidden until
  that page reloads. This needs a disconnect during a sub-second window.
- `fileStem` still does not truncate (round-1 nit).

## Recommended follow-ups

- None blocking.
- Optional (coordinator's call): raise the pixel cap if 1280 in a narrow side panel should work.
- User, GUI check: the four cases from round 1.
  1. A main-view screenshot with the side panel overlaid.
  2. A screenshot at ⌘+ zoom.
  3. Dragging the panel edge during a 1280 capture: expect the "moved or changed size" toast and
     the preview back at the new scale.
  4. The Downloads permission prompt denied: expect the "copied, could not be saved" toast.

  Add a fifth: confirm that a normal capture is not aborted.
