# Preview zoom isolation — RESULT

Coordinator, 2026-09-14. Branch `operator/preview-zoom-isolation`, on top of stage 4 (`f6a314b`,
`operator/4f0a00`). Done by the coordinator because Operator's delivery brake refused the dispatch
to Code three times. **Not verified in a real window.**

## The defect

Stage 4 scaled the inspect view's page with `webContents.setZoomFactor(scale)`, so a 1280 preset
lays out at 1280 inside a 640px stage. The inspect `WebContentsView` has no partition, so it shares
the default session with the main window, and Chromium stores zoom per HOST in that session with
the port ignored. In the dev build the renderer is `http://localhost:1420` and a lane's dev server
is `http://localhost:5173`: zooming the preview zoomed Operator's own window.

## Probe

`electron/probes/preview-zoom-isolation.cjs` (`npx electron probes/preview-zoom-isolation.cjs`).
Hidden windows, local HTTP servers on three ports, box 640, preset 1280, scale 0.5.

```
zoom: window zoom 0.5, fresh zoom 0.5 → LEAKS; innerWidth 1280, box 100 → preset layout; input untested; reset innerWidth 640 → resets
emulation: window zoom 1, fresh zoom 1 → ISOLATED; innerWidth 1280, box 100 → preset layout; input untested; reset innerWidth 640 → resets
```

- `zoom` is what f6a314b shipped. The main window dropped to 0.5, and so did a NEW window opened
  afterwards on a third localhost port, so the zoom also persists for later localhost pages.
- `emulation` is `webContents.enableDeviceEmulation({ viewSize, screenSize, scale })`. Both windows
  stay at 1, the page's CSS viewport is 1280, and a 100px element measures 100.
- Also run with `--only-emulation` in a fresh process, to rule out the zoom scenario contaminating
  it: same emulation line.
- **Input is untested.** Synthetic mouse events (`sendInputEvent`, after focus and mouseEnter) do not
  arrive in a hidden window under either scenario, including the zoom path that already worked, so
  the probe cannot say whether hover coordinates are mapped under emulation.

## Fix

`electron/src/main/preview-inspect.ts`:

- New `scalePage(view, scale)`: scale < 1 → `enableDeviceEmulation` with the box divided by the
  scale as view and screen size; scale ≥ 1 (Fit, or a preset that fits) or an unmeasured box →
  `disableDeviceEmulation`.
- `apply()` calls `scalePage` instead of `setZoomFactor`.
- `move()` re-applies it, because the emulated size is derived from the box.
- Stale "zoom factor" comments updated in `AppPreviewPanel.tsx`, `preview-inspector.js`,
  `preview-overlay.js`, `types.ts`. The overlay's `1/scale` counter-scaling is unchanged: emulation
  shrinks the page visually the same way zoom did.

## Checks

- Renderer: 82 files, 1266 passed, 0 failed. Root `tsc --noEmit`: exit 0.
- Electron: 32 files, 558 passed, 0 failed. `npm run typecheck`: exit 0. `build-main.mjs`: ok.

## Unverified — needs a real window

1. Hover and ⌥-click land on the right element with a scaled preset (1280 or 768 in a narrow panel).
   This is the one behaviour emulation could plausibly get wrong and the probe could not test.
2. Operator's window stays at 100% in the dev build while redlines are on at a scaled preset.
3. Switching back to Fit returns the page to the stage width.
4. Whether a zoom already leaked by running f6a314b survives an app restart was not checked. If
   Operator's window is stuck small after running that build, ⌘0 (View → Actual Size) resets it.
