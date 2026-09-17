# Redlines changes the preview's layout: cause and fix (2026-09-17)

Commit `3f2c1dd` on `operator/redlines-layout-shift`, branched from `main` at `0ab91b0`.

Not GUI-verified in the running app. The evidence is two Electron probes run on this Mac
(Electron 43.4.1), plus unit tests.

## Cause

Turning Redlines on (or Inspect) did not add a layer to the page the user was looking at. It
replaced that page with a second copy.

- `AppPreviewPanel` renders the page in an `<iframe>`. `nativeHost = inspecting || (redlinesOn &&
  !annotating)`, and when it became true an effect called `previewInspectOpen(display, stageRect)`.
- `electron/src/main/preview-inspect.ts` then created a `WebContentsView` over the stage and ran
  `loadURL(display)`. `display` is the URL Operator loaded, not wherever the user had navigated
  inside the app. For a scaled preset it also applied `enableDeviceEmulation`.
- So the page under the overlay was a fresh load in a different renderer, started from the original
  URL. The iframe the user had been using stayed underneath, hidden by the view. The Grid alone never
  swapped hosts; with Redlines or Inspect on, it was drawn inside that second page too.

`electron/probes/preview-host-parity.cjs` reproduces the swap as it shipped. It builds the stage and
iframe exactly as AppPreviewPanel does, gives the iframe page some state (a counter at 3, an in-app
route change to `/page/deep`, a scroll to 600), then opens the view the way `preview-inspect.ts` did
and measures the page in both. Result at every stage case:

| Stage case | What changed from iframe to view |
|---|---|
| Fit 700×500, Fit 701×500.5, preset 375 in 700 | new document; counter 3 → 0; route `/page/deep` → `/page`; scroll 600 → 0 |
| preset 768 in 700 (scale 0.91) | the same, plus `screen.width` 1710 → 768 |
| preset 1280 in 700 (scale 0.547) | the same, plus `innerHeight`/`clientHeight` 915 → 914 and `screen.width` 1710 → 1280 |
| preset 1440 in 723 (scale 0.502) | the same, plus `screen.width` 1710 → 1440 |

The viewport width, `devicePixelRatio`, width-based media queries and fluid widths matched in every
case. So the layout change the user sees is a different page state, not a different viewport:
- the app back on its initial route;
- its UI state reset;
- scrolled to the top;
- at scaled presets, a 1px shorter viewport, and `screen.width` equal to the viewport, which changes
  layout for any code that reads `screen`.

Ruled out:
- **The injected DOM:** every element the overlay and inspector add is `position: fixed`,
  `pointer-events: none`, attached to `<html>` outside `<body>`, and nothing touches `<html>`/`<body>`
  styles (unit test below).
- **A stored per-host zoom level for localhost** in the app's session (`per_host_zoom_levels` in
  `~/Library/Application Support/Operator/Preferences` is empty).
- **Toolbar height:** the Redlines button toggles colour only; the tools row does not change height.

## Fix

Draw the overlays inside the iframe the user is already looking at, and never load a second page.

- **`electron/src/main/preview-inspect.ts`** (rewritten):
  - The main process finds the preview iframe among the main window's frames: a direct child of the
    top frame named `operator-preview` (`PREVIEW_FRAME_NAME`, set on the iframe).
  - It injects the same scripts as before: `preview-inspector.js`, `preview-overlay.js`, the overlay
    functions, and a page→renderer bridge. It does this with `WebFrameMain.executeJavaScript`, which
    reaches the cross-origin frame that the renderer cannot.
  - `open` and `configure` inject and configure. `close` turns every overlay off in the page instead
    of unloading anything. `move` and `setVisible` do nothing, because the iframe moves and hides
    with the DOM.
  - On `did-frame-finish-load` for that frame (HMR full reload, a link, ⟳), the scripts are
    re-injected and the anchor is reported cleared.
  - There is no `WebContentsView` and no device emulation any more. The renderer already scales the
    iframe with a CSS transform, and the scripts already divide their line widths and chip sizes by
    `scale`.
- **Picks and the redline anchor** (`src/shared/preview-frame.ts`, `PREVIEW_BRIDGE_JS`): the page
  posts `{ __operatorPreview: 'pick', data }` / `{ __operatorPreview: 'anchor', value }` to
  `window.parent`.
  - `AppPreviewPanel` accepts a message only when `event.source` is its own iframe's
    `contentWindow`, and only in those two shapes (`previewFrameMessage`).
  - A pick goes through the same handler as before. The anchor goes to DashboardView through a new
    `onAnchorChange` prop, which feeds the existing `previewAnchored` state (⌘K "Clear measurement
    anchor").
  - The main window's preload still exposes nothing to subframes.
- **Removed:**
  - `electron/src/preload/inspector.ts` (the view's preload) and its build entry;
  - the pick callback in `index.ts`'s `installPreviewInspect` call (picks no longer pass through
    main in Electron).
- **Unchanged:**
  - the Tauri shell: `operator-bridge.ts` and the Rust native webview still lay a view over the
    stage, so the renderer's rect effects stay, commented as Tauri's;
  - Annotate (renderer DOM over the stage; redlines pause meanwhile);
  - the renderer-drawn grid when Redlines and Inspect are off.
- **Comment corrections:** `PreviewOverlayConfig.scale` and the beacon comment in
  `preview-inspector.js` described the view and emulation.

## Tests and probes

- **New, `src/shared/preview-frame.test.ts`** (5 tests, jsdom, the real scripts via `?raw`):
  - with Redlines, the grid and Inspect all on (and a hover), then all off, `<html>` attributes,
    `<head>`, `<body>` attributes and `<body>` contents are exactly as before;
  - every element the scripts add to `<html>` is `position: fixed` and `pointer-events: none`;
  - nothing calls `scrollTo`/`scrollBy` or changes `location`;
  - the bridge posts a pick and an anchor in exactly the shapes the renderer accepts;
  - `previewFrameMessage` rejects everything else.
- **Existing, `src/shared/preview-overlay.test.ts`:** 19 tests, unchanged apart from one comment
  line, all pass. On the first commit I had overwritten this file by accident; the amended commit
  restores it.
- **New probe, `electron/probes/preview-overlay-toggle.cjs`:** runs the real `preview-inspect.ts`
  (bundled by `probes/build.mjs`, which now includes it) at Fit, 1280 scaled and 375. The page first
  gets state: counter 2, route `/app/deep`, scroll 700. Then: Redlines on, a hover and ⌥-click,
  grid on, Inspect on, close, Redlines on again, close. After every step the page has the same
  document id, counter, route, scroll, `innerWidth`/`innerHeight`/`clientWidth`, `scrollHeight`,
  element widths and positions, `<html>`/`<body>` attributes and body child count. The overlay host
  is fixed and click-through, redlines draw 10–14 nodes on hover, and the ⌥-click anchor message
  reaches the host window. `RESULT PASS`, exit 0.
- **Probe, `electron/probes/preview-host-parity.cjs`:** kept as the record of the cause (the old
  swap, re-implemented inside the probe).
- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass. `electron/scripts/build-main.mjs` builds.
- Renderer suite (`vitest run src/renderer`): 89 files, 1316 passed, 0 failed.
- Full root suite (`vitest run`, which includes `src/shared`): 95 files, 1409 passed, 0 failed.
- Electron suite: 36 files, 649 passed, 0 failed.
- All run with the main checkout's `node_modules` and `electron/node_modules` symlinked in, removed
  after.

## Risks and open items

- **Not verified in the running app.** Worth checking by hand:
  - toggle Redlines on a page you have navigated and scrolled;
  - hover and ⌥-click to measure;
  - Inspect → pick → send to Console;
  - ⌘K "Clear measurement anchor";
  - at a scaled preset, a reload with the overlay on.
- **Two previews at once:** if the renderer ever shows two Preview iframes simultaneously, main
  targets the first one named `operator-preview`. I believe the panel and the main view are
  exclusive (`previewInPanel`), but I did not confirm it in the GUI.
- **Keyboard focus is unchanged:** a focused page inside the iframe still keeps keystrokes from
  Operator's renderer handlers, as the view did. Menu accelerators (⌘', ⌘⇧') still work.
- **Pages that block the scripts:** a page with a strict CSP is unaffected because
  `executeJavaScript` is not page script. A page that sets `X-Frame-Options`/`frame-ancestors`
  never rendered in the iframe in the first case. Inspect on such a page used to work, because the
  view was a top-level load, and now does not. The toolbar's ↗ (open in browser) remains.
- **Obsolete probe:** `electron/probes/preview-zoom-isolation.cjs` tests the device-emulation path
  that no longer exists in Electron. I left it in place.
- **The Tauri shell still swaps hosts,** so the same bug remains there.

---

## Rebase onto note screenshots (847616d), 2026-09-17

The fix is now commit `ccf5207` on `operator/redlines-layout-shift`, rebased onto `main` at
`847616d`. It replaces `3f2c1dd` and is a single commit.

### What conflicted, and why

Design's note-screenshot work captured Inspect notes through the inspect `WebContentsView`, which
this fix removes:
- `preview-shot-capture.ts` had an `inspect` source that captured the view with
  `previewApi.size()/capture()` and mapped the pick's page box with `pageToView(box, req.scale)`;
- `preview-inspect.ts` gained `size`/`capture`, which hid the hover outline and captured the view.

Git reported conflicts in `preview-inspect.ts` (the rewrite versus the capture additions) and
`AppPreviewPanel.tsx` (Design's pick handler that captures a shot, versus mine that accepts picks
from the iframe).

### Resolution

Inspect notes now capture exactly like Annotate notes, from the main window over the stage.

- **Renderer** (`src/renderer/lib/preview-shot.ts`):
  - `pageToStage(box, stage, scale)` maps the pick's box to window px as
    `stage.left + box.x × scale`, `stage.top + box.y × scale`, with width and height times `scale`.
    The box comes from `getBoundingClientRect` inside the iframe, so it is already relative to the
    scrolled viewport. The iframe sits at the stage's top-left with `transform-origin: top left`, so
    no further offset applies. `scale` is the one the pick carries, which is the scale the page was
    configured with.
  - `pickShotRequest(p, project, id, stage, outline)` now builds a `source: 'window'` request:
    targets mapped as above (both boxes for a measurement note), `clip` = the stage rect, and
    `hideInspector: true`.
  - `AppPreviewPanel` merges both handlers: picks arrive from Tauri's `onPreviewPick` or from the
    iframe's `postMessage` (checked against the iframe), and either way capture a shot and send the
    note with the screenshot, as Design wrote it.
- **Types:** `PreviewShotRequest.source` is `'window'` only. `scale` is gone and `hideInspector?` is
  new.
- **Main:**
  - `capturePreviewShot` has one path: `capturePage` on the main window's webContents, whose image
    includes the out-of-process iframe. When the request asks, it calls `sources.hideInspector()`
    first.
  - `CaptureSources` is `{ window, hideInspector }`, and `ipc.ts` wires `hideInspector` to the new
    `previewApi.hideOutline()`. That runs `__operatorInspector.hide()` in the preview frame, Design's
    function, which is kept.
- **Removed, since nothing uses them any more:**
  - `previewApi.size`/`capture`;
  - `pageToView` and its test in `preview-shots.test.ts`;
  - the view branch of `capturePreviewShot`.
- **Comment corrections:** the `preview-shots.ts` header, the `preview-shot.ts` header and the pick
  payload comment in `preview-inspector.js` no longer describe a native view or emulated scale.

### Tests

- **Design's tests pass:** `preview-shots.test.ts` 16 (the `pageToView` case moved to the renderer)
  and `preview-shot.test.ts`.
- **`preview-shot.test.ts` adapted:**
  - `pageToStage` at scale 0.5, 1, and with a missing or zero scale;
  - `pickShotRequest` builds the window request with clip and `hideInspector`, or returns null with
    no box;
  - a measurement note maps both boxes.
- **New probe, `electron/probes/preview-inspect-shot.cjs`,** running the real modules end to end
  (`OPERATOR_DIR` in a temp directory; nothing written under `~/.operator`, checked):
  1. `preview-inspect.ts` injects the inspector into a Preview iframe inside a stage offset in the
     window, and the page is scrolled;
  2. a real hover and click on a red element opens the compose card, and "→ Console" posts the pick
     to the host window;
  3. `pickShotRequest` builds the request with the stage rect, and `capturePreviewShot` stores the
     crop;
  4. the stored image is read back, and the red element's pixel bounds are compared with the drawn
     outline's (pure blue).

  | Case | Result |
  |---|---|
  | Fit, scroll 350 | element (50,50)–(365,165) inside outline (47,47)–(368,168), 3px slack |
  | 1280 preset in a 700 stage (scale 0.547), scroll 250 | element (52,51)–(222,112) inside outline (49,48)–(225,115), 3px slack |

  In both cases the in-page hover outline is absent from the stored crop. A control capture without
  `hideInspector` does contain it, so the absence is the hide working.
- `preview-overlay-toggle.cjs` still passes on the rebased code.
- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass.
- Renderer suite (`vitest run src/renderer`): 91 files, 1334 passed, 0 failed.
- Full root suite (`vitest run`): 97 files, 1427 passed, 0 failed.
- Electron suite: 37 files, 665 passed, 0 failed.
- Run with the main checkout's `node_modules` and `electron/node_modules` symlinked in, removed
  after.

### Notes

- **Stale script copy in dev:** `preview-inspect.ts` reads `out/preview-inspector.js` before the repo
  copy. A dev checkout whose `out/` predates the `box` field in picks produces picks with no box, so
  no screenshot. The first probe run hit exactly this; `build:main` refreshes the copy. Packaged
  builds are unaffected.
- **Not verified in the running app:** an Inspect note sent to the Console with its screenshot, at
  Fit and at a scaled preset, plus the earlier checks in this file.
- **Next:** Electron-via-CDP was not started, as instructed.
