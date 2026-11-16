# Lanes not signalling back to the coordinator — research, 2026-10-02

Research lane, no code changed. Read-only on `~/.operator/artifacts.db`, `projects.json`, `sessions.json`,
Claude Code transcripts, `pmset -g log`, and source at main (7d42949) vs `electron-v0.26.0`.
Times are UTC unless marked.

## Answer in four lines

1. Both lanes did report, and both reports were stored at once. Neither case is a lane that stayed silent.
2. The loss is on the announce side in the renderer. A report is typed into the coordinator only when an
   effect in `DashboardView.tsx` happens to run while that coordinator is idle, and it serves one coordinator
   per run. Nothing re-runs it when a report lands or on a timer.
3. Design's report #1789 was never announced. It was marked delivered at 12:33:18 by the 12-hour expiry, which
   does not type anything. Review's #1788 was announced 8h15m late.
4. Delivery got much worse after 0.27.0 for the projects whose coordinator tab sits later in the tab order.
   The announce code is byte-identical since 0.25.0, so the change is in the inputs (more coordinators open
   ahead of them, and a Mac that sleeps), not in a diff.

## Case (a): Design, task c49d96ee, dispatch bus-664

Verified in `~/.operator/artifacts.db`, table `reports`:

| id | at | terminal | role | to_role | delivered_at |
|---|---|---|---|---|---|
| 1789 | 2026-10-02T00:32:25.212Z | t29 | design | operator | 2026-10-02T12:33:18.161Z |

- Design's transcript (`~/.claude/projects/-Users-juanmnl--operator-worktrees-operator-5e2b40/70d0beb2-….jsonl`)
  shows `worktree_done` at 00:32:03 (record 645), then `mcp__operator__report` at 00:32:24.868 (record 660) and
  the tool result `Saved as report #1789 in Operator's store` at 00:32:25.218 (record 661). The task was marked
  done at 00:32:40. So the call happened, 15 s before done.
- The coordinator transcript (`~/.claude/projects/-Users-juanmnl-Developer-operator/5b7edf48-….jsonl`, operator
  t2) contains no `report #1789` line at any time. `delivered_at` 12:33:18 is exactly 12 h + 53 s after the
  report, which is the `REPORT_ANNOUNCE_MAX_AGE_MS` cutoff (`src/renderer/lib/comms.ts:209`). The write came
  from `expireUndelivered` (`electron/src/main/chat-store.ts:471`), which stamps `delivered_at` without typing.
  The coordinator then learned of the audit only because it read the file itself at 02:08 (record 235:
  "Both audits are finished").
- So "no report from design was ever announced" is correct, and the report is in the store and Comms log.

## Case (b): Review, task 5d9ba2a6, dispatch bus-665

| id | at | terminal | role | delivered_at |
|---|---|---|---|---|
| 1788 | 2026-10-02T00:32:07.812Z | t28 | review | 2026-10-02T08:47:20.184Z |

- Stored at 00:32:07, 26 s before the task was marked done (00:32:33). Not a late write.
- The announcement reached the coordinator at 08:47:19.326 (record 239 of its transcript), matching
  `delivered_at`. The coordinator had been idle since its turn ended at 02:08:44, with `canAnnounceTo` true
  for the 6 h 38 m in between.
- 08:47:19 is also the exact second of a macOS DarkWake (`pmset -g log`: `DarkWake from Deep` at 03:47:19
  local = 08:47:19Z).

## What the delivery timestamps line up with

Every late delivery on 2026-10-02 sits on a DarkWake edge, to the second:

| delivered_at | report | pmset event |
|---|---|---|
| 08:47:20 | #1788 operator | DarkWake 08:47:19 |
| 11:42:33 | #1790 umbra | DarkWake 11:42:32 |
| 12:33:18 | #1789 operator (expiry) | DarkWake 12:33:18 |

The Mac slept from 06:04Z (about 17 short dark wakes before 13:47Z). While it sleeps, the main-process tailer
tick (`electron/src/main/transcript.ts:742`, a 1 s `setInterval`) does not run, so no `session:update` reaches the
renderer. The first tick after a wake emits, the announce effect runs, and it announces or expires.

That explains the sleep window (06:04Z onward). It does not explain 00:32Z–06:04Z, when the Mac was awake and
coordinator t2 was idle from 00:50 to 02:08 and from 02:08:44 on, with session updates arriving constantly from
other lanes. Something else kept t2 from being served during that period (next section).

## The path, with file:line

1. `electron/src/main/mcp-serve.ts:264-283`: `report` handler resolves the caller, sets `to_role = 'operator'`
   for non-coordinator lanes, calls `store.insertReport`. The text promises only "queued … will be marked
   delivered when it is shown". Verified working for both reports (project, role, to_role all correct).
2. `electron/src/main/chat-store.ts:448-462` `undeliveredFor(role, limit, projectId)`: the queue. Returns `[]`
   when `projectId` is falsy (added by X3, after v0.26.0).
3. `src/renderer/views/DashboardView.tsx:4356-4425`, the announce effect, deps `[terminals, sessions]`
   (line 4425). For each tab in `terminals` order:
   - skip unless role is a coordinator (4360) and `canAnnounceTo(session)` (4362: not `ended`, phase `idle` or `waiting`);
   - skip if `announcingRef.current` (4363, one flag for the whole app);
   - set `announcingRef`, run expiry then `artifactUndelivered(role, 3, tab.projectId)`, type up to 3 lines
     through `submitQueue`, `artifactMarkDelivered` after each;
   - `break` at 4423 after the first coordinator that passed the gates. Later coordinators are not looked at.
4. `src/renderer/lib/comms.ts:251` `canAnnounceTo`, `:209` 12 h cutoff, `:212` `announceCutoff`.
5. `session:update` is pushed only when a tracker is dirty or a phase changes (`transcript.ts:790-797`); the
   renderer sets `sessions` from it (`DashboardView.tsx:596`). The effect has no dependency on `reports` and no
   timer. `refreshReports` (4 s poll) only feeds the board and Comms log.

Defects in that path, CONFIRMED by reading it:

- D1. One coordinator per effect run (`break`, plus one global `announcingRef`). With several idle
  coordinators, only the first one in `terminals` order whose gates pass is served per run.
- D2. Edge-triggered. A report that lands while its coordinator is already idle waits for the next
  `sessions` or `terminals` change. It does not re-run on the report, and there is no retry timer.
- D3. Expiry runs inside a served pass and drops reports silently after 12 h. A coordinator that is starved
  (D1) or asleep (D2) loses its reports to expiry; the only notice is one toast in a renderer nobody is
  looking at (this is what happened to #1789).
- D4. The report tool tells the lane "queued for the coordinator's Inbox", but the Inbox no longer exists
  (cut 2026-08-29, see comment at chat-store.ts:419) — wording is stale, harmless to this bug.

## Regression diff, v0.26.0 → main

- The announce effect block (`const announcingRef` … `[terminals, sessions])`) hashes identically at
  v0.25.0, v0.26.0 and main (md5 dfd3920b…). `canAnnounceTo`, `announceCutoff` and the 12 h constant are
  unchanged. `submit-queue.ts` gained only an `onSubmit` hook for retire-watch.
- Changed on the path:
  - `chat-store.ts`: `undeliveredFor`/`expireUndelivered` now return/expire nothing for a tab with no project
    and accept every coordinator id as addressee (X3, commit 7a805f4). Correct, but it removes the old
    unscoped fallback, under which the first idle coordinator announced every project's reports. That
    fallback was the cross-project mixing bug, and it also hid D1.
  - `mcp-serve.ts`: `callerFromSessions` identity fallback and `to_role`. Not involved here; both rows stamped correctly.
  - `ipc.ts`: logging for the no-project case.
- Not involved: `<slug>--<role>` bus names (reports are a store write plus a pty-typed line, not session-bus
  traffic), retire-released-lane (5a390f0; it acts only on dispatch to a role whose lane called
  `worktree_done`, and design's report was filed 22 s after `worktree_done` and landed correctly), delivery
  brakes (they gate dispatch/reply sends; `announcement` lines are written with `submitQueue.submit` directly).

## Measurement

Reports from non-coordinator lanes, by delivery latency (`delivered_at − at`), store as of 2026-10-02 14:00Z.
`pre` is 2026-09-14 to 09-26 17:35Z (0.27.0 tag), `post` is after.

| | reports | ≤5 min | 5 min–12 h | expired (≥12 h) | undelivered |
|---|---|---|---|---|---|
| pre-0.27.0 | 713 | 399 (56%) | 242 | 72 (10%) | 0 |
| post-0.27.0 | 228 | 28 (12%) | 118 | 41 (18%) | 41 (18%) |

By project, post-0.27.0, ordered by the coordinator's position in the workspace tab list
(`localStorage operator.workspace.liveKeys`: t0 fastrack, t1 umbra, t2 operator, t3 uwazi, t4 mantel, t22 web27):

| coordinator tab | project | reports | ≤5 min | undelivered | expired | pre-0.27.0 ≤5 min |
|---|---|---|---|---|---|---|
| t0 | fastrack | 18 | 1 | 0 | 5 | none (project is new) |
| t1 | umbra | 54 | 5 | 0 | 33 | 6 reports only (new) |
| t2 | operator | 11 | 9 | 0 | 1 | 20 of 71 |
| t3 | uwazi | 61 | 3 | 11 | 2 | 43 of 113 |
| t4 | mantel | 71 | 10 | 21 | 0 | 326 of 502 (65%) |
| t22 | web27 | 13 | 0 | 9 | 0 | 10 of 17 |

Projects at the end of the list, which were served fast before, now mostly wait or never get served: mantel
65% → 14% fast, web27 59% → 0%. The two projects added to the front of the list since then (fastrack, umbra)
dominate the served passes. This fits D1 (single slot), but I did not observe which tab held the slot at a
given moment; see "Not verified".

Tasks marked `done` in `projects.json` with no report from the same lane in the window (crude: same
project, role and terminal, start to done + 30 min, or `task_id` match): 30 of 352 since 2026-09-20 (8.5%),
12/149 before 09-26 and 18/203 after. No increase, so lanes are not calling `report` less. The lost signal is
delivery, not authoring. (Several of the 30 are a lane closed by retire before it reported, not a skipped report.)

## Root cause

CONFIRMED: reports are stored immediately and correctly; delivery to the coordinator is the failing step, via
D1 + D2 + D3 above. For #1789 specifically, CONFIRMED that it was expired, not announced (timestamp = cutoff,
absent from the coordinator transcript).

CONFIRMED: the late announcements of 08:47, 11:42 and 12:33 are caused by the renderer being re-triggered only
by a Mac wake (DarkWake times equal `delivered_at` to the second).

PLAUSIBLE (strongly, from the per-position table): D1 is why coordinators later in the tab list lose out
while awake, and why t2 was not served at 02:08–06:04Z. The regression after 0.27.0 is then "two new
coordinators were opened ahead of the older ones", not a code change.

## Not verified

- Which coordinator held the single slot at 02:08:44Z. Counter-point: transcript state shows t0 (fastrack)
  idle since 22:51Z the day before, yet umbra/operator were served ahead of it. Either the renderer sees t0 as
  running (pty activity keeps the phase `running`, `transcript.ts:775`) or `sessions.find` for a reused
  `terminalId` (t0, t2 also exist as old rows in `sessions.json` from earlier runs) returns another session
  than the live one. The `terminals`/`sessions` arrays live only in the running renderer; I did not attach to it.
- Whether `sessions.find((s) => s.terminalId === tab.id)` (4362) can pick a stale ended row for a reused
  terminal id. `sessions.json` does contain such rows for t0 and t2, but the renderer's list comes from live
  trackers, not that file.
- The packaged app's stderr (`[reports] a '…' tab with no project …`) is not persisted, so I cannot say whether
  the X3 no-project branch fires.

A 10-minute check that settles it: in the running app's DevTools, log `terminals.map(t => [t.id, t.roleId,
t.projectId])` and the phase `canAnnounceTo` sees for each coordinator at the moment the announce effect
runs.

## Proposed fix

1. Serve every eligible coordinator on each run: remove the `break` at `DashboardView.tsx:4423` and replace
   the single `announcingRef` with a per-tab in-flight set, so one coordinator's slow `submit` (up to 30 s per
   line) does not hold the others. Extract the choice into a pure function
   `coordinatorsToAnnounce(terminals, sessions, inFlight)` in `lib/comms.ts` and unit-test it with three idle
   coordinators.
2. Re-run on report arrival and on a timer: add `reports` (already polled every 4 s) to the effect deps, or add
   a 5 s tick state, so a report landing while the coordinator is idle is announced within seconds, and the
   first tick after a wake does the catch-up.
3. Do not drop on a missed window: either raise the cutoff to days, or keep the expiry but have it type one
   summary line to the coordinator ("N reports from <lanes> were filed while you were away: ids …, full text
   in the Comms log") instead of marking them delivered unseen. The 12 h rule exists for the 9-day backlog
   (operator #623); a single summary line preserves that goal.
4. Log each announce pass (tab, project, pending count, outcome) to `~/.operator/logs/` so the next
   occurrence can be diagnosed without attaching to the renderer.
5. Update the `report` tool result text (`mcp-serve.ts:281`) to say what actually happens: announced to the
   coordinator when it is between turns.
6. Optional hardening: match the session for a tab by `terminalId` and `claudeSessionId` rather than
   `terminalId` alone at line 4362, if the stale-row case above is confirmed.

Items 1 and 2 are the fix; 3 and 4 limit the damage of any miss. Suggested owner: Code lane, with a Review
pass because the same effect gates every coordinator in every project.

## Workaround until fixed

Reports are intact. List unseen ones with
`sqlite3 -readonly ~/.operator/artifacts.db "select id,project_id,role_id,at,substr(summary,1,100) from reports where delivered_at is null order by id"`
(41 right now: mantel 21, uwazi 11, web27 9). Coordinators for those projects can also read
`dev/results/` in the lane worktrees, as noted in the 2026-08-24 comms audit.
