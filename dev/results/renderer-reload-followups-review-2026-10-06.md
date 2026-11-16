# Review: renderer reload follow-ups (operator/ae1e80 @ 34ed4f5)

Reviewed 2026-10-06 by the Review lane. Diff: `git diff main...operator/ae1e80`. Read only. No GUI
run, and I did not run the suite on the branch (Code reports 831 + 1705 passing).

**Merge:**
- The merge base is db7165a (= main), and `git merge-tree --write-tree main operator/ae1e80` exits 0.
- It also merges cleanly with the other open branch, operator/d13c40 (`merge-tree` exit 0).

Verdict: the gate works on every release path the brief lists. One trigger can hold it with a
renderer that will never send ready again (M1). Events held while the window is closed have no
age limit (M2).

## Findings, most severe first

### M1. A main-frame navigation that main then cancels holds the gate for good, with no signal (Medium: high impact, low likelihood; plausible, not run)

The trigger is `wc.on('did-start-navigation')` in `renderer-recovery.ts` (`installCrashRecovery`),
which calls `rendererLeaving()` for every main-frame, cross-document navigation *start*. That
calls `routed.hold()`, `previewCdp?.detach()` and `previewApi.close()`.

When a navigation starts, the document has not been replaced yet. A renderer-initiated navigation
that `installNavigationGuards` refuses in `will-navigate` never commits. Examples:
- a stray link,
- `window.location` set by a library,
- a dropped file that reaches navigation.

Electron emits `did-start-navigation` from `DidStartNavigation`, and `will-navigate` from its
navigation throttle's `WillStartRequest`. Chromium runs the observers before the throttles, so the
hold fires and the navigation is then cancelled.

Failure scenario:
1. Something in the live app starts a top-level navigation that the guard cancels.
2. The document stays exactly as it was, so the renderer never mounts again, and its one
   `rendererReady` (the `reattachDone` effect) was sent long ago.
3. From then on, every lane `OPERATOR-DISPATCH` and `OPERATOR-REPLY` is held. The UI looks
   normal, there is no toast, and nothing tells the user.
4. After 200 events, the oldest are dropped with a stderr line that a Finder launch does not
   keep.
5. The same event also detaches the Preview CDP attachment and turns the web preview's overlays
   off under a renderer that still shows them as on.

The only way out is a reload (Cmd+R or a crash).

How likely: I found no `href`, `location.*` or markdown-to-HTML rendering in `src/renderer` today,
so the app itself has few such triggers. The preload's drop guard covers drops. The cost when it
does happen is that all dispatching stops silently.

The other ways the gate legitimately stays held, none of which has a timeout or a visible signal:
- `clean-exit`, or a death of the error page, where nothing reloads;
- the error page while it is showing (by design);
- a DashboardView that throws before `reattachDone`.

Recommendation (Code):
- Hold on *commit* instead of on start: `did-navigate`, or `did-finish-navigation` with
  `hasCommitted && isMainFrame && !isSameDocument`, plus `render-process-gone`. Keep the L3 timer
  cancel on start, because there the dead renderer cannot be the initiator.
- Add a fallback: if no `rendererReady` arrives within about 30 s of the main frame's
  `did-finish-load`, log it to `renderer-gone.log` and release (or show a visible notice).
- Expose the held count somewhere the user can see, such as the tray or a toast after a reload.

### M2. Events held while the window is closed have no age limit, and they are routed all at once when it reopens (Medium, confirmed by reading)

Before this branch, a dispatch or reply sent while the window was closed was dropped (`win()` was
null). Now `deliver` returns false, so the event is kept. It is released when a window is next
created and its renderer becomes ready, however much later that is. Code's notes call this a
behavior change but do not bound it.

Failure scenario:
1. The user closes the window at night with coordinators still running (on macOS this keeps the
   app and the lanes alive).
2. Up to 200 dispatches and replies pile up.
3. When the user reopens the window, all of them are routed in one burst. A dispatch to a role
   with no live lane launches one (`DashboardView` routing, "Launching ${role.name}"). Replies
   are typed into their target lanes hours after they were relevant.
4. If more than 200 piled up, the oldest were already dropped silently.

Recommendation (Code): stamp held events with the time they were held. On release, route only
those younger than a few minutes. Put the rest on the board's Waiting column, or show them in a
single "N dispatches arrived while the window was closed" notice, rather than auto-routing them.

### L1. An event already handed to the old renderer just before Cmd+R or a crash can still be lost (Low)

`send` delivers immediately while `ready` is true. An event sent between the old renderer's last
moment of being able to handle it and the `hold()` is consumed by `webContents.send` and lost when
the document unloads or the process dies. For example, it might be sent in the same tick as the
Cmd+R, or after the process died but before main processes `render-process-gone`. The window is
milliseconds wide, far narrower than the gap this branch closes. I note it only so the fix is not
read as covering every case.

## Checked and clean (the brief's questions)

- **Can `rendererReady` arrive before main installs its handler?** No. `registerIpc` runs before
  `createWindow` in `boot()`. `rendererReady` is a `send` method with `impl: 'native'`, so it is
  in `NATIVE_METHODS`, the preload exposes it, and `ipcMain.on` registers it.
- **Reattach throws or never finishes.**
  - `terminalList` rejecting is caught, and `.finally` still sets `reattachDone`.
  - A missing `terminalList` sets it directly.
  - Hydration has a `.catch(() => setSavedHydrated(true))` and a path for no file store.
  - Every non-crashing path reaches `rendererReady`.
  - Under StrictMode it may fire twice, which is harmless: the second `release` has nothing to
    send.
- **Window closed and recreated from the Dock.** `routed` lives at module scope, so the recreated
  window's `installCrashRecovery` points at the same gate. An event sent with no window leaves
  the gate held, and the new window's renderer releases it once it is ready (subject to M2).
- **A second window.** There is none. `activate` creates a window only when
  `getAllWindows()` is empty.
- **The error page.** Its load is a cross-document start, so the gate holds, as intended. The
  `#operator-reload` link is same-document, so it is ignored by `replacesDocument`. The `loadApp`
  that follows is held and then released by the new renderer.
- **The Preview iframe.** `isMainFrame` is false, so it is ignored. On Electron 43,
  `did-start-navigation`'s first argument carries `isMainFrame` and `isSameDocument`
  (`electron.d.ts` `WebContentsDidStartNavigationEventParams`).
- **Ordering and duplicates in `release`.**
  - It runs synchronously, so a new event cannot interleave.
  - If delivery fails partway through, the failed event and everything after it are kept in order.
  - Dispatches are deduplicated by `operator.dispatch.seen`.
  - Replies are deduplicated by `operator.reply.seen` and by the durable
    `project.dispatches[].replyId` guard.
  - A reply is persisted once (`chat.appendReply` before `routed.send`), and a held reply is sent
    once.
  - The gate does not replay events the old renderer already handled.
- **Routing state at release.** `rendererReady` fires after `reattachDone`, which comes after
  `savedHydrated`, so projects and tabs are loaded. `dispatchRef.current` is reassigned on every
  render, so it holds the reattached tabs before the held events arrive back over IPC.
- **`showMainWindow` showing a window only once.**
  - The `WeakSet` is keyed by window, so a window recreated from the Dock or the tray is a new
    object and is revealed on its first mount.
  - Later mounts after Cmd+H, a minimize, or with another app in front no longer call `show()`.
  - The only caller is `App.tsx:32`.
  - A first renderer that dies before revealing the window leaves it unrevealed, and the next
    renderer reveals it. The never-shown error-page case (previous review, L2) is still open, as
    Code's notes say.
- **`previewApi.close()` and CDP detach on Cmd+R while an Inspect session is open.**
  - `close()` resets `active` and `config`, tries to turn the overlays off in the old document
    (a rejection is caught), and broadcasts an anchor-off.
  - `detach` sends `Page.stopScreencast`, closes the socket and broadcasts `detached` to the
    departing renderer.
  - After the reload, `AppPreviewPanel`'s mount effect calls open or close again, and
    `PreviewElectron` re-attaches when it is shown.
  - On a real reload this is all correct. M1 is the case where the renderer is not replaced.
- **L3 timer.** Both recovery timers clear `pending` before their own load, so the start of
  their own navigation does not cancel anything. Cmd+R during the 250 ms delay cancels the timer.
  The dead renderer cannot start a navigation itself, so the false positive in M1 does not apply
  here.
- **The refactor of `installCrashRecovery` into `renderer-recovery.ts`.** The behavior is the
  same as the merged version, apart from the timer handling and the `rendererLeaving` call.
  `quitting()` replaces direct reads of `teardownPromise`, and is checked at the event and in
  both timers.

## Recommended follow-ups (for the coordinator to assign)

- Code: M1, by holding on commit rather than on start, adding a fallback release with a log line,
  and making the held count visible.
- Code: M2, by adding an age limit on held events, with old ones shown to the user instead of
  being auto-routed.
- User, GUI check: Code's recipe, plus one dispatch sent while the window is closed and the window
  reopened a few minutes later.
