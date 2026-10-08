# Preview screenshot, and square bottom corners on the Preview — 2026-10-07

Branch `operator/3c5b40`, from main @ 2fcaed1. Code lane. Not merged, not GUI-verified.

## 1. Bottom corners

The rounded bottom corners were not in `AppPreviewPanel.tsx` or any CSS. They came from the
main-view Preview overlay in `DashboardView.tsx` (the `position: absolute; inset: 0` box that holds
the Preview over the Console), which had `borderRadius: var(--radius-lg)` on all four corners and
`overflow: hidden`, so it cut the page's bottom corners. It is now
`var(--radius-lg) var(--radius-lg) 0 0`. The top keeps its radius: the overlay's top edge sits under
the card's toolbar band, where the rounding matches the card.

In the side panel the Preview is not at the panel's bottom (the actions footer is below it), so no
change was needed there.

`src/renderer/lib/chrome.test.ts` found the overlay by its old radius string; it now looks for the
new one.

## 2. Screenshot

A camera button in the Preview's address group, before Open in browser. It captures the page at the
size the preview is set to, at the display's device pixel ratio, and:

- saves `~/Downloads/<project>-<W>x<H>-<YYYYMMDD-HHMMSS>.png` (W×H in CSS px; a second capture in the
  same second gets `-2`, `-3`…),
- copies the image to the clipboard,
- shows a success toast, "Screenshot saved, W×H", with a Reveal in Finder action. A failure shows an
  error toast and saves nothing.

`<project>` is the registered project's name, else the session's project name, reduced to
`[A-Za-z0-9._-]`.

The button has the `camera` glyph, which no other toolbar control uses. Its tooltip names the size it
will capture ("Screenshot at 1280×1792, saved to Downloads and copied"). With no page loaded it is
inked `--border` with `aria-disabled`, the same disabled style as back and forward, and does nothing.

### What "the set size" is

Preview presets are widths only (Fit, 375, 768, 1280); there is no 390×844 preset. The size is the
page's own viewport, `pageBox` in the panel:

- Fit: the stage's size.
- A preset no wider than the panel: preset × panel height.
- A preset wider than the panel: preset × (panel height / scale). 1280 in a 500×700 stage is
  1280×1792, and the image is 2560×3584 at 2x.

An attached Electron app is captured at its own window's viewport.

### How the web preview is captured

Measured in a hidden-window probe before choosing (`electron/probes/preview-screenshot.cjs`):

- `capturePage` on the window over a scaled stage gives `scale × dpr` pixels per page px.
- CDP `Page.captureScreenshot` on the iframe's own target is refused: "Command can only be executed
  on top-level targets".
- CDP `Page.captureScreenshot` on the window with `clip.scale = 1/scale` gives the right pixel size
  but upscales the iframe's low-resolution raster: 46% of the 1px test stripes came out grey.
- Drawing the iframe at scale 1 and capturing beyond the window with `captureBeyondViewport` did not
  render the out-of-process iframe past the window: the parts outside were blank.

So the capture uses tiles. For the capture, the iframe is drawn at scale 1 and shifted under the
stage with a `translate` for each stage-sized tile; main captures each tile with `capturePage` and
stitches them. The page's own viewport does not change, so it does not re-lay out, scroll or reload.
1280 in a 500×700 stage is 9 tiles in about 0.7 s; a page that fits the stage is one tile. The user
sees the page jump between tiles for that time.

The tile window is the whole-pixel rect inside the stage. When the stage sits on a half pixel, the
page is one pixel taller or wider than that rect, and a 1px tile is added for the last row or column.
That is correct but costs one more capture (about 70 ms).

### What is kept out of the image

- Renderer side, for the length of the capture: note pins, the annotation tint, the note card (the
  existing `capturing` state), the renderer-drawn grid, and the toast stack (`data-toast-stack`,
  hidden by `html[data-preview-shot]` in `styles.css`). The toast stack sits over the side panel's
  stage, and a success toast stays until dismissed, so without this the second screenshot would show
  the first one's toast.
- Page side: main sets `visibility: hidden !important` inline on `[data-operator-overlay]` (grid,
  redlines, anchor), `[data-operator-edit]` (CSS controls handles), `[data-operator-inspector]` (the
  hover box and label; the attribute is new in `preview-inspector.js`) and `#__op_compose`, then
  removes it. Nothing is removed, so a compose card keeps its text and a redline anchor stays set.
  Inline style rather than a `<style>` element, so a page whose CSP refuses inline styles still obeys.

Not hidden: anything else Operator draws over the stage that is not listed above, such as an open
hover card from elsewhere in the app.

### Electron apps

`previewCdp.screenshot()` (`preview-cdp.ts`): hides the same page drawing, reads the layout viewport
from `Page.getLayoutMetrics`, and runs `Page.captureScreenshot` with a clip of that viewport at its
scroll offset, scale 1. The image is the viewport times the app's own device pixel ratio.

## Files

- `src/shared/preview-screenshot.ts` — page size, tile window, tile plan, tile shift, pixel size, file
  name. Shared by the renderer and main.
- `electron/src/main/preview-screenshot.ts` — stitching, the page-drawing hide script, free file name.
- `electron/src/main/preview-screenshot-capture.ts` — tile capture, stitch, PNG to Downloads, clipboard.
- `electron/src/main/preview-cdp.ts` — `screenshot()` for an attached app.
- `electron/src/main/preview-inspect.ts` — `setDrawingHidden` for the web preview's frame.
- `electron/src/main/ipc.ts`, `electron/src/shared/operator-api.ts`, `src/renderer/env.d.ts`,
  `src/shared/types.ts` — `previewScreenshotHide`, `previewScreenshotTile`, `previewScreenshotSave`,
  `previewCdpScreenshot`.
- `src/renderer/components/session/AppPreviewPanel.tsx` — the button and the capture loop; new props
  `projectName` and `onToast`, passed from `DashboardView.tsx`.
- `src/renderer/components/ToolbarIcon.tsx` — `camera`.
- `src/renderer/components/Toast.tsx`, `src/renderer/styles.css` — the toast stack hides during a capture.
- `src/shared/preview-inspector.js` — `data-operator-inspector` on the hover box and label.

## Tests and checks

- `src/shared/preview-screenshot.test.ts` (21): the image is the preset size, not the scaled stage
  (1280 in 500×700 → 1280×1792); 390×844 at 2x is 780×1688; scaled and unscaled captures of one page
  have the same pixel size; tile windows on half pixels and at the window edge; tiles cover the page
  exactly once (checked pixel by pixel); shifts put page px on whole window px; file names.
- `electron/src/main/preview-screenshot.test.ts` (6): stitch placement at 2x, clipping, the hide script
  sets and removes only `visibility`, free file names.
- `preview-toolbar-icons.test.ts`: the Screenshot button is the only `camera`, and is live with a page up.
- `electron/probes/preview-screenshot.cjs` (hidden windows, real modules), all PASS:

```
PASS fit in 700x500 (scale 1.0000): page 700x500, 2 tile(s) in 147 ms → 1400x1000
PASS 375 in 700x500 (scale 1.0000): page 375x500, 4 tile(s) in 278 ms → 750x1000
PASS 1280 in 500x700 (scale 0.3906): page 1280x1792, 9 tile(s) in 675 ms → 2560x3584
   for comparison, CDP clip.scale: 2560x3584, grey 0.463 (stripes blurred when > 0)
```

  Each case checks size, sharp 1px stripes, a marker at its page position, the viewport's bottom-right
  corner present, no hover outline or overlay in the image, and both visible again afterwards.
- `electron/probes/preview-cdp-electron.cjs` has a new page-screenshot check for the Electron app path.
  **Not run**: that probe shows a throwaway app window on screen.

Results:

```
root:     npx tsc --noEmit -p .        → exit 0
root:     npx vitest run               → 116 files, 1763 tests passed
electron: npm run typecheck            → exit 0
electron: npx vitest run               → 50 files, 876 tests passed
```

## Not verified

- Nothing was run in the real app. The button, the toast, the clipboard, Reveal in Finder, the
  bottom corners and the visible jump during a tiled capture need a look in a dev build.
- The Electron app path is type-checked and its probe check is written, not run.

---

## Review fixes — 2026-10-07

Fixes for `dev/results/preview-screenshot-review-2026-10-07.md`, on the same branch `operator/3c5b40`.
Code lane. Not merged, not GUI-verified.

### M1. Layers over the stage

`src/renderer/lib/preview-screenshot.ts` `hideLayersOver`: for the capture, every layer of Operator's
over the stage gets an inline `visibility: hidden !important`, and its own value back afterwards.

- Known layers: the overlaid side panel (`[data-side-panel-slot="overlay"]`) and the toast stack. A
  layer that contains the stage is skipped, so a screenshot taken from the side panel's own Preview
  does not hide that panel.
- Everything else: a 9×9 grid of `document.elementsFromPoint` hits over the stage. At each point,
  each element above the frame is hidden as its whole layer (`layerOf`: its outermost ancestor that
  does not contain the stage). This runs again before every tile, so a hover card or menu that
  opens during the capture is hidden too.
- Limit: hit-testing does not see `pointer-events: none` elements. Only the two known layers are
  covered for that case.

### M2. Zoom

- Main converts each tile rect from CSS px to DIPs with `webContents.getZoomFactor()`
  (`dipRect`, grown to whole DIPs).
- `tileOffset` finds where the CSS rect starts inside that capture.
- `stitchTiles` fills each tile's page area exactly, from `tileOrigin(at)` to `tileOrigin(at + size)`.
  It repeats the last row or column when a capture is a pixel short at a fractional ratio, so no
  pixel is left clear.
- The stitch ratio is screen scale × zoom. A tile at another screen scale or zoom than the first
  fails the capture.
- Note crops (`preview-shot-capture.ts`) had the same CSS-as-DIP assumption. They now capture
  `dipRect(crop, zoom)` and measure the outline against that rect converted back to CSS px. At
  zoom 1 nothing changes.

### M3. Layout during the capture, stalls, restore

`runTileLoop` (`src/renderer/lib/preview-screenshot.ts`) replaces the inline loop.

- **Layout change.** Before and after every tile it compares the stage rect, the viewport and
  `devicePixelRatio` with the values it planned from. Any change aborts the capture with a reason
  ("The preview moved or changed size during the capture." / "The window's pixel density
  changed…"), and nothing is saved. I chose aborting over freezing the layout because a freeze
  would have to hold a window resize.
- **Restore.** `finally` sets the transform React wants now (`wantTransformRef`: `scale(current)`,
  or '' when fitting), not the string read at the start.
- **Timeouts.**
  - Each tile: 4 s in the renderer, around the whole IPC call. Main has its own 3 s timeout on
    `capturePage` and drops a late answer.
  - Hide/show of the page drawing: 1.5 s in the renderer, 1 s in main.
  - Save, and the CDP path: 20 s, so the button comes back.
- **Order.** The page, the toast stack and the `capturing` layers are restored before the file is
  written, not after.

### L1. Clipboard first

- `deliverScreenshot` copies, then writes. Each can fail without the other.
- `PreviewScreenshot.path` is null when the write failed, and `saveError` says why: EPERM/EACCES →
  "macOS did not allow Operator to write to Downloads"; ENOENT → "the Downloads folder does not
  exist"; ENOSPC → "the disk is full"; anything else gives the error message.
- Toasts:
  - Saved: as before.
  - Copied but not saved: "Screenshot copied, W×H", "It is on the clipboard. It could not be saved
    to Downloads: <reason>."
  - Neither: an error with the reason.
  - Capture failed: the loop's reason, then "Nothing was saved."

### L2. Paint before each tile

Before each capture, main runs two `requestAnimationFrame`s inside the preview frame
(`previewApi.framePainted`, bounded at 500 ms), then waits its 50 ms settle.

The probe page now has a heavier lower half: a canvas at full device resolution with 20,000 rects
under 300 `will-change` layers, all cyan, plus a check that every sampled pixel of it is cyan.
**It passes with and without the wait** (`NO_PAINT_WAIT=1`). This page does not reproduce L2, so
the wait is unproven. It costs about 20 ms per tile (853 ms vs 703 ms for 9 tiles).

### L3. Input and late drawing

- **Input shield.** While `shooting`, a transparent `data-screenshot-shield` sits over the stage at
  z-index 10. It takes clicks and hovers, and swallows the wheel with a non-passive listener.
  Keyboard input into a focused page is not blocked. Moving focus away would fire `blur` in the
  page and could close the menu being captured.
- **Late page drawing.** `pageDrawingVisibilityJs(true)` also starts a MutationObserver. It hides an
  Operator element added during the capture (the compose card, a hover box) and re-hides one whose
  style is rewritten (the inspector's `paint()` sets `cssText`). It writes only when the element is
  not already hidden, so it does not feed itself. `pageDrawingVisibilityJs(false)` disconnects it.

### L4. Size cap

`screenshotTooLarge` (shared): 16384 device px on the long side, or 16M pixels (64 MB BGRA).

- The renderer refuses before touching the page, with the size in the message: "The image would be
  2560×8534 px (83 MB), over the 64 MB limit. Use a narrower preset or a shorter panel."
- Main checks again before it allocates the stitch.

### Tests and checks

New or changed tests:
- `electron/src/main/preview-screenshot.test.ts` (18, was 6):
  - `dipRect` at zoom 1, 1.25, float noise and a bad zoom; `tileOffset`.
  - A 777×600 page tiled at 125% on a 2x screen stitches with no clear pixel and the red/blue edge
    at page x 400 in place (±1 px). At zoom 1 the stitch is exact with no offset.
  - `deliverScreenshot` copies before it writes. A refused write keeps the copy and gives the
    reason. A failed copy still writes. Both failing reports both. `saveErrorReason`.
  - The page script hides an element added during the capture and a style rewrite, does not
    re-write an element that is already hidden, and stops watching when shown.
- `src/renderer/lib/preview-screenshot.test.ts` (11, new). `runTileLoop`:
  - Success: shifts, hide order, restore.
  - A tile that never answers: timeout, then the page drawing and the transform are restored.
  - A resize mid-capture: abort, and the transform React wants now is restored, not the old one.
  - A pixel-ratio change: abort.
  - Fitting: '' restored.
  - A failed tile and a thrown tile.
  - A hide that never answers.
  - The size cap refuses before touching the page.

  Plus `withTimeout`, `layerOf` and `layersOver`.
- `src/shared/preview-screenshot.test.ts`: three `screenshotTooLarge` cases.

The probe, `electron/probes/preview-screenshot.cjs`, now:
- adds a 1280-in-500×700 case at zoom 1.25;
- adds a compose card the page creates after the hide;
- adds the raster check;
- sets the zoom on every window. Chromium keeps a zoom per host in the profile, so a 1.25 from an
  earlier case or run carried over before this.

The canvas in the first draft of the heavier page was sized at script time and came out 0×0 in the
preset cases. That was a bug in the probe page, now drawn on load and on resize.

```
PASS fit in 700x500 at zoom 1 (scale 1.0000): page 700x500, 2 tile(s) in 221 ms → 1400x1000
PASS 375 in 700x500 at zoom 1 (scale 1.0000): page 375x500, 4 tile(s) in 375 ms → 750x1000
PASS 1280 in 500x700 at zoom 1 (scale 0.3906): page 1280x1792, 9 tile(s) in 853 ms → 2560x3584
PASS 1280 in 500x700 at zoom 1.25 (scale 0.3906): page 1280x1792, 12 tile(s) in 1164 ms → 3200x4480
RESULT PASS
```

```
root:     npx tsc --noEmit -p .        → exit 0
root:     npx vitest run               → 117 files, 1777 tests passed
electron: npm run typecheck            → exit 0
electron: npx vitest run               → 50 files, 888 tests passed
```

### Not done, or not verified

- Nothing was run in the real app. The review's four GUI checks still apply:
  1. A main-view screenshot with the side panel overlaid.
  2. A screenshot at ⌘+.
  3. Dragging the panel edge during a 1280 capture: it should abort with the "moved or changed size"
     toast, and the preview should come back at the new scale.
  4. The first screenshot after a fresh install, with the Downloads prompt denied: it should show
     the "copied, could not be saved" toast.
- L2 is not reproduced by the probe (see above).
- Keyboard input into the page during a capture is not blocked (see L3).
- `preview-cdp-electron.cjs` was still not run. It shows a window on screen.
- Nits not done: `fileStem` still does not truncate.
