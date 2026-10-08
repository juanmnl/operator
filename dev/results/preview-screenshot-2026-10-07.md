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
