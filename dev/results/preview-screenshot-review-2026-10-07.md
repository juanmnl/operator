# Review: Preview screenshot + square bottom corners (operator/3c5b40 @ a6b267f)

Reviewed 2026-10-07 by the Review lane. Diff: `git diff main...operator/3c5b40` (merge base 2fcaed1
= main HEAD). Read only. No GUI run; I did not run the probe or the suites.

**Merge:** `git merge-tree --write-tree main operator/3c5b40` exits 0.

Verdict: the arithmetic, the file naming and the restore paths are sound. Four things can put the
wrong pixels in a file that is still reported as saved, or leave the capture stuck:
- M1: the overlaid side panel is captured.
- M2: app zoom other than 100% (plausible).
- M3: a resize during the capture, and a capture that never returns.
- L1: a refused Downloads write also loses the clipboard copy.

## Findings, most severe first

### M1. A main-view screenshot taken with the side panel overlaid contains the panel (Medium, confirmed by reading)

The capture reads the composited window over the stage rect (`tileWindow` clips to the window
viewport only). The renderer hides only the pins, the note card, the grid and the toast stack.

DashboardView's own comment says: "An overlaid panel covers the right of the Console, including a
main-view Preview's stage" (`panelOverlaid`, `panelPlace.mode === 'overlay'`). With the side panel
open in overlay mode, every tile under it captures the panel's UI instead of the page. The
"Screenshot saved" toast still appears.

This is not a passing hover card: overlay mode is a layout the user keeps.

Recommendation (Code): one of these.
- Hide the overlaid panel for the capture. `html[data-preview-shot]` can target it the way it
  targets the toast stack.
- Intersect the tile window with the region not covered by the panel and take more tiles.

Also add any other persistent surface that can sit over either stage.

### M2. At app zoom other than 100%, the tiles cover the wrong area (Medium-Low, plausible, not run)

The tile rect comes from `getBoundingClientRect()` and `window.innerWidth/innerHeight`, which are
in CSS px. `webContents.capturePage(rect)` takes the rect in the view's DIPs. The two are equal
only at zoom 1.

`app-menu.ts` keeps the default `zoomIn` / `zoomOut` / `resetZoom` roles. After ⌘+ (110%):
- each capture reads a region about 1/1.1 the size of the intended one, offset toward the
  top-left;
- `capturedDpr` comes out as the screen scale, without the zoom;
- the stitched image is the wrong part of the window at the wrong density, and is saved as a
  success.

The probe ran at zoom 1 only. Note crops (`preview-shot-capture.ts`) make the same CSS-as-DIP
assumption, so this predates the branch there. The new feature adds tiling on top of it.

Recommendation (Code): multiply the rect by `webContents.getZoomFactor()` in `captureTile`, or
send the zoom with the request, and keep the stitch in CSS × (screen scale × zoom). Add a probe
case at zoom 1.25.

### M3. A resize or a stalled capture during the tile loop leaves a bad image, or a stuck preview (Medium-Low, confirmed by reading)

`captureWebScreenshot` reads the stage rect, the tile window and the iframe's `transform` once,
then loops for up to about 0.7 s (9 tiles at 1280 in 500×700; more in a narrow panel; see L4).
Nothing stops a layout change during the loop: a window resize, a side-panel drag, the panel
toggling, or a display change.

**If the panel width changes mid-capture:**
- `scale` changes, so React writes `transform: scale(new)` onto the iframe and overwrites the
  `translate`;
- the remaining tiles capture the old rect over a re-scaled page, and are stitched and saved as
  a success;
- `finally` then restores `before`, the *old* `scale(...)` string. React will not write the style
  again until the scale changes once more, so the preview stays drawn at the wrong scale.

**If the window moves to a display with another pixel ratio:** the tiles are captured at
different densities, but every tile is stitched at the first tile's ratio. That leaves gaps or
overlaps.

**If a tile never returns.** There is no timeout on `previewScreenshotTile`, and the
capturePage-on-a-minimized-window behavior is not verified. A minimized window, or a `capturePage`
that waits for a frame, leaves the capture stuck in this state:
- the iframe at scale 1 and shifted;
- Operator's page drawing hidden;
- `data-preview-shot` set, so every toast stays invisible;
- the button disabled.

This lasts until the call resolves.

Recommendation (Code):
- Abort the loop when the stage's rect or the window's pixel ratio changes. Re-check them before
  each tile, or use a ResizeObserver.
- Give each tile a timeout.
- In `finally`, put back the transform React wants now (`scale(${scaleRef.current})`, or clear
  it in the fitting case), not the string read before the capture.

### L1. A refused Downloads write fails the whole screenshot, clipboard copy included, with a misleading message

`deliver` writes the file first (`saveScreenshot` → `stat` + `writeFile`) and copies to the
clipboard only after. Any write error throws, `saveTiles`/`savePng` return null, and the renderer
shows "Screenshot failed: The preview could not be captured."

Common causes on macOS:
- the TCC prompt for ~/Downloads, which a non-sandboxed app gets the first time it touches that
  folder, being denied;
- the folder missing.

In both cases the capture had succeeded, and the clipboard copy, which needs no file, is lost too.

Recommendation: copy to the clipboard first and independently. Report a write failure as its own
message ("Copied to the clipboard; could not save to Downloads: <reason>").

### L2. A tile can be captured before the out-of-process iframe has re-rastered its new area (plausible)

After each shift the renderer waits two rAFs and main waits 50 ms (`settle`). That waits for the
*renderer's* frame, not for the cross-process iframe to raster the area just moved into view.
Chromium does not raster OOPIF content outside the visible rect; that is why
`captureBeyondViewport` came back blank in Code's probe. On a heavy page (large images, canvas,
many layers) a tile can come back checkerboarded or white.

The probe pages were light. Nothing verifies a tile, and the image is saved either way. A heavier
probe page would settle this.

### L3. Input and late page drawing during the capture

- **Input.** Nothing blocks input over the stage. A click, scroll or hover during the ~0.7 s goes
  to the page in its shifted, unscaled position: a click can hit a different element than the
  one under the cursor. A scroll between tiles tears the image, because the page's own scroll
  changes partway through.
- **Late page drawing.** The page-drawing hide runs once at the start and sets inline
  `visibility:hidden !important` on the elements that exist then.
  - Elements created later are not hidden. The inspector creates its box and label lazily on the
    first hover (`mk()` → `paint()` sets `cssText`), so with Inspect on, a first hover over the
    stage during the capture draws a visible outline into the later tiles.
  - Existing elements are fine: show and hide use `display`, so the hidden `visibility` holds.

### L4. No size cap

The page is `preset × (panel height / scale)`. In a narrow side panel that gets tall:
- 1280 in a 300×1000 stage is 1280×4267 CSS px;
- at 2x that is 2560×8534, an 87 MB BGRA bitmap;
- it is held about three times at the peak (the tile bitmaps, the stitched buffer, PNG and
  clipboard), and takes about 25 tiles, roughly 2 s of visible jumping.

That is acceptable, but there is no ceiling. A one-line guard (refuse, or warn, past N
megapixels) would bound it.

### Nits

- "The preview could not be captured" is shown for save failures too (see L1).
- `fileStem` does not truncate. A very long project name gives a very long file name. macOS
  allows 255 bytes, so this only fails at the extreme.

## Checked and clean

- **(a) Tile math.**
  - At DPR 1 and 2 with integer stage coordinates, `capturePage` returns exactly `w × dpr`, and
    `tileOrigin` rounds onto whole device pixels, so there are no seams.
  - A stage on a half pixel: `tileWindow` ceils and floors inside the stage, `tileShift` moves the
    page by the fraction, and the extra 1 px tile is covered (tested pixel by pixel).
  - Stitching clips a tile that overruns.
  - Fractional DPR from zoom is M2.
  - There is one capture at a time: the button guard, and one `pending` slot in main.
- **(b) Hiding and restoring.**
  - Renderer: `data-preview-shot` hides `[data-toast-stack]`; `capturing` hides the pins, the
    tint, the note card and the grid.
  - Both are restored in `finally`, on success, failure and a thrown tile.
  - Page: the overlay host, edit host, inspector box and label, and `#__op_compose` are hidden
    with inline `!important` and shown again in `finally`, in main for the web preview and in
    `preview-cdp.ts` for the attached app.
  - The overlay and edit children inherit the host's visibility.
  - `setDrawingHidden` swallows an `executeJavaScript` failure, so the hide cannot throw past the
    capture's `try`.
- **(c) Attached Electron app.**
  - The clip is the layout viewport at the visual viewport's scroll offset, at scale 1, so the
    image is the app's CSS viewport × its own device scale factor.
  - Errors return null, which gives the error toast. The unhide runs in `finally`.
  - The probe was not run, as Code notes.
- **(d) The file.**
  - A same-second collision gets `-2`, `-3`… The write uses `flag: 'wx'`, so it never
    overwrites.
  - The project name is reduced to `[A-Za-z0-9._-]`, with leading `.`/`-` stripped. No slash or
    `..` survives, and an empty result becomes `preview`.
  - The path comes from `app.getPath('downloads')`. Reveal in Finder gets the absolute path that
    was written. A failed clipboard copy is reported in the toast.
- **(e) The button.**
  - `camera` is used by this control only (`preview-toolbar-icons.test.ts`), and the
    ToolbarIcon comment records it.
  - The disabled state is drawn by ink with `aria-disabled`, as for back and forward.
  - `onClick` returns early when there is no page or a capture is running.
- **(f) The corners.**
  - Only the main-view Preview overlay in DashboardView changed, to
    `var(--radius-lg) var(--radius-lg) 0 0`. The top keeps its radius.
  - The stack has `marginBottom: 8`, so the square corners sit above the actions footer, not on
    the card's rounded edge.
  - The side-panel Preview is unchanged.
  - `chrome.test.ts` follows the new string.

## Recommended follow-ups (for the coordinator to assign)

- Code, before merge: M1 (the overlaid panel), M3 (abort on layout change, a per-tile timeout,
  restoring the current transform), and L1 (clipboard first, a precise save error).
- Code: M2 (zoom factor in the capture rect, plus a probe at 1.25), L2 (a heavier probe page),
  L3 (an input shield over the stage during the capture), L4 (a size ceiling).
- User, GUI check:
  1. A main-view screenshot with the side panel overlaid.
  2. A screenshot at ⌘+ zoom.
  3. Dragging the panel edge during a 1280 capture.
  4. The first screenshot after a fresh install, to see the Downloads TCC prompt and what denying
     it does.
