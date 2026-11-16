# Mass lane exit, 2026-10-05 08:04:06 local (13:04:06Z)

Research only. Source read in `electron/src/main/`, `src/renderer/`; evidence read from `~/.operator`, `~/.claude/projects` and the macOS unified log. Nothing was run against `~/.operator` except read-only sqlite and file reads on copies.

## Short answer

1. The lanes did not end through any Operator code path that kills a lane. They ended on their own (the `claude` processes exited), all within about 15 ms of each other, across 7 projects.
2. `worktree_done` / retire-released-lane did not cause this and cannot end lanes in other projects. The umbra "released" record is from 02:10:53Z. 13:04:09Z is only when main handled it, as a consequence of the exit.
3. What sent the exit signal is **not identified**. The code leaves one in-app candidate (Settings "Dev servers" kill) and the evidence cannot separate it from an outside actor. A one-line question to the user would settle it (see "How to settle it").
4. One lane survived because its CLI never received the exit; only its background tool processes were stopped (details below). Why it was spared is not established.

## What is verified

### V1. Scope and timing

- 26 transcripts under `~/.claude/projects/*` have mtime 08:04:06 (fastrack, vdlc, mantel, web27, umbra, operator, uwazi_app). Each ends with a `cost-state` line, then a `queue-operation` `<task-notification>` with `<status>killed</status>` for a background command. That is the CLI's orderly shutdown stopping its background tasks, not a SIGKILL.
- Unified log, `log show` for 08:04:05.790–08:04:05.803: ~25 pids (19 of them match `shellPid` in `~/.operator/dev-leases.json`: 2616, 3777, 4562, 9018, 9087, 23805, 25216, 30619, 33773, 39169, 39446, 48336, 58288, 58796, 76342, 77601, 80318, 80442, 83733) log `CoreAnalytics: Entering exit handler` within 3 ms, then close their XPC connections by 08:04:05.803. Their `Operator --mcp-serve` children (pids 35217, 19685) exit at 08:04:05.9, after their parents.
- The process name in the log is `2.1.284` for every one of these pids, including t65 whose session record says 2.1.289. I do not trust that label (it looks like a cached name) and draw nothing from it.
- Only pid 38959 (t60, `f030dc50`) did not exit.
- No sleep or wake events in `pmset -g log` between 2026-10-02 and now. The exits ran exit handlers, so this is not jetsam (SIGKILL).

### V2. The exits bypassed Operator's kill path

Three independent facts:

- **Leases were not released.** `~/.operator/dev-leases.json` still holds a lease for every one of those lanes (t0, t1, t4, t7, t8, t22, t23, t28, t29, t37, t39, t42, t43, t44, t50, t57, t63, t64, t65), all with `appPid: 1250`. `TerminalManager.kill` releases the lease at `electron/src/main/terminals.ts:517`; `teardown` calls `releaseLeasesOf(process.pid)` at `electron/src/main/index.ts:170`. A pty that exits by itself runs only the `onExit` handler at `terminals.ts:369-375`, which releases nothing and does not remove the entry from `this.terminals`.
- **`lane-exit` auto-check fired.** `worktree-auto-check.json` has trigger `lane-exit`. That trigger is sent only when `selfExit` is true (`index.ts:276`), and `selfExit = !managed.killing` (`terminals.ts:374`). `kill()` sets `killing` before any signal is sent (`terminals.ts:453-462`), so an Operator kill never produces `selfExit`.
- **Not quit/teardown.** `killAll` runs only inside `teardown()` (`index.ts:167`). Teardown then closes the chat and artifact stores (`index.ts:187-188`). Main kept answering afterwards: `dispatch_requests` #786 was answered at 13:09:14.954Z and written to `artifacts.db`, and pid 1250 never restarted. Teardown would also have killed t60.

### V3. Not a dispatch

`artifacts.db` `dispatch_requests` has exactly one row after 12:30Z: #786 at 13:09:14Z (this task). Nothing was dispatched at 13:04. A retire (`DashboardView.tsx:3495-3512`) also ends one lane through `terminalKill` → `kill()`, which is V2's excluded path. Routing is scoped by project and role (`src/renderer/lib/dispatch.ts:99-102`, `markReleased` at `dispatch.ts:202-212`).

### V4. `worktree_done` did not act, it was a consequence

- `worktree_release` row 89 (umbra-ff6b40, t65): `at = 2026-10-05T02:10:53Z`, `handled_at = 13:04:09.965Z`, outcome `removed`. The lane called `worktree_done` 11 hours before.
- Seven released-but-still-running lanes across four projects were handled between 13:04:08.1Z and 13:04:09.97Z: t29 and t42 (operator), t50 (web27), t57, t64, t65 (umbra), t63 (fastrack). Releases were opened between 2026-10-02 00:32Z and 2026-10-05 02:10Z. All five `removed` rows were created by `releaseWorktreeOnExit` (`worktree-reap.ts:1663-1696`), called from the pty exit handler (`index.ts:273-274`). The two `refused` rows (umbra-1d3bc0, umbra-d10100) hit the depth-8 nested-checkout guard in `.build/`; those two worktrees were not removed.
- A release row is only acted on for its own `terminal_id` + `path` + `app_pid` (`chat-store.ts:501-506`). Nothing in `worktree_done` (`mcp-serve.ts:364-390`) or in the retire path touches another terminal or another project. So the answer to "can a `worktree_done` in umbra end lanes in uwazi_app" is no.
- The ~49 lines in `worktree-trash.log` at 13:04 are the trash drain that runs with each removal (8 lines per removal, as on earlier days). They are not a separate sweep.
- `worktree-pending.json` no longer exists; main consumed it.

### V5. Why `appPid` was cleared on those sessions

The renderer writes `sessions.json` via `saveSessions` (`ipc.ts:448-451`). Main re-stamps `appPid` only on records whose `terminalId` is in its live pty table (`worktree-reap.ts:783-788`). Renderer-written records carry no `appPid`. So a record loses `appPid` when the renderer saves after the pty is no longer live. No separate sweep clears it. t60 and the newer lanes keep `appPid: 1250` because their ptys are still live. `sessions.json` was rewritten at 08:09:41 and the current file no longer shows the 13:04:06 cluster except t65, so the transcripts and the unified log are the durable evidence, not that file.

### V6. The survivor (t60, `f030dc50`)

`f030dc50`'s transcript shows five background tasks (four `Monitor` scripts and one `while pgrep` loop) reported at 13:04:05.774–05.784Z as `failed (exit 144)`. That is 6–16 ms before the other lanes' exit handlers, and `exit 144` appears nowhere else in that transcript. So the same event hit the survivor's tool processes and not its CLI. Why is unknown. Claude's Bash tool children run in their own process groups (`ps`: pid 96362, pgid 96362, ppid = lane), while the CLI, its `--mcp-serve` and `caffeinate` share the CLI's pgid. A group-based kill that reached the CLI's group in 25 lanes and only the tool groups in t60 would fit this; I could not confirm it.

## Causes considered, ranked

| # | Candidate | Status |
|---|---|---|
| 1 | Something sent a signal burst to the lanes from outside the `kill()`/teardown path. Either Settings → Worktrees → Dev servers → Kill (`WorktreesSection.tsx:479` → `ipc.ts:272-281` → `reapTree` in `reap.ts:186-218`, which signals whole process groups: `SIGTERM` to every distinct pgid, then SIGKILL after 1.5 s), or a process outside Operator (`pkill`/`killall` by the user, another tool). | **Open, most likely.** Fits V1 (single burst, orderly shutdown) and V6 (tool groups first). `devServerKill` is the only user-triggered path in the app that signals arbitrary groups without `killing` being set. Needs a user click; it logs only to Electron stderr, which is not persisted. No lane transcript in 12:55–13:04 contains `pkill`, `killall` or `kill -`. |
| 2 | The CLIs exited on their own at the same time (server-side or version trigger). | Possible, low. The lanes ran mixed versions (2.1.283–2.1.289 in `sessions.json`), t60 runs 2.1.289 like others that died, and the exits were 3 ms apart, which looks like one sender, not independent timers. |
| 3 | Renderer lane-lifecycle auto-close (`DashboardView.tsx:3727-3811`, `lane-lifecycle.ts:131-147`). | Rejected: capped at 3 per tick (`planLaneCloses(..., limit = 3)`), goes through `terminalKill`, raises a toast per lane, and skips focused/busy lanes. |
| 4 | `worktree_done` / retire-released-lane (`5a390f0`). | Rejected: V3 and V4. |
| 5 | Quit, update install, `teardown` / `killAll`. | Rejected: V2. |
| 6 | Renderer reload or crash. | Rejected: `render-process-gone` only logs (`index.ts:88-90`), ptys live in main, and the reattach path does not kill. |
| 7 | Periodic sweeps (`sweepAbandoned`, 10 min, `index.ts:241`; boot reap). | Rejected: gated on a lease + dev-server command shape + live port, and `NOT_A_SERVER_RE` excludes `claude --settings` (`dev-servers.ts:61`). The 13:04:05.7 time is not on the 10-minute grid from the 2026-09-29 19:41:27Z boot (offset ≈ 156 s). |
| 8 | Delivery brakes. | Not applicable: they block sends, they do not end ptys. |
| 9 | Sleep/wake, jetsam. | Rejected: V1. |

## Defects found on the way (independent of the cause)

- **A pty that exits by itself leaves its entry and lease behind** (`terminals.ts:369-375`). After this event `dev-leases.json` holds ~19 leases with a live `appPid`, so `port-alloc` can keep treating those ports as reserved and the boot sweep will spare them while this Operator runs. Not verified: whether `claimLease`/port allocation treats an exited terminal's lease as held.
- **Released lanes are not closed by the lifecycle.** t29 was released on 2026-10-02 and still ran on 2026-10-05. The released-lane path in `DashboardView.tsx:3777-3792` should close an idle one after the grace window. I did not find out why it did not (auto-close may be off in localStorage `operator.lane.keepWarmMinutes`, the lane may have been focused, or it had no tracked phase). Not verified.
- **No persistent record of why a lane ended.** `selfExit` is computed and then only used for the `lane-exit` trigger; exit code and signal reach the renderer (`onTerminalExit`) but are not logged anywhere durable. Main's `console.error` lines (`[reap]`, `[ports] user-confirmed kill ...`) go to stderr, which is lost when the app is launched from Finder.

## How to settle it

1. Ask the user whether they pressed Kill in Settings → Worktrees → Dev servers, or ran `pkill`/`killall` or quit another app, at about 08:04 local. If yes, cause 1 is confirmed and the fix is in `devServerKill` (below).
2. If no: the exits came from outside Operator. Look for a process with that behaviour: `log show --info --debug --start "2026-10-05 08:04:05" --end "2026-10-05 08:04:06"` filtered on `kill`, `pkill` or `killall` returned nothing, so the sender may not log. Catching a repeat would need process-signal tracing (for example `dtrace`), which I did not run.
3. Add persistence so the next occurrence is explainable (recommendation below).

## Recommendations (for Operator / Code, not done)

1. **Log exits durably.** In the `onExit` handler (`terminals.ts:369`, `index.ts:266-277`), append `{at, terminalId, exitCode, signal, selfExit}` to a file under `~/.operator`. In `devServerKill` and `sweepAbandoned`, append the pids and terminal ids signalled. This turns a repeat into a one-line diagnosis.
2. **Make `devServerKill` refuse a group that contains a lane CLI.** Before signalling a pgid, drop it if any process in that pgid is a `claude --settings` process or an `Operator --mcp-serve` of an open terminal. This is a guard on the one path that can kill lanes by group.
3. **Release the lease and drop the terminal entry on self-exit** (`terminals.ts:369-375`), and make `releaseWorktreeOnExit` the only place that decides about the worktree. Verify first that the renderer does not rely on the entry staying in `terminalList` after exit (the 5 s reconcile reads real exit state, `DashboardView.tsx:644-700`).
4. Keep `sessions.json` backups at lane-count changes: the newest backup is 2026-09-30, so the 13:04:06 state was overwritten at 08:09:41 and is only recoverable from transcripts.

## Not verified

- The sender of the exit signal (see above).
- Whether t60 was mid-turn at 13:04:05 or simply in a different process-group layout.
- The meaning of `exit 144` in the survivor's tasks.
- Why the lifecycle did not close the released lanes earlier.
