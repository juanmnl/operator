# Block the Badging API for previewed content — RESULT

Brief: `dev/briefs/preview-badge-block.md`. Merged to `main` as **`2274322`** (merge of `00ed49a`), pushed.

## What Electron 43.4.1 actually does (measured, `electron/probes/badge-block.cjs`)

The probe loads each scenario in a hidden window and reads `app.getBadgeCount()` afterwards.
Parent page on `127.0.0.1:<a>`, child on `localhost:<b>`, so the iframe is cross-origin and cross-site.

| Scenario | What it stands for | Baseline (no preload) | With the app's preloads |
|---|---|---|---|
| `frame` | a cross-origin `<iframe>` calls `setAppBadge(3)`, as in the Preview pane | **3, badged** | 0 |
| `top` | the page is the top frame, as in the inspect `WebContentsView` | **4, badged** | 0 |
| `worker` | a dedicated worker inside the iframe | 0 | 0 |
| `sw` | a service worker registered by the iframe | **9, badged** | 0 |

Brief candidate 2 is ruled out: Chromium does not refuse badging from cross-origin iframes in Electron.
Electron exposes no hook on the badge service. The fix is candidate 1, plus a service-worker preload
for the one context a frame preload cannot reach. The candidate-3 backstop (`setBadgeCount(0)` on
change) was not needed.

The probe also checks what each frame can see. With the preloads, a subframe has no `__operatorNative`
and no `__operatorPickBridge`. The app's top frame still has `__operatorNative`, and the inspect
view's top frame still has `__operatorPickBridge`.

## Mechanism

- **`electron/src/preload/badge-block.ts`**: `blockBadging()` replaces `setAppBadge` and `clearAppBadge`
  on `Navigator.prototype` and `WorkerNavigator.prototype` with functions that return a resolved
  promise. They are replaced, not deleted, so a page that calls the API without feature detection
  does not throw in the preview. The function runs in the page's main world through
  `contextBridge.executeInMainWorld`, which executes before page scripts. Changing the isolated
  world's prototype would not reach the page. The function is self-contained because
  `executeInMainWorld` serializes it.
- **Main window** (`main/index.ts`): `nodeIntegrationInSubFrames: true`, so the sandboxed preload also
  runs in the Preview iframe. `preload/index.ts` checks `window.top === window`. A sandboxed preload
  has no `process.isMainFrame`. A subframe gets the badge stub only: no `__operatorNative`, no drop
  listeners. Operator's own top frame is unchanged and keeps the native Badging API. The iframe's
  attributes and sandboxing are unchanged, so annotations and inspect are unaffected.
- **Inspect view** (`main/preview-inspect.ts`, `preload/inspector.ts`): `nodeIntegrationInSubFrames:
  true`; every frame gets the stub; `__operatorPickBridge` is exposed in the top frame only, as before.
- **Service workers** (`preload/service-worker.ts`, registered in `boot()`):
  `session.defaultSession.registerPreloadScript({ type: 'service-worker' })`. Operator's renderer
  registers no service worker, so every worker in the session is previewed content.
- **Stale badge**: `boot()` calls `app.setBadgeCount(0)`, so the "3" is cleared when an updated build starts.
- `scripts/build-main.mjs` bundles the new `out/preload/service-worker.cjs`. `release.mjs` does not
  ignore `out/`, so the file ships.

## Files changed

- `electron/src/preload/badge-block.ts` (new)
- `electron/src/preload/service-worker.ts` (new)
- `electron/src/preload/index.ts`
- `electron/src/preload/inspector.ts`
- `electron/src/main/index.ts`
- `electron/src/main/preview-inspect.ts`
- `electron/scripts/build-main.mjs`
- `electron/src/preload/badge-block.test.ts` (new, 6 tests): no-op behaviour, feature detection
  still finds the methods, nothing added when the API is absent, works after serialization and
  rebuild, targets `Navigator` and `WorkerNavigator`.
- `electron/src/preload/index.test.ts` (new, 2 tests): the top frame gets `__operatorNative` plus
  drop handling and no stub; a subframe gets the stub and nothing else.
- `electron/probes/badge-block.cjs` (new). Run it with
  `node scripts/build-main.mjs && npx electron probes/badge-block.cjs [--app-preloads]`.

## Verification

```
electron/  npm run typecheck       → clean
electron/  npx vitest run          → Test Files 29 passed (29) · Tests 544 passed (544)   (baseline 536)
root       npm test                → Test Files 75 passed (75) · Tests 1141 passed (1141)
root       npm run build           → tsc clean, ✓ built in 1.08s
electron/  probe --app-preloads    → RESULT {"frame":{"badge":0},"top":{"badge":0},"worker":{"badge":0},"sw":{"badge":0}}
```

## Not done / caveats

- **Not tested in the running app.** The probe uses windows configured like the app's, with the built
  preload bundles, not the packaged Operator. Still to check: after installing the next release, open
  mantel in Preview and confirm the Dock stays unbadged.
- Nothing ships until a release is cut. No tag or release was made, as the brief asked.
- The stub is not tamper-proof. A page could restore the native function from a fresh `about:blank`
  child frame's `Navigator.prototype`. This targets pages that badge by accident, not a hostile page.
- With `nodeIntegrationInSubFrames`, IPC handlers can in principle receive messages from subframes.
  In practice no subframe gets `ipcRenderer`, because the preload exposes nothing there.
- Commit trailer: the brief asked for `Claude Fable 5.1`. The session's attribution instruction
  replaces it, and this lane runs on Opus 5, so the commit says `Claude Opus 5`.
