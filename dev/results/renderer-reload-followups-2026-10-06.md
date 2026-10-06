# Renderer reload follow-ups (M1, M2, L1, L3)

2026-10-06, Code lane. Branch `operator/ae1e80`, from main @ db7165a. Fixes four findings from
`dev/results/renderer-crash-recovery-review-2026-10-06.md`. Not GUI-verified.

## What changed

### M1: lane dispatches and replies are held while no renderer can route them

- New `electron/src/main/renderer-gate.ts`: `createRendererGate(deliver)`.
  - Events go straight to the renderer only while it is "ready".
  - Otherwise they are kept and handed over oldest first on `release()`.
  - The gate starts held, so the first launch waits for the renderer too.
  - If there is no window when an event is sent, the event is kept and the gate goes back to held, so later events cannot overtake it.
  - At most 200 events are kept; past that the oldest are dropped and logged to stderr.
- `index.ts`: `transcript.on('dispatch')` and `transcript.on('reply')` now go through the gate (`routed`) instead of `broadcast`. The reply is still persisted before it is sent.
- The gate is held on `render-process-gone` **and** on every main-frame cross-document `did-start-navigation`. The second covers Cmd+R, the recovery reload and the error page.
- It is released by a new renderer→main `send`, `rendererReady` (`env.d.ts`, `operator-api.ts` SPEC, `ipc.ts`). `DashboardView` calls it in an effect on `reattachDone`, so the lane tabs exist before any held dispatch is routed.
- Toast text: the two "A dispatch could not be routed" toasts no longer say "The lane that sent it is no longer open".
  - Sentinel path: "Operator has no tab for the lane that sent it (terminal tN), so it cannot tell which project it belongs to."
  - MCP path (the carried project id matched nothing): "No open project matches the one it came from, and Operator has no tab for the lane that sent it (terminal tN)."
  - Both describe what Operator knows. Neither claims the lane is gone.

Replies are held as well as dispatches. A reply is delivered into its target lane by the renderer's
`onOrchestratorReply` handler, so a reply event lost in the gap was a lost delivery, not only a
lost toast.

### M2: the Preview CDP attachment is dropped when the renderer goes away

- `rendererLeaving()` in `index.ts` calls `previewCdp?.detach()` and `previewApi.close()`, along with `routed.hold()`.
- It runs on the same two events as the M1 hold, so it covers both a crash and Cmd+R.
- After a reload, web-preview Inspect, Redlines and the grid are no longer routed to the other app's page.
- The screencast is stopped (`detach` sends `Page.stopScreencast` and closes the socket).

### L1: a reload does not show the window again

`ipc.ts` `showMainWindow` now shows a window only the first time it is asked for that window
(`revealed` WeakSet). Every later renderer mount, whether from a crash reload or Cmd+R, leaves the
window's visibility and focus alone.

I did not use the `!win.isVisible()` check the brief suggested. `isVisible()` is false when the
window is minimized or the app is hidden with Cmd+H. Electron documents it as "visible to the user
in the foreground of the app", which may also exclude a window covered by another app; I did not
verify that. In all of those cases, a crash reload with that check would call `show()`, which also
focuses, so the window would still come forward. With "first reveal only" it never does.

A window recreated from the Dock or the tray is a new object, so its first mount still reveals it.
A window whose first renderer dies before revealing it (review L2) is revealed by the next renderer
that mounts.

### L3: Cmd+R inside the 250 ms delay is no longer followed by a second load

The recovery timer is kept in `pending`. A main-frame cross-document `did-start-navigation` clears
it. Loads that `installCrashRecovery` starts itself only happen after the timer has fired and
cleared `pending`, so they are not affected. This covers both cases:
- A pending reload no longer aborts the load that the user's Cmd+R started.
- A pending error page no longer replaces the app the user's Cmd+R started loading.

### Refactor needed to test the Cmd+R path

To test the event wiring without a GUI, `installCrashRecovery` and `RECOVERY_DELAY_MS` moved from
`index.ts` into `renderer-recovery.ts`. The function now takes the window plus three hooks:
`loadApp`, `quitting` and `rendererLeaving`. Its behavior is unchanged apart from the L3 timer and
the `rendererLeaving` call.

## Tests

- `renderer-gate.test.ts` (6 tests):
  - Held at launch until ready.
  - Held from a crash or reload until the next ready, then sent oldest first.
  - An event sent with no window is kept, and later events do not overtake it.
  - The window disappearing during a release.
  - The limit.
  - `replacesDocument`.
- `renderer-recovery.test.ts`, new `installCrashRecovery` block (7 tests). These drive a fake WebContents (EventEmitter) under fake timers:
  - A crash calls `rendererLeaving` at once and reloads after the delay.
  - **Cmd+R calls `rendererLeaving` (M1/M2 path) and starts no extra load.**
  - Same-document and iframe navigations are ignored.
  - Cmd+R inside the delay cancels the reload (L3).
  - Cmd+R inside the delay cancels the error page (L3).
  - The error page, then its Reload link, loads the app.
  - No reload while quitting.
- Mutation check: with the `clearTimeout(pending)` line removed, both L3 tests fail.

Results:

```
electron  npm run typecheck   → clean (both tsconfigs)
electron  npx vitest run      → Test Files 48 passed (48), Tests 831 passed (831)
root      npx tsc --noEmit    → exit 0
root      npx vitest run      → Test Files 114 passed (114), Tests 1705 passed (1705)
electron  npm run build:main  → done, bundle contains rendererReady / did-start-navigation
```

There is no test for the renderer side (the `reattachDone` → `rendererReady` effect, and the toast
text). Testing it means mounting DashboardView, and no existing test does that.

## Not verified, and left out

- **Not GUI-verified.** Nothing ran in a real window, and following the standing rule I did not launch the app. Unverified assumptions:
  - Chromium fires `did-start-navigation` for Cmd+R on a crashed WebContents. I expect it to, because a reload is a new navigation in a new renderer process.
  - The focus behavior.

  Recipe for the user:
  1. Attach a lane's Electron app in the Preview.
  2. Press Cmd+R, then turn on Inspect on a web preview. The overlay should appear in the web preview.
  3. Have a coordinator print an `OPERATOR-DISPATCH` line, and press Cmd+R right after it. The dispatch should route after the lanes reappear, with no "could not be routed" toast.
  4. Crash the renderer once with `kill -SEGV <Operator Helper (Renderer) pid>` while another app is in front. Operator should stay behind.
- **Behavior change:** dispatches and replies printed while the window is closed (app still running, window closed from its close button) used to be dropped. They are now held and routed when the window is reopened, which may be much later. The renderer's `seen` dedupe still applies.
- Not changed: `onLaneDelivery` and `onCheckoutGone`.
  - A delivery result is matched against `pendingSendsRef`, which is renderer memory and is gone after a reload, so holding it would match nothing.
  - Gone checkouts are re-read with `checkoutGoneList` on mount. Only the toast is lost.
- Not in this brief, so not done: review L2 (error page loaded into a never-shown window) and N1 (log says `reloaded: true` before the reload happens; the error page's log path cannot be selected).
- operator/d13c40 (relaunch/ResumeCard) was not touched.
