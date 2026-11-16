# Re-review: renderer reload follow-ups, round 2 (operator/ae1e80-fix @ d918c42)

Reviewed 2026-10-06 by the Review lane. Diff: `git diff operator/ae1e80 operator/ae1e80-fix`
(9 files). First-round findings are in `renderer-reload-followups-review-2026-10-06.md`. Read
only, no GUI run.

**Merge and build:**
- `git merge-tree --write-tree main operator/ae1e80-fix` (main @ db7165a): exit 0.
- `git merge-tree --write-tree operator/d13c40 operator/ae1e80-fix` (d13c40 @ 959f371): exit 0.
- I extracted the combined tree of both branches (698f1e0) to my scratchpad, with
  `node_modules` symlinked from the main checkout. On that tree:
  - `npx tsc --noEmit` (root): exit 0.
  - `electron npm run typecheck` (both tsconfigs): no errors.
  - `renderer-gate.test.ts` + `renderer-recovery.test.ts`: 28/28 passed.
  - `workspace.test.ts` + `restore-guard.test.ts`: 33/33 passed.
  - I did not run the full suites. Code reports 839 + 1705 passing on the branch alone.

Verdict: M1 and M2 are closed. The regression checks the brief asked for are clean, apart from
two low-severity gaps in how expired events are reported (R2-1, R2-2).

## Status of the first-round findings

**M1 (a hold that could stay on forever): closed.**
- The hold, the CDP detach and `previewApi.close()` now run on `did-navigate`. In Electron 43's
  typings that event is main-frame only, is emitted when the navigation is done, and is not
  emitted for in-page navigations. A navigation that `will-navigate` cancels never commits, so it
  holds nothing.
- `did-start-navigation` now only cancels the L3 recovery timer.
- `render-process-gone` still holds at once.
- The fallback is armed by the app's `did-finish-load`, not by the error page's (`onErrorPage`
  guard), and is disarmed by `rendererReady` or the next leave.
- When it fires it logs a `ready-timeout` line to `renderer-gone.log` and to stderr, then
  releases. It checks `isReleased()` first.
- Tests cover a navigation that starts and is then cancelled, the hold on commit, and the error
  page not arming the fallback.

**M2 (no age limit on held events): closed.**
- Events are stamped when they are held. A failed delivery re-keeps them with their original
  stamp.
- On release, events older than 5 minutes go to `onExpired` and are not routed. `onExpired` sends
  `onHeldExpired`, and DashboardView shows one error toast listing the dispatches and saying the
  replies are in the channel.
- Nothing expired reaches the dispatch handler, so an expired event cannot launch a lane.
- The count dropped past the 200 cap is reported once.
- Fresh events (under 5 minutes) are routed as before. That is the intended crash- and
  Cmd+R-reload case.

## Regression checks requested

- **Can the fallback fire before reattach finishes on a slow launch?**
  - It is armed on `did-finish-load`, which comes before the React mount.
  - It then waits 30 s for two IPC reads (`loadSessions`/`loadProjects`, then `terminalList`) and
    their renders, which normally take well under a second.
  - The only realistic way past 30 s is main's event loop blocked for that long at boot, which
    would stall the app as a whole.
  - If it does fire early, the result is the pre-branch behavior for that one release: a dispatch
    can meet a renderer without the sending tab and be dropped with the "no tab" toast. The event
    is logged as `ready-timeout`, so it is diagnosable.
  - Acceptable, and much better than holding forever.
- **Can stale events still launch lanes?** No. Expired events never reach
  `onOrchestratorDispatch`. Only events younger than 5 minutes are routed.
- **Double release.**
  - `ready` → fallback: `ready()` cancels the timer.
  - Fallback → late `ready`: the second `release()` finds nothing kept, no expired events and no
    dropped count, so it does nothing.
  - StrictMode's double `rendererReady`: same.
  - `kept` cannot be non-empty while `ready` is true: `send` sets `ready = false` on any failed
    delivery, and `release` does the same mid-loop.
- **The error page.**
  - Its load commits (`did-navigate`), so the gate holds. Its `did-finish-load` does not arm the
    fallback, so nothing is released into a page that cannot route.
  - Its `#operator-reload` link clears `onErrorPage` before `loadApp`. The app's commit holds
    again, and its load arms the fallback.
  - Cmd+R on the error page reloads the error page: it holds and does not arm.
- **A window recreated from the Dock.** Its first `did-navigate` calls `rendererLeaving`, which
  also drops a CDP attachment left over from the closed window. That is correct.
- **Ordering.** `onExpired` runs inside `release()`, before the fresh events go out. The
  renderer subscribes to `onHeldExpired` on mount, before `reattachDone`, so the notice arrives
  before the fresh events.

## New findings, both Low

### R2-1. An expired dispatch is reported only in a transient toast, and the coordinator is never told

The toast is the only record of an expired dispatch:
- tasks are cut to 80 characters;
- every dispatch is joined into one `detail` string, which with many events is one very long
  toast;
- nothing goes to the board, the dispatch log, or back to the coordinator lane that sent it.

That coordinator believes it delegated the work. Once the toast is dismissed, the full task text
exists only in the coordinator's transcript.

The brief's requirement, "shown to the user instead of routed", is met. Suggest logging each
expired dispatch to the project's dispatch log with a `held-expired` outcome (the board's Waiting
column already renders unrouted outcomes) so it survives the toast, and capping the toast at a
few lines.

### R2-2. Expired events are discarded silently when there is no window, and the toast says "window was closed" when it was not

1. `onExpired` returns early when `mainWindow` is gone, but `release()` has already removed the
   expired events and reset `dropped`. The only release without a window is the fallback firing
   after the window was closed within 30 s of loading, so this is rare, but those events then
   leave no trace.
2. The toast title says the events "arrived while the window was closed". Events also expire when
   the user leaves the error page up for more than 5 minutes, or the app hangs that long during
   load. Suggest a neutral wording such as "while no window could route them".

## Unchanged from round 1

L1: Code notes that holding on commit widens L1. An event sent between a reload's start and its
commit goes to the old document. For a local `file://` or dev-server load that is milliseconds.
I agree it is acceptable.

## Recommended follow-ups (for the coordinator to assign)

- None blocking: M1 and M2 are closed.
- Optional, for Code: R2-1, a durable record of expired dispatches plus a shorter toast, and
  R2-2, a guard and the wording.
- User, GUI check: Code's recipe from round 1. Add one dispatch sent with the window closed for
  more than 5 minutes, which should produce the toast and no lane launch, and one with the window
  closed for less, which should be routed.
