# Fix: "Render frame was disposed" uncaught exception after a renderer death (2026-10-20)

Branch `fix/render-frame-disposed`. Not merged, not pushed.

## Bug

In 0.28.3, after the renderer died of a V8 OOM, Electron showed "A JavaScript error occurred in
the main process — Uncaught Exception: Error: Render frame was disposed before WebFrameMain could be
accessed". Stack: `previewFrame` → `close` → `rendererLeaving` → the `render-process-gone` listener.

`installCrashRecovery` called `hooks.rendererLeaving()` first in the `render-process-gone` handler.
`rendererLeaving()` (index.ts) ends with `previewApi.close()`, which calls `previewFrame()`, which
reads `win.webContents.mainFrame`. On a dead renderer that getter throws. The throw left the
handler before `decideRecovery`, the `renderer-gone.log` line and the reload timer, so the window
never reloaded. `routed.hold()` had already run, so dispatches stayed held with no renderer coming
to release them.

## Changes

- `electron/src/main/preview-inspect.ts:77-86` — `previewFrame()` wraps the `mainFrame` / `frames`
  access in try/catch and returns `undefined` on a throw. Every caller (`apply`, `close`,
  `clearAnchor`, `hideOutline`, `inFrame`) already handles `undefined`.
- `electron/src/main/preview-inspect.ts:110-116` — the `did-frame-finish-load` listener wraps
  `webFrameMain.fromId` and the `mainFrame` read in try/catch and returns on a throw.
- `electron/src/main/index.ts:145-154` — `rendererLeaving()` runs its four steps (hold, ready
  fallback, CDP detach, overlays close) each in its own try/catch, logging
  `[shell] renderer leaving: <step> failed:` with `console.error`. A throwing step no longer skips
  the rest.
- `electron/src/main/renderer-recovery.ts:123-129, 131, 159` — a local `leaving()` wraps
  `hooks.rendererLeaving()` in try/catch (`[shell] rendererLeaving failed:`); both the
  `render-process-gone` and `did-navigate` handlers call it. The log line and the reload decision
  now always run.

## Tests

- `electron/src/main/renderer-recovery.test.ts:187-202` — two new cases in `installCrashRecovery`:
  a throwing hook on `render-process-gone` still prints the `[shell] renderer gone:` line with
  action `reload` and loads the app after `RECOVERY_DELAY_MS`; a throwing hook on `did-navigate`
  does not throw out of the handler and the load still reports `rendererLoaded`. `setup()` gained an
  optional `leaving` implementation.
- `electron/src/main/preview-inspect.test.ts` (new) — mocks `electron`, installs the inspector on a
  window whose `webContents.mainFrame` getter throws, and checks that `open`, `configure`,
  `clearAnchor`, `hideOutline` and `close` do not throw, and that a `did-frame-finish-load` event on
  that window is ignored.

All four new cases fail against the unfixed source (checked by reverting the two source files and
rerunning) and pass with the fix.

Results:
- `electron/`: `npm run typecheck` clean; `npm test` 55 files, 987 tests passed.
- repo root: `npm test` 122 files, 1895 tests passed.

## Not verified

- Not GUI-verified. The fix was not exercised against a real renderer death (OOM or a forced
  `process.crash()`), so the end-to-end path (log line written to `~/.operator/logs/renderer-gone.log`,
  reload, held dispatches released by the new renderer's `rendererReady`) is covered only by the
  unit tests above.
- The renderer-recovery test asserts on the `console.error` line, not on the log file, because
  `logRendererGone` is not awaited by the handler.
- `previewCdp?.detach()` was not checked for a similar throw on a dead renderer; it is now isolated
  by the per-step try/catch either way.
