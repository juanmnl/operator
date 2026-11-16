# Why relaunching 0.27.1 did not bring the lanes back (2026-10-06)

Read-only investigation. Nothing under ~/.operator or the app support dir was modified; the
localStorage database was read from a copy. Times are local (-0500); UTC in the stores is +5h.

## Short answer

1. A resume path exists, but it is scoped to one project and it was destroyed 4 seconds after
   launch. The pre-crash snapshot held 33 lane keys across 7 projects. The relaunch restored a plan
   for the single focused project (uwazi_app, 5 lanes), carried only those 5 as "pending", and the
   persist effect wrote them over the 33 at 10:29:53. The other 28 keys are gone from the snapshot.
   Auto-resume is off (default), so nothing was spawned.
2. The quit ran teardown (all ptys of the old app are gone, no old leases remain). reapOnQuit is a
   dry run (AUTO_REAP_ON_TRIGGERS = false), so no worktree was removed. All lane worktrees exist.
3. The renderer died from an abort (EXC_BREAKPOINT) on a thread-pool worker. The report cannot show
   a V8 heap OOM. It does not rule out memory exhaustion either. Cause not established.

The lanes were recoverable the whole time: sessions.json keeps their claudeSessionId and the
transcripts are on disk. The ptys in main were also alive until the manual quit at ~10:29.

## Q1. Resume-on-relaunch today

### What exists

- Snapshot: `operator.workspace` in renderer localStorage, written on every state change by the
  persist effect (src/renderer/views/DashboardView.tsx:4866-4902, gated on restoreSettled).
  Shape and pure decision: src/renderer/lib/workspace.ts (`planRestore`, line ~125).
- Restore runs once per launch (DashboardView.tsx:4925-4990). It builds a plan, shows a toast
  ("Where you left off" / "You were in X. N agents ready to resume."), and opens the gallery
  overview with a "Continue" target (`launchLanding`, workspace.ts:~245).
- Auto-resume: setting `operator.resumeOnLaunch` (PrefsView.tsx:170-198), default off. Verified:
  the key is absent from the packaged app's localStorage, so it was off. Even when on, it calls
  `handleResumeProject(settled.projectId)` for ONE project (DashboardView.tsx:4984-4986).
- Manual: "Resume" on Project Home and the palette action, both per project
  (DashboardView.tsx:3449, 5207, 5735). `handleResumeProject` resumes every saved session of that
  project that is not live, oldest first, so it also restarts stale rows from earlier runs.
- No "resume everything" action exists.

### What it did this time (verified from the localStorage copy)

Store: ~/Library/Application Support/operator/Local Storage/leveldb (copy in the scratchpad).

| write time (local) | projectId | mode | liveKeys |
|---|---|---|---|
| 10:13:09 (last write before the crash) | uwazi-app-d9bb8dcc | session | 33 keys |
| 10:29:53 (4 s after relaunch) | null | gallery | 5 keys |

The 33 keys at 10:13 map to: vdlc 6, mantel 6, operator 5, uwazi 5, umbra 4, web27 4, fastrack 2,
1 key with no saved row. 19 of them were stamped appPid 1250 (really live); 14 were older rows with
no stamp (see side finding on liveKeys below).

The 5 keys at 10:29:53 are exactly the 5 uwazi_app lanes (qa, research, operator, code, design).

Mechanism:
1. `planRestore` filters lanes to `workspace.projectId` (workspace.ts:~140,
   `.filter((s) => !projectId || s.projectId === projectId)`). The focused project was uwazi_app.
2. DashboardView.tsx:4939 sets `pendingLaneKeysRef.current = plan.lanes.map(...)` from that filtered
   list.
3. With no terminals yet, the persist effect writes `liveKeys: pendingLaneKeysRef.current`
   (DashboardView.tsx:4896) and the gallery landing (projectId null, mode gallery).
4. The comment at 4887-4895 says the pending set must "stand until something real replaces it".
   That holds for the same project, but the pending set is already the filtered subset, so the
   other projects' lanes are dropped on the first relaunch, not the second.

Was there an offer? Probably yes for uwazi_app only: a transient toast, "You were in <lane>. 5
agents ready to resume", plus a Continue target on the overview. Not verified: toasts leave no
trace, so whether it appeared or was seen cannot be confirmed. There was no offer for the other 28.

Was anything else overwritten? sessions.json was not shrunk by the relaunch beyond the existing
prune (backups/sessions.json.2026-10-06T15-29-50-009Z holds the pre-prune copy, 55 rows; the prune
dropped 4 old rows: mantel t13, t18, mantel-73adc0 t31, operator t39). The 25 rows stamped
appPid 1250 are intact in the backup.

### sessions.json oddities you saw

- 3 "duplicate t0" rows for appPid 27729 (Operator-landing from 2026-08-12, fastrack and umbra from
  2026-10-05, plus the real t0) are one bug: `stampSessionClaims`
  (electron/src/main/worktree-reap.ts:~779) stamps every record whose `terminalId` equals one of the
  running app's live terminal ids. Terminal ids restart each run (t0, t1, ...), so old rows from
  earlier runs that happen to share an id get stamped with the current pid. The same happened to
  1250: mantel-sincopa t5, el-encanto t7 and t10, el-encanto-c83d00 t2, Operator-landing t0 are
  August rows stamped 1250. Only 19 of the 25 appPid-1250 rows were live lanes.
- Consequence: `claimIsLive` (worktree-reap.ts:~770) treats those old rows as live claims of a
  running app, which can keep stale worktrees from being classified as reapable. It also makes
  appPid useless as a "which lanes were running" signal until it keys on the durable `key`.
- Pid reuse: 27729 was also the app pid on 2026-08-12 (row a3541f15). A stamp holds only a pid, so
  a recycled pid can make a dead run look alive.

### Lanes that were live under the old app (recoverable now)

Rows stamped appPid 1250 in the pre-prune backup (25; the 5 rows whose transcript is NO are stale-stamped
August rows, the other 20 include the 19 live lanes). Transcripts checked under ~/.claude/projects.

| project | role | terminal | claudeSessionId | transcript on disk |
|---|---|---|---|---|
| mantel-sincopa | operator | t5 | a49af45a | NO |
| el-encanto-c83d00 | code | t2 | 02974ba6 | NO |
| el-encanto | qa | t7 | dc1c33e0 | NO |
| el-encanto | review | t10 | a7907365 | NO |
| mantel-f3c440 | code | t132 | cbde9c52 | yes |
| mantel-4c3280 | design | t126 | 250ce32f | yes |
| mantel | operator | t97 | 8603c2f8 | yes |
| mantel | qa | t118 | c778f90b | yes |
| mantel | research | t105 | ad194b0f | yes |
| mantel | review | t117 | 138edb50 | yes |
| mantel-landing | operator | t5 | 9cd78a9f | yes |
| operator | operator | t75 | 21dee8fc | yes |
| operator | research | t77 | 3a2d9367 | yes |
| Operator-landing | operator | t0 | 0ad9c50f | NO |
| uwazi_app-82c300 | code | t128 | 07baa478 | yes |
| uwazi_app-2e3e00 | design | t131 | 49158849 | yes |
| uwazi_app | operator | t76 | 6aec0309 | yes |
| uwazi_app | qa | t60 | f030dc50 | yes |
| uwazi_app | research | t86 | 3e644fc2 | yes |
| vdlc-967000 | code | t115 | 64e6497b | yes |
| vdlc-9adb40 | design | t106 | 4df73948 | yes |
| vdlc | operator | t78 | cd62410f | yes |
| vdlc | qa | t84 | aef95721 | yes |
| vdlc | research | t87 | eafae0c8 | yes |
| vdlc | review | t81 | 654ed945 | yes |

Recovery today: Project Home "Resume" per project works, but resumes every non-live saved row of
the project (old ones too). Per-lane resume from the sidebar's idle rows is the narrower option.

## Q2. Quit of the black-windowed app

- Path: `will-quit` holds the quit once and awaits `teardown()`
  (electron/src/main/index.ts:428-431, 158-198). Teardown runs `terminals.killAll()`
  (terminals.ts:703, reaps each lane's process tree), `releaseLeasesOf(pid)`, then `reapOnQuit()`.
  It runs in main and does not depend on the renderer, so the dead renderer did not block it.
- Evidence it ran (inferred, not logged: packaged-app stderr is not saved anywhere, so the
  `[reap] quit:` line is lost): no claude processes from the old app exist now (ps shows only
  pid 27729's tree), and dev-leases.json holds only 27729 leases. Both are what killAll and
  releaseLeasesOf produce. One caveat: a quit via the renderer-dependent QuitGuard was not needed
  because main's teardown is unconditional.
- reapOnQuit: `AUTO_REAP_ON_TRIGGERS = false` (worktree-reap.ts:58), so `reap({ dryRun: true })`,
  and `drainPending` only runs removals someone started. No worktree was removed on quit. Checked:
  every worktree path in worktree-pending.json exists, and ~/.operator/worktrees has 102 entries.
- At the relaunch, boot reconciliation queued 7 worktrees as "ended session with no open tab"
  (worktree-pending.json, requestedAt 10:29:50): web27-689fc0, umbra-1d3bc0, umbra-d10100,
  vdlc-9adb40, mantel-4c3280, uwazi_app-82c300, uwazi_app-2e3e00. They were not drained (boot only
  drains user-started removals) and all still exist. They are lanes you would want back; they stay
  queued and a future change to the drain predicate would delete them.
- The trash log shows repeated ENOTEMPTY on 5-10 trash directories at 10:29:46 and 10:29:49
  (worktree-trash.log). Unrelated to resume; noted only.

## Q3. What killed the renderer

Facts from the .ips (Operator Helper (Renderer)-2026-10-06-101717.ips, pid 1260):
- Exception EXC_BREAKPOINT / SIGTRAP, code 1, address 0x11587a764; terminated by the exception
  handler. App 0.27.1, macOS 27.0.1.
- procLaunch 2026-09-29 14:41:29, captured 10:17:15 on 10-06: 7.8 days of uptime.
- Faulting thread 3: ThreadPoolForegroundWorker (a Chromium thread-pool worker), not CrRendererMain.
  The symbol names in the frames (ares_dns_rr_get_ttl, v8::CodeEvent::GetScriptColumn,
  uv_handle_set_data) are nearest-export names in a stripped Electron Framework and mean nothing.
- vmSummary: App-Specific Tag 14 = 48.1G virtual (18,701 regions); Tag 16 = 1.4T virtual (11,941
  regions); Guard = 385G; total 1.8T virtual. Writable regions: 6.0G virtual, 4999K written,
  100% unallocated.

What that supports:
- Virtual size is address-space reservation. 1.4T and 385G are reservations (a guard-region
  reservation and a V8 sandbox-sized cage fit a number like that; assumption, not verified against
  this Electron build). They do not measure memory use. The "resident" figures in a crash report of
  a dead process are not the live footprint.
- So the report does NOT show a V8 heap OOM. A V8 OOM usually aborts on the isolate's main thread
  with a "FatalProcessOutOfMemory" path; here the trap is on a worker. A Chromium CHECK failure,
  PartitionAlloc allocation failure, or a crash in a thread-pool task would give the same
  EXC_BREAKPOINT. The raw instruction bytes (a brk) fit all of these.
- 18,701 regions in Tag 14 over 7.8 days points to heavy allocator fragmentation or long-lived
  mappings, which is consistent with memory pressure but is also what a busy renderer looks like.
  Not conclusive.

The "hourly ~1.1GB WebContent kill" in memory (project_chat_markdown_freeze) was measured on the
Tauri WKWebView build in August. The Electron renderer here lived 7.8 days, so that pattern did not
occur in 0.27.1; do not use it as the cause. The stall watchdog the code comments mention is not in
the Electron main process (render-process-gone only logs, index.ts:88).

To settle the cause: the code lane's `renderer-gone.log` should record `details.reason` (oom,
crashed, killed, launch-failed) and exit code. Electron reports `reason: 'oom'` for out-of-memory
kills, which is the direct answer this .ips cannot give. Also record
`process.getProcessMemoryInfo()` / `app.getAppMetrics()` per renderer every few minutes to a file
so a 7-day growth curve exists next time.

## Ranked fixes: a restart should bring lanes back with --resume

1. Stop the snapshot from shrinking (1 small change, fixes this loss). Keep the full previous
   lane set. In the restore effect set `pendingLaneKeysRef` from `workspace.liveKeys` unfiltered
   (only drop keys with no saved row), and apply the per-project filter only where the offer is
   built. Better: write `liveKeys` only when the terminal list has at least one lane, and keep
   a second field `previousRunKeys` that is replaced only when the new run has lanes. Add a test
   in workspace.test for "plan for project A does not change the carried keys of project B".
2. Make the offer global and persistent. Replace the toast-only offer with a card on the gallery
   overview: "Resume N lanes from your last session (M projects)", with a per-project breakdown
   and one button that runs the existing `handleRestoreSession` over all of them, oldest first,
   in the background. Per-project Resume stays. This removes the dependence on which project
   happened to be focused.
3. Reload instead of relaunch for a renderer crash (already dispatched to Code: auto-reload with
   a crash-loop guard). The ptys live in main, and the reattach path
   (DashboardView.tsx:2730-2775, `joinReattach`) restores every live lane with scrollback. For
   this incident that alone would have kept all 19 lanes, with no --resume needed. This is the
   highest-value change; rank 1-2 cover the cases where the app itself is quit.
4. Compute "lanes that were running" in main, not in renderer localStorage. At teardown (and
   on render-process-gone) main writes `~/.operator/last-run.json` with the durable keys of its
   live ptys, app start time and a `clean: true/false` flag. The next boot offers exactly that
   list. A renderer that died black can no longer corrupt it, and it does not rely on the
   renderer's persist effect having run.
5. Fix the appPid stamp. `stampSessionClaims` should match on the durable `key`, not `terminalId`,
   and store `appStartedAt` with the pid so a recycled pid is detected. Until then appPid cannot
   be used as the source for item 4, and stale rows keep looking like live claims.
6. Auto-resume after an abnormal end. Keep the setting default off, but if the previous run did
   not end through teardown (`clean` false in last-run.json, or a renderer-gone record), resume
   the previous run's lanes automatically, in the background, with a toast listing them. A
   deliberate quit keeps the current offer-only behaviour.
7. Boot-queued worktree removals ("ended session with no open tab") should skip lanes that are
   in the previous-run set, so a resume offer never points at a deleted folder if the drain
   predicate changes later.
8. Diagnostics: persist `render-process-gone` details and periodic renderer memory to a file (see
   Q3). Needed to know whether rank 3 is hiding a leak.

## Verified vs assumed

Verified by reading: workspace.ts, DashboardView.tsx restore/persist/prune/reattach code,
index.ts teardown, worktree-reap.ts reapOnQuit/reconcileAtBoot/stampSessionClaims, sessions.json
and its backup, worktree-pending.json, ps output, the .ips JSON, the localStorage copy
(leveldb strings parsed with a script).

Assumed or inferred: that the toast appeared for uwazi_app; that teardown ran (inferred from no
surviving old processes and leases, not from a log); the meaning of the 1.4T and 385G regions;
that the 14 unstamped liveKeys are ended tabs still in the terminal list (the mechanism that put
them in `terminals` was not traced). Not checked: the GUI.
