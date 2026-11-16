# Re-review: last-run.json and crash auto-resume, round 2 (operator/f67f80 @ da02345)

Reviewed 2026-10-06 by the Review lane. Diff: `git diff 97bf1bc da02345` (12 files). First-round
findings are in `last-run-crash-resume-review-2026-10-06.md`. Read only, no GUI run.

**Merge and tests:**
- `git merge-tree --write-tree main operator/f67f80` (main @ e9b49b9): exit 0.
- I extracted da02345 to my scratchpad and ran `last-run.test.ts` (31/31) and
  `workspace.test.ts` + `restore-guard.test.ts` (49/49).
- Code reports the full suites green (1741 + 870).

Verdict: M1, M2, L1, L3, L4 and the age limit are closed. I found no regression in the areas the
brief listed. Nothing blocks merge.

## Status of the round-1 findings

| Finding | Status | How it was checked |
|---|---|---|
| M1 lanes lost on an early crash | **Closed** | `open()` stores the previous lanes in `carried`; details below. |
| M2 update install read as a crash | **Closed** | `freeze()` sets `clean = true` and returns the write; `teardown()` awaits it (capped at 1 s) before `transcript.stop()` and `killAll`. `finish()` is gone. An app ended inside `killAll` now reads as a quit. |
| L1 crash-loop guard timing | **Closed** | Handing out the auto-resume arms a 30 min fallback timer. `crashResumeDone` (renderer, `.finally` of the queue, or at once when nothing was resumable) re-arms it for 2 min. `freeze()` clears the timer. |
| Age limit | **Closed** | `shouldAutoResume` returns false when `now - updatedAt > 24 h`, or when `updatedAt` cannot be parsed. Such a record is offered, not resumed. |
| Heartbeat | **Closed** | `writeNow` rewrites an unchanged record once `HEARTBEAT_MS` (10 min) has passed, driven by the 15 s sync. `updatedAt` stays within about 10 min of the end of the run. |
| L3 locale | **Closed** | `psStart` runs with `LC_ALL=C`. |
| L4 dev instance on ~/.operator | **Closed** | `dev.mjs` sets `OPERATOR_DIR=$TMPDIR/operator-dev` when it is unset and a packaged Operator is running, and prints that it did. An explicit `OPERATOR_DIR` wins. |

**M1 details.**
- `open()` stores the previous record's lanes and releases in `carried`, after the late releases
  and the previous record's own `carried` are merged (`withCarried`).
- `carried` is written in every record until the renderer's first snapshot write after a launch
  that received a record calls `previousRunTaken`.
- A carried lane that comes back in this run is pruned from `carried` by `recompute`.
- I traced the round-1 scenario (run 2 claims, crashes, then run 3):
  - run 3 reads run 2's record, and `withCarried` puts A and B back into `lanes`;
  - they are auto-resumed if run 1's auto-resume was still owed, and offered otherwise
    (`offerOnly`);
  - nothing is lost.
- A crash after `previousRunTaken` is also covered: the lanes still owed are in the snapshot's
  `carriedKeys`, and the lanes already resumed are in the record's `lanes`.

## Regression checks requested

- **Can `clean: true` be written at freeze and the quit then be cancelled, leaving a running app
  marked clean?** I found no such path.
  - Teardown starts only after the quit is decided: QuitGuard's non-asking branch, `decide(true)`,
    `prepareQuit`, or `will-quit`.
  - QuitGuard's "Stay open" returns before teardown.
  - Nothing can cancel a quit after `before-quit`. There are no window `close` handlers calling
    `preventDefault` in main, and no `beforeunload` in the renderer.
  - `will-quit` only holds the quit for one pass.
  - An update whose `quitAndInstall` does not quit is ended by the updater's watchdog
    (`quitAnyway` → `app.quit()`, which passes `will-quit` because `tornDown` is set).
  - Teardown has also already killed the lanes, stopped the transcript and destroyed the tray, so
    a run that somehow survived it would be broken whatever the file said.
- **Can carried lanes grow, or never be cleared, across runs?** They are bounded.
  - `carried` is dropped at the first snapshot write of every launch that received a record.
  - It survives only a run whose first renderer died before that write, because the reload path
    does not call `previousRunTaken`, as Code notes.
  - That run carries them once more. The next boot merges them into its `lanes`, and that launch
    takes them.
  - `offerOnly` is preserved through the merge, so a clean-quit lane is never promoted to
    auto-resume.
  - Growth needs every run's first renderer to die early. Even then the set is limited to lanes
    that have saved rows.
- **What do the 10-min rewrite and the 1 s wait cost?**
  - The rewrite is one small atomic write per 10 minutes, only while the run is not frozen.
  - The 1 s cap is reached only when `open()` is still holding the boot lock, which takes up to
    3 s with a second instance. Otherwise the freeze write takes milliseconds.
  - In the update path the outer 4 s deadline still covers freeze ≤ 1 s, then `killAll`. The
    clean flag is on disk before any kill.
- **Can L4 detect a packaged Operator wrongly?**
  - `ps -axo comm=` on macOS prints the full executable path. I checked on this machine:
    `/Applications/Operator.app/Contents/MacOS/Operator`.
  - The regex also matches each lane's `--mcp-serve` child, because it runs the same executable
    (`process.execPath`). Those children live only as long as the installed app's lanes, so they
    do not cause a false positive on their own. Every `--mcp-serve` running here has a lane of the
    running app as its parent.
  - A false positive would need an orphaned `--mcp-serve`. `mcp-serve.ts` exits when its stdin
    closes.
  - A packaged build from a worktree (`…/Operator.app/…`) also matches, which is correct: it
    defaults to `~/.operator` too.
  - A user who wants a dev instance on `~/.operator` while the installed app runs must now set
    `OPERATOR_DIR` explicitly. That is the intended change, and `dev.mjs` prints it.

## Nits (no action needed)

- If quit comes while `open()` has not claimed the file yet, the capped 1 s freeze can expire with
  the claim still pending. That happens only with the lock held by another boot, or `ps` hanging.
  An app that exits then leaves the previous run's record in place, and the next boot judges it a
  second time. This is the two-instance case only.
- `$TMPDIR/operator-dev` is shared by every isolated dev instance. That is fine, because the boot
  lock and `other-instance` handle two of them.

L2 and L5 were left as decided.

## Recommended follow-ups

- None blocking.
- QA, GUI check: Code's recipe plus the two round-1 cases:
  1. `kill -9` main a few seconds into a crash-resume launch, then relaunch.
  2. An update install with a slow-dying dev server in a lane.
