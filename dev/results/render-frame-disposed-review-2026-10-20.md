# "Render frame was disposed" fix — review

Date: 2026-10-20. Reviewer: Review lane. Target: branch `fix/render-frame-disposed` @ `8f98791`, one commit on main `5d1cbc4` (`git diff 5d1cbc4..8f98791`). Write-up: `dev/results/render-frame-disposed-fix-2026-10-20.md` in that commit. Line numbers are at `8f98791`. I did not run the tests; the write-up reports 987 electron and 1895 root tests passing.

**No defects found.** The fix covers the throw that was reported, and I found nothing else on the `render-process-gone` or `did-navigate` paths that can still throw on a dead renderer. Below is what I checked, plus two notes on the tests that do not block merge.

## What runs on `render-process-gone` and `did-navigate`

There is one listener for each event in main, both in `renderer-recovery.ts` (`git grep` for `render-process-gone`, `did-navigate`, `mainFrame`, `webFrameMain`, `.frames`, `senderFrame` across `electron/src/main`). Both call `leaving()` → `rendererLeaving()` (`index.ts:146-157`), which runs four steps:

1. **`routed.hold()`**: sets a boolean (`renderer-gate.ts:70`). Cannot throw.
2. **`readyFallback.leaving()`**: clears a timer (`renderer-gate.ts:100,104`). Cannot throw.
3. **`previewCdp?.detach()`** (`preview-cdp.ts:186-197`): closes the CDP socket to the previewed app, which is a separate process and not this renderer's frame. It then calls `cb.detached`, which broadcasts `onPreviewCdpDetached` (`index.ts:431`). That reaches `webContents.send`. I checked this in the installed Electron 43.4.1 framework binary: `WebContents.prototype.send` is `this.mainFrame.send(...)`, and `WebFrameMain.prototype.send` / `_sendInternal` wrap `_send` in `try { … } catch (e) { console.error("Error sending from webFrameMain: ", …) }`. The `mainFrame` getter does not check for a disposed frame; the "Render frame was disposed" error comes from the frame's accessors. So this step logs one "Error sending from webFrameMain" line when the Preview was attached over CDP, and does not throw. It was isolated by the per-step try/catch in any case.
4. **`previewApi.close()`** (`preview-inspect.ts:132-142`): the reported throw. `previewFrame()` (`:74-87`) now wraps the `mainFrame` read, `.frames`, and the `name`/`parent` reads in `isPreviewFrame` in one try, and returns `undefined` on a throw. `close` then sends nothing. When a frame is returned and dies before the call, `executeJavaScript` on a disposed `WebFrameMain` rejects its promise rather than throwing (the binary has the reject path for "Render frame was disposed before WebFrameMain could be accessed"), and every call site attaches `.catch`.

Other listeners on the same `webContents`:
- **`did-start-navigation`** (`renderer-recovery.ts:150`) reads `isMainFrame`/`isSameDocument`, which are plain values on the event details and touch no frame.
- **`did-frame-finish-load`** (`preview-inspect.ts:108-118`) now wraps `fromId` and the `mainFrame` read in a try. `inject(frame!)` after it only calls `executeJavaScript`, which rejects and is caught.
- **`did-finish-load`** only arms the ready-fallback timer.

## Other code you named

- **Ready fallback**: only timers and `routed.release()`. Its `onTimeout` broadcasts, which is the same wrapped send as in step 3.
- **Preview screenshot / shot capture** (`preview-screenshot-capture.ts:51`, `preview-shot-capture.ts:24-45`): reached only from renderer IPC, never from the death handlers. Their frame work goes through `previewApi.hideOutline` / `setDrawingHidden` / `framePainted`, which use `previewFrame()` (now safe) and `inFrame`, which is time-bounded and catches. `capturePage` returns a promise. Both functions are wrapped in try/catch, the tile capture has a timeout, and neither holds state that a dead renderer could leave set. A capture in flight when the renderer dies at worst answers a renderer that no longer exists.
- **No IPC handler reads `event.senderFrame`**. `webContents.executeJavaScript` is an async wrapper over `mainFrame.executeJavaScript`, so a throw there becomes a rejection.

## Can swallowing the error leave `routed.hold()` taken with no reload?

No. The fix makes that case less likely than before.
- `hold` is step 1 and cannot throw. Every later step is isolated (`index.ts:154-156`), and so is the hook as a whole (`renderer-recovery.ts:126-128`). As a result, `decideRecovery`, the log line and the reload or error-page timer always run after it. Before the fix, a throw in step 4 skipped all three, and that is the failure in the 0.28.3 crash.
- The reload goes through `loadApp`, then `did-finish-load`, then `readyFallback.loaded()`. Either the new renderer's `rendererReady` releases the hold, or the fallback releases it after `READY_FALLBACK_MS`.
- Three outcomes leave the hold in place without a reload. None of them comes from this change:
  - `quitting()`: no renderer is wanted.
  - The error page after `RELOAD_LIMIT`: by design, `rendererLoaded` is skipped there, so the fallback is not armed. Held events wait for the Reload link or for the gate's age limit (review M2, 2026-10-06).
  - `win.isDestroyed()` in the timer.
- The `did-navigate` path takes the hold on each committed navigation. The load that follows releases it in the same ways.

## Do the tests prove the path?

They cover what the fix changed, with two weaknesses. Neither is a defect in the fix.

- **T1. The preview-inspect test throws in a different place from Electron.** In `preview-inspect.test.ts`, the `mainFrame` getter itself throws. In Electron 43 the getter returns the disposed `WebFrameMain`, and the throw comes from `.frames` (or `.name`/`.parent`). Both are inside the same `try`, so the fix holds either way. A frame whose `frames` getter throws would model the real failure more closely and would catch a future refactor that moves the `mainFrame` read out of the `try`.
- **T2. The per-step isolation in `index.ts` is not tested.** No test checks that `hold` still runs and that the later steps still run when one step throws. `index.ts` is not unit-tested, so this rests on reading the code. The `renderer-recovery` tests cover the outer guard: a throwing hook still logs `renderer gone … → reload` and loads after `RECOVERY_DELAY_MS`, and a throwing hook on Cmd+R does not throw. Both use the existing harness, which emits the events the way Electron does.
- The write-up says the four new cases fail against the unfixed source. I did not re-run that check.

As the write-up says, nothing here was exercised against a real renderer death. A forced `process.crash()` in a dev build, with the Preview open on an Electron app over CDP, would show the whole path working: the reload, the `renderer-gone.log` line, held dispatches released, and the "Error sending from webFrameMain" line from step 3. That is QA's or the user's to run.

## Recommendation (for the coordinator)

Merge as is. Optional and small: tighten T1 in the same branch (Code). GUI check with a forced crash: QA or the user.
