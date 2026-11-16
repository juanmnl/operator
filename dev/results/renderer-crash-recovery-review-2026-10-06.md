# Review: renderer crash recovery (operator/d5ab40 @ b3b86d3)

Reviewed 2026-10-06 by the Review lane. Diff: `git diff main...operator/d5ab40` (merge base be66384 = current main).
Files: `electron/src/main/renderer-recovery.ts`, its test, `installCrashRecovery`/`loadApp` in
`electron/src/main/index.ts`, and the renderer and main code they depend on. Electron is 43.4.1.
Read only. No GUI run.

Verdict: the main-process change is correct as written and safe to merge. The reload itself works:
documented Electron behavior, nothing in the guards blocks it. The open findings are about what
does not come back with the lanes (in-flight dispatches, the Preview's CDP attachment), and two
cases where the window is shown at the wrong time. M1 and M2 already happen on Cmd+R; this branch
makes them happen automatically on every crash.

## Findings, most severe first

### M1. A dispatch sent during the recovery gap is lost, and the toast blames a lane that is alive (Medium, confirmed by reading)

- `electron/src/main/transcript.ts:759` emits each `dispatch` exactly once (`pendingDispatches.splice(0)`).
- `electron/src/main/index.ts` (`transcript.on('dispatch', …)` → `broadcast`) sends it to whatever renderer is there.
- `src/renderer/views/DashboardView.tsx:2276-2296` marks the id as seen in localStorage *before* it looks up the source tab.

Failure scenario: a coordinator prints an `OPERATOR-DISPATCH` line while the renderer is dead (crash
→ 250 ms delay → load → mount). The broadcast goes to a renderer that no longer exists and is
dropped. Second case: the line arrives after the new renderer subscribed but before the reattach
effect (`DashboardView.tsx:2726`, which waits on `savedHydrated` and then `terminalList`) has rebuilt
the tabs. Then `srcTab` is undefined, the id is written to `operator.dispatch.seen`, and the user
gets "A dispatch could not be routed — The lane that sent it is no longer open". That message is
false, because the lane is running. Either way the task is never routed and nothing retries it.
`onLaneDelivery`, `onCheckoutGone` and `onOrchestratorReply` are also broadcast once and lost in
the dead window. Replies are persisted before they are broadcast. Whether a lost reply event also
loses the delivery to its target lane was not traced.

MCP `dispatch` calls are not affected: they go through the artifact store, and the tool times out
and says so honestly when the renderer is dead.

This already happens on Cmd+R. The branch makes it happen on every crash, and the error page and
Code's notes say the lanes "come back". They do, but work sent between them while the window was
down does not.

Recommendation (Code): main queues `dispatch` events (and `delivery`/`reply` if those matter)
from `render-process-gone` until the renderer signals that reattach is done. Alternatively, the
renderer holds dispatches until `reattachDone` and does not mark an id seen while its source tab
cannot be resolved yet.

### M2. A Preview CDP attachment survives the reload, and web-preview Inspect then does nothing (Medium-low, confirmed by reading)

- `electron/src/main/preview-cdp.ts:165-169`: `conn`/`attached` live in main.
- The only detach calls are `src/renderer/components/session/PreviewElectron.tsx:66,73` (unmount cleanup). A crashed renderer never runs them.
- `electron/src/main/ipc.ts:358,485-488`: `previewInspectOpen` returns without doing anything while `previewCdp.isAttached()`, and configure/close/clearAnchor are routed to the CDP page.

Failure scenario: a lane's Electron app is attached in the Preview and the renderer crashes. After
the reload the user opens a web preview and turns on Inspect, Redlines or the grid. Nothing appears.
The configuration is applied to the other app's page over CDP instead. This lasts until the user
reopens that lane's Electron preview, because `attach` calls `detach('switching')`. Meanwhile
`Page.startScreencast` (`everyNthFrame: 1`) keeps encoding JPEG frames on every repaint of the
attached app and sends them over IPC to a renderer with no listener. For an app that animates, that
is a continuous CPU cost with no visible symptom.

Code's notes say "Preview inspect / CDP attach … is not reset on recovery" but do not name this
consequence.

Recommendation (Code): in `installCrashRecovery` (or on any main-frame cross-document navigation),
call `previewCdp?.detach()` and `previewApi.close()`. The web-preview half (`preview-inspect.ts`
`active`/`config`) already recovers on its own, because `AppPreviewPanel.tsx:397` calls
`previewInspectClose` when it mounts. The CDP half has nothing that clears it.

### L1. An unattended reload can bring the window to the front and take focus (Low, plausible, not GUI-verified)

`src/renderer/App.tsx:32` calls `showMainWindow()` on every mount, and `electron/src/main/ipc.ts:456`
answers that with `win.show()`. Before this branch a reload was always user-initiated (Cmd+R). A
crash reload is not. If the renderer dies while the user is in another app, or has Operator hidden
or minimized, the reloaded renderer calls `show()` about 1 s after mount. On macOS, `show()` both
shows the window and focuses it, which is why `showInactive()` exists. The likely result is that
Operator comes forward in the middle of whatever the user is typing.

Recommendation (Code): `showMainWindow` only calls `show()` when `!win.isVisible()`. Or main
skips it when `launchKind` already answered `reload`.

### L2. A renderer that crashes at launch puts the error page in a window nobody can see (Low, confirmed by reading)

The window is created with `show: false` (`index.ts:106`). Only the renderer reveals it, at
`App.tsx` mount + ~1 s, with a 3 s safety timer. The error page has no script. `onAppActivated`
(`electron/src/main/activation.ts:30`) ignores windows that are not visible, so clicking the Dock
icon does nothing.

Failure scenario: a build whose renderer dies within its first second on every load reloads three
times, and the error page then loads into a hidden window. The app is running, the Dock icon is
lit, and no window ever appears. The only way to reach it is the tray's "Show Operator". A renderer
that dies on every load is the case the error page was written for. The 7-day-uptime crash is not
affected, because that window was already visible and stays visible across reloads.

Recommendation (Code): in the `error-page` branch, call `win.show()` when `!win.isVisible()`.

### L3. Cmd+R during the 250 ms delay causes a second load (Low)

`index.ts` `installCrashRecovery`: the `reload` and `error-page` timers do not check whether
something else has already navigated the window. Cmd+R (menu role `reload`, `app-menu.ts:28`)
pressed on the black window inside those 250 ms starts a load, and then the timer starts a second
one that aborts the first. In the error-page case, the timer replaces the app that the user's
Cmd+R had just started loading with the error page. The window is short, so this is cosmetic.

### N1. Nits

- `logRendererGone` records `reloaded: true` when the reload is scheduled. If the window is destroyed within the next 250 ms, the reload is skipped but the log still says it happened.
- The error page's `<body>` is `-webkit-app-region: drag`, so the log path in `<code>` cannot be selected or copied. Give the `code` element `-webkit-app-region: no-drag` (and `user-select: text`).

## Checked and clean

- **Does a load after `render-process-gone` start a new renderer (Electron 43.4.1)?** Yes. The
  installed `electron.d.ts` (`forcefullyCrashRenderer` doc) states that a `reload()` after the
  renderer is gone happens in a new process. `loadURL`/`loadFile` use the same navigation path.
  Electron emits `render-process-gone` on a WebContents only for its primary main frame's process.
  In the packaged app (file:// vs http://localhost) a crash in the Preview's out-of-process iframe
  therefore does not reload the app. In dev, `DEV_URL` and lane dev servers are both
  `http://localhost` (the same site, since ports do not count), so a preview iframe can share the
  app's process. That is not new.
- **Navigation guards, CSP, preload and window-open handler against the `data:` page.**
  - `will-navigate`/`will-redirect` are not emitted for programmatic `loadURL` or for in-page
    fragment navigation (`electron.d.ts`, the `will-navigate` and `will-frame-navigate` docs).
    Neither the error-page load nor the Reload click reaches `isAllowedNavigation`.
  - Main has no `webRequest` filter, no `protocol.handle` and no CSP header. The renderer HTML has
    no CSP meta tag.
  - `setWindowOpenHandler` does not apply, because the page has no `window.open` and no
    `target=_blank`.
  - The preload runs on the `data:` page and exposes `__operatorNative` there, but the page runs
    no script. The two embedded values are HTML-escaped: `reason` comes from Chromium's enum and
    the log path from `OPERATOR_DIR`. The preload's drop guard is installed there too.
  - A fragment-only `href` resolves against a `data:` base URL: the WHATWG URL parser accepts `#`
    against an opaque path. `encodeURIComponent` encodes the `#` characters in the CSS colors and
    in the `href` itself, so the data URL is not truncated.
  - `did-navigate-in-page` fires for anchor clicks (`electron.d.ts`). The `isMainFrame`,
    `onErrorPage` and `endsWith` checks are sufficient.
  - Not verified in a real window: that Chromium fires it for a fragment link on a top-level
    `data:` document. I expect it to, because same-document navigations do not go through the
    data-URL navigation throttle.
- **Reattach after a reload, and duplicates.**
  - `joinReattach` pairs live ptys with saved rows by `claudeSessionId`.
  - `setTerminals` keeps any existing tabs (`DashboardView.tsx:2743`). No reattach duplicates
    because of that, but a launch that raced it would drop the reattach (see M1 for the dispatch
    side).
  - The restore effect returns early when `terminals.length > 0` (`DashboardView.tsx:4922`), so
    auto-resume cannot start a second copy of a live lane.
  - `launchKind` answers `reload` after the first claim (`launch-kind.ts`), so the reload does not
    drop the user onto the home overview.
  - `TerminalPane.tsx:510-536` subscribes before fetching history. A few bytes can repeat at the
    seam. That is documented and already existed.
  - Scrollback older than `HISTORY_CAP` (256 KB per pty, `terminals.ts:38`) is lost.
  - Exits that happen while the renderer is dead are repaired by the 5 s `terminalList` reconcile.
- **Main-side subscriptions after a reload.**
  - `broadcast` looks up the window every time it sends (`ipc.ts:51`). The WebContents object is
    the same across a renderer swap, so pty data reaches the new renderer.
  - There is no flow control, so a dead renderer does not stall any pty.
  - `preview-inspect.ts` attaches `did-frame-finish-load` once per window (`watched`), with no
    duplicate listener. Its stale `active` flag is cleared when the panel mounts (see M2).
  - The bench counts reloads, by design.
  - The two new `wc.on` listeners are per window, are dropped with the WebContents, and share no
    module state. A window recreated from the Dock or tray starts with an empty reload budget.
- **Races with teardown and window close.** `teardownPromise` is checked both in the event handler
  and in each timer. The update path's `prepareQuit` sets it before `quitAndInstall`. The timers
  check `win.isDestroyed()`. Using `teardownPromise` inside `installCrashRecovery` before its
  `let` declaration is safe: it is only read at call time, after the module has finished loading.
- **Budget logic.**
  - `decideRecovery` reloads three times inside 60 s and shows the error page on the fourth crash,
    which matches the page's "4 times in a minute".
  - If the error page itself dies, nothing is reloaded, so there is no loop.
  - A Reload click does not add to the budget. If the app dies again within the minute, the error
    page comes straight back.
  - The tests cover all of this, and they write to the per-file `OPERATOR_DIR` set by
    `vitest.setup.ts`.
  - The log is bounded: at most four lines a minute while crashes keep coming.

## Not done

I did not run the suite on the branch, because that needs a checkout of it and I work on main.
Code reports 818/818 tests passing and a clean typecheck. Nothing here was GUI-verified. The test
recipe in Code's notes (`kill -SEGV` the renderer helper once, then four times inside a minute) is
still the check that settles the remaining "plausible" items.
