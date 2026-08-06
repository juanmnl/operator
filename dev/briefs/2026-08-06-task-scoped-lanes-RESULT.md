# RESULT — Lanes are task-scoped: they close after a keep-warm window and resume on demand

Built on branch `operator/808fe8` (worktree `~/.operator/worktrees/operator-808fe8`), off `cbdd4ef`.
`npm test` 665 green (650 + 15 new), `cargo test` 142 green (140 + 2 new), `tsc --noEmit` clean,
`npm run build` clean.

## The grace window: 10 minutes, and why

`DEFAULT_KEEP_WARM_MINUTES = 10` (`src/renderer/lib/lane-lifecycle.ts`). A lane that reports
`task_status done` closes after ten minutes with nothing further happening — measured from the
**later** of the report and its last transcript activity, so the tail of the turn that reported is
never cut.

Ten is the smallest window that still keeps the common re-dispatch warm. Inside a burst — a
coordinator's follow-up, a human reading a result and replying — the gap is under ten minutes and
the lane is still hot, so the spawn cost (process start + context rehydration) is not paid. The gaps
that actually cost memory are the overnight ones, and those are hours. Configurable in Preferences →
**Close finished lanes**: Never / 5 / 10 / 30 / 60 min. `Never` (0) turns the whole thing off,
backstop included — one switch, not two.

The went-quiet backstop is a separate constant, `DEFAULT_QUIET_MINUTES = 120`, because it answers a
different question: not "is this lane done" but "has this lane stopped being a lane".

## What happens to a lane that goes quiet without ever reporting

It **does not close on the short path**, and it never gets labelled finished. Concretely:

- The 10-minute clock only starts on an explicit `operator__task_status(id,'done')`. No report, no
  short-path close, however long it sits idle.
- It closes on the 2-hour backstop instead, with `reason: 'went-quiet'`.
- Its still-running tasks are marked **`abandoned`, not `done`** — the status that already means
  "its run ended but we never saw it finish". They land in the board's closed column carrying the
  existing `unseen` marker and counting toward the "unconfirmed" tally, so the difference is
  durable and visible after the toast is gone, with no new UI. The verification gate (`checkCommand`)
  is **not** run for these: "done and green" is a claim about finished work.
- The toast says it plainly: *"<Lane> went quiet — closed. It never reported a task done. Its work is
  marked abandoned, not done; the thread is still resumable."*
- The reason is persisted on the saved session as `suspendedReason: 'went-quiet'`, so it survives a
  restart.

This is the charter-dependency risk the spike named ("the same risk as sentinels, moved, not
removed") handled without pretending silence is success.

## The invariant: close means detach

`handleCloseSession(session, suspend?)` — the automatic path passes `suspend`, and only then:

- the saved session is **kept**, stamped `suspendedAt` + `suspendedReason`, with its now-stale
  `terminalId` cleared (a stale pty id is what made tasks unmatchable for months). A close the USER
  asks for still forgets the record; nothing about the ■ button changed.
- `claudeSessionId`, `worktreeBranch`, `worktreeBase`, `sourceCwd` all survive → resumable.
- transcript JSONL and `chat.db` are untouched by any of this → readable.

It is the same teardown route, not a parallel one — `closeProject` still funnels through it, and the
hung-lane resilience from the four-bug fix is intact.

## What was built

**`src/renderer/lib/lane-lifecycle.ts`** (new, pure, 15 tests) — the whole decision. Guards in order:
auto-close off → pty already exited → **coordinator** (out of scope by design) → **the lane you are
looking at** → open work in flight → no tracked session (unknown ≠ idle) → **busy** → **`waiting`**
→ grace window. `planLaneCloses` sorts quietest-first and paces to 3 per tick, reporting what it
deferred (never a silent cap; the rest close on the next tick — the pacing exists because every close
runs `git` in the same source repo and 27 at once contend on the index lock).

**Completion signal** — the artifact-status poller now stamps `doneReportsRef[terminalId]` on a
`done` event. Stamped even when the task id resolves to nothing: lanes are told to call
`task_status(id,'done')` but are never handed the store's uuid, so an unresolvable id is the common
case and is still an explicit "I finished". Age-guarded to one hour so an event left pending by a
dead renderer cannot mark a *different* lane done after a restart (`terminalId` collides across runs).

**The close effect** (`DashboardView`) — 30s timer, gated on hydrate + reattach. Time is the input,
so it ticks rather than reacting to renders.

**Spawn on demand with `--resume`** — `handleLaunchRole` looks for a suspended record for
(project, role) and hands `handleLaunchSession` a `resume` block: `--resume <claudeSessionId>`, the
lane's own **branch reattached**, and the **same saved-session key** so the row is rewritten in place
(clearing `suspendedAt`) instead of leaving a suspended twin. Nothing about the dispatch protocol
moved: `queue`/`create` were already the routes, and this only changes what they launch into.

**Worktree lifetime = task lifetime** — `worktree::create_worktree(source_cwd, reuse_branch)` gains a
reattach path (`git worktree prune`, then `worktree add <path> <existing-branch>`, same directory
name), falling back to a fresh branch when the branch is gone or genuinely checked out elsewhere. A
resumed lane therefore gets a tree containing its own committed work — a fresh branch would hand the
resumed conversation a tree without the edits its transcript remembers making, which is worse than a
cold start because it looks correct. `handleRestoreSession` rebuilds the dir the same way, so ⌘K
"Reopen" on a suspended lane works instead of spawning into a missing path.

**WIP snapshot before reaping, unconditionally** — every worktree removal in the close path now runs
`worktreeStatus` → `worktreeCommit("WIP preserved before reaping this worktree")` first, message and
all from the 2026-08-05 precedent. A failed commit **cancels the removal**: a stray directory is
recoverable, deleted unsaved work is not. This applies to manual closes too — that path also used to
take loose edits with it.

## Verify

| Claim | Status |
|---|---|
| Reports done → closes after the window; branch kept | Logic covered by `lane-lifecycle.test.ts`; the branch-keeping close path is unchanged and already shipped |
| Re-dispatch resumes the same thread (`--resume`) on the same branch | `worktree.rs::a_suspended_lane_comes_back_on_its_own_branch_with_its_own_work` proves the tree half; the `--resume` half is `buildArgs` (already tested) fed by the new `resume` block |
| Unreattachable branch still starts a lane | `an_unreattachable_branch_still_starts_a_lane` |
| Quiet lane doesn't close on the short path, and is distinguished | `reported done vs went quiet` tests + `abandoned` outcome + distinct toast + persisted `suspendedReason` |
| `waiting` is never auto-closed | dedicated test, asserted even at 10 hours idle |
| Uncommitted edits snapshotted before removal | code path in `handleCloseSession`; **not** covered by an automated test — it is inside the component, and the snapshot is two bridge calls |
| A closed lane's history is browsable | **needs the GUI, i.e. yours.** The record survives (that is tested by construction: `pruneSavedSessions` keeps one record per (project, role) and the suspended one is it), and restore now rebuilds the missing dir — but that the chat panel renders it is a screen fact |
| `npm test` / `cargo test` / build | 665, 142, clean |

**Measured, before** (this machine, right now, dev build running): **11 live lanes, 3.1 GB total
lane RSS**, WebKit WebContent at **604 MB**, app process 180 MB. The *after* number needs the new
build running through a working day, which is a GUI run and therefore yours — the honest thing to
report is the baseline and the mechanism, not a number I cannot take.

## Deliberately not done

- **The dispatch protocol** — untouched, as instructed. No `operator__dispatch`, no sentinel changes.
- **Auto-merging a lane's branch** — still human-gated.
- **The age-based worktree reaper** — it was a *recommendation* in
  `2026-08-05-worktree-architecture-RESULT.md` and was never built; nothing here removes the case for
  it as an anomaly backstop, and nothing here needs it.
- **Resume for a lane the user closed by hand, or one left over from a previous app run.** Resume is
  tied to `suspendedAt` — i.e. to lanes *Operator itself* closed. Making the plain Launch button
  always resume any prior session for a role is a bigger behaviour change than lane lifecycle, and
  people press Launch expecting a fresh lane. A suspended record persists across restarts, so the
  case that matters (dispatch after a restart) still resumes.
- **A "suspended" badge in the roster.** The distinction that had to be visible — completed vs went
  quiet — is carried by the task board's existing `done`/`unseen` split, which needed no plumbing. A
  lane badge would need a new prop threaded DashboardView → ProjectView → RosterPanel for a fact the
  board already shows.
