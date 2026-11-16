# Review round 4: suspend idle lanes (operator/1a7f80, 2420035..cd5df8b), with a merge verdict for 376b23b..cd5df8b

Reviewer: Review lane, 2026-10-16. Scope: `git diff 2420035..cd5df8b` (6 files, +482/−50), read against the
code it touches: `closeLane`'s removal chain, the dispatch launch path's handling of an undefined tab,
`handleRestoreSession` outcomes, and `reattachWorktree`.

cd5df8b descends directly from 2420035. main is still at 68fb94d, so the branch merges onto it with no drift. The
whole branch is 42 files, +3149/−147.

I extracted cd5df8b with `git archive` into my scratchpad and ran:
- the root suite: 120 files, 1881 tests passed, the same count Code reports;
- electron `worktree.test.ts` and `last-run.test.ts`: 112 passed, including the new real-git test that a resume
  forks a fresh branch before the removal and returns the lane's own branch after it.

I did not run the full electron suite. Nothing was run in the app.

As asked, only Medium and above get detail; Lows get one line each.

## Round-3 findings: status

| Finding | Status | Checked |
|---|---|---|
| R3-1 wake released before the worktree removal | **Fixed** | `closeLane` records the removal promise in `worktreeRemovalsRef` synchronously, before it returns. `closeUnderGate` takes the hold before the close runs, reads `settled()` after the close returns (the removal needs IPC calls, so it cannot have finished by then), and releases on resolve and on reject. A close that throws releases at once. A close with no removal (a main-checkout lane) releases at return. The close's own outcome is still returned at `closeLane`'s return, so `closeProject`'s 4 s timing is unchanged. A dispatch that waited reaches the cold path only after `git worktree remove`, and `reattachWorktree` then puts the lane's branch back at the same path. Code's real-git test pins both sides of this. |
| R3-2 gate wait with no bound | **Fixed** | `LaneGate.after` with `timedOut` resolves once, either through `go` or through the timer: a `done` flag guards both, and `go` never runs after a timeout. The cap counts from the first wait and covers holds taken in the meantime. Every `wakeLaneRef` call passes a `timedOut`. Each caller handles `'timed-out'`: both reply paths and the kill-time divert report it with the `waited` wording and pass the tab as they saw it, so the record still flips after a close; `handleLaunchRole` returns undefined, so the dispatch is queued and never falls through to the cold path; restore returns `failed`; the overlay click skips `typeHeldKeys`. `stalledKeys` is set only while the tab exists, and is cleared by a click or by a resume that comes back. |
| R3-3 stale row after a user close | **Fixed** | `forgetSavedSession` updates `savedSessionsRef` synchronously. The restore fallthrough uses `rowAfterClose`: `'skipped'` when the row is gone, and it no longer falls back to the row it was called with. |
| R3-4 notes | **Fixed:** the phantom draft. **Unchanged by agreement:** the rest. | `typeHeldKeys` notes a keystroke at the ask, notes the draft only inside the write, and does not ask for readiness when nothing is held. The close completing a dispatch's task as `done`, and a later dispatch submitting a held draft, are unchanged. |

## New defects, Medium or higher

None.

Specifically, I checked these for a deadlock or a wait that never ends:
- Nothing in the removal chain (`completeTerminalTasks`, `runTaskChecks`, `worktreeStatus`, `worktreeCommit`,
  `worktreeRemove`) awaits a gated wake for the same key.
- If one ever did, the 30 s cap now turns the wait into an undelivered report instead of a hang.

## Lows (one line each)

- **R4-L1.** A user close or project close of a suspended lane that still has running tasks keeps the gate for the
  whole task check (`runTaskChecks`, which can take minutes). A dispatch to that role in that time is queued at
  30 s with "could not be launched", which is not accurate. A lifecycle close cannot reach this, because
  `openWork > 0` blocks it.
- **R4-L2.** When the WIP snapshot fails, the close keeps the folder and releases the gate. A waiting dispatch then
  resumes on a fresh branch from base, which is the existing `reattachWorktree` rule. Code documented this.
- **R4-L3.** The live-lane version of R3-1 is still open: a lifecycle close of a LIVE lane, then a dispatch between
  the tab drop and the removal, gets a fresh branch. This was already true on main, so it is not a regression from
  this branch.
- **R4-L4.** The pane still says "Suspended — click to resume" during a gate wait of up to 30 s. Code documented
  this.

Lows carried from earlier rounds, still open: L1 (unsent-input tracking misses reloads, IME and drag-drop), L2
(kill during an idle compaction), L3 (a dispatch before the placeholder restore), L6 (the 4 s readiness wait is
unmeasured), L7 (queued backlog not included on resume), L8 (no suspended state in the Team/roster panel), N4 (a
failed resume leaves the dispatch's task running), N5 (reply-record matching on truncated text, and an undelivered
reply record pins the lane for 24 h), and the R3-4 notes above. None of them loses work silently: each either errs
toward keeping the lane running, or ends in a visible undelivered report.

## Merge verdict for the whole branch (376b23b..cd5df8b)

**From Review's side: approved, with one condition: QA's GUI pass before merge.**

- **Review findings.** Across four rounds I raised 2 High, 4 Medium and, after that, 4 new Medium. All are fixed,
  each with a unit test for the pure part. I re-ran the root suite at each round's commit and the counts matched
  Code's every time.
- **What is not verified.** Nothing on this branch has run in the app, and the DashboardView wiring that joins the
  tested parts has no unit tests. The new logic there is the suspend and lifecycle ticks, the wake routing, the gate
  holds, the divert, the overlay and the placeholder restore. That is several hundred lines of new
  timing-sensitive code, and only a running app exercises it.
- **Effect on upgrade.** The feature is on by default (30 min). Every user who upgrades gets their idle lanes ended,
  so an unseen defect in that wiring would reach everyone at once, not only people who opt in.
- **The condition.** QA's remaining list plus Code's round 2–4 additions, in an isolated `OPERATOR_DIR` with the
  setting at 15 min (or the 1-minute localStorage override). At minimum:
  - a lane suspends and resumes on focus, typing and dispatch, with no duplicate CLI (`ps`);
  - a dispatch sent while a suspend is starting resumes the lane with no "never started" toast;
  - a resumed lane is not suspended again inside the idle window, including after ⌘R;
  - a suspended worktree lane closes at the quiet limit, and a dispatch sent during that close resumes on its own
    branch with its commits;
  - closing a project ends its suspended lanes;
  - relaunch and crash restore suspended lanes as suspended;
  - the rail row and the overlay text render.

If the coordinator wants a lower-risk option, there is one: merge with the default set to Off and switch it on
after QA's pass. That is a decision for the coordinator and the user; I am not recommending it over the GUI pass.
