# Lane instances and message mixing — 2026-09-25

Research lane, read-only. Code read at `main` = `65ffdd2` (0.26.0). Nothing was changed, nothing was run.
"Verified" means I read the code path end to end. "Inferred" means the reasoning is sound but I did not
run it. Line numbers are against that commit.

> **Update 2026-09-25 (after the correction that the mixing is across projects: mantel received uwazi's Design
> messages).** Part 1 above is written for two sessions of one role inside one project. The cross-project
> analysis is Part 1B at the end of this file. Short answer: I found no stored evidence of a cross-project
> misroute after 0.19.0, and I cannot reproduce the mantel/uwazi case from the stores. I list the mechanisms
> that could produce it, ranked, and what to capture when it next happens.

## Summary

1. The transport is already instance-safe. The session bus addresses by Claude session uuid
   (`session-bus.ts` header), and MCP calls carry `OPERATOR_TERMINAL_ID/PROJECT_ID/ROLE_ID` from the
   spawn environment (`terminals.ts:278-291`, `mcp-serve.ts:65`). The ambiguity is entirely in
   Operator's step "role id -> which terminal", which is done by `find`/`pickLaneTab` on `(projectId, roleId)`.
2. The 24-send budget lead from 2026-09-14 is already fixed in code: `laneKey(projectId, roleId)`
   (`agent-delivery.ts:123`) is used at every call site. It is still keyed by ROLE inside a project, so it
   is the same defect one level down as soon as a role has two sessions.
3. Today, with one session per role, I found no path where a message meant for session A reaches session B
   inside a run. Cross-session mixing today comes from stale identifiers: per-run terminal ids, a
   first-match fallback in `mcp-serve`, and duplicate rows in `sessions.json`.
4. Making a lane a profile needs an instance identity. One already exists and is durable: the
   `claudeSessionId` uuid, and `SavedSession.key` (uuid) as its persisted twin. Nothing addresses by them
   except the bus and the task stamp. The change is mostly replacing role-keyed lookups with instance-keyed
   ones, not new storage.
5. Recommended shape: `Role` stays as the profile. An instance is `{ key, claudeSessionId, roleId, n }` with a
   human label `code`, `code 2`. Dispatch to a role picks an instance by rule (explicit > idle > launch new).
   Details, migration and a build order are in parts 2 and 3.

## Part 1 — every place a message is addressed or keyed by role

### 1.1 How each message travels (verified)

| Path | Sender identity | Addressee identity | Where |
|---|---|---|---|
| MCP `dispatch` / `reply` | env terminal id + project id + role id, written to `dispatch_requests` | `lane` = role id or name string | `mcp-serve.ts:255-272`, `chat-store.ts:300,520` |
| Renderer answers the request | `tabs.find(t => t.id === terminalId)`, role from the tab | `routeDispatch(lane, roster, tabs, projectId)` -> `pickLaneTab(tabs, project, role)` | `DashboardView.tsx:1664,1680`, `dispatch.ts:49-58,89-109`, `dispatch-bus.ts:99` |
| Lane sends | none: the lane calls `SendMessage(to=uds:<socket>)` | bus address from the session uuid | `dispatch-bus.ts:192`, `session-bus.ts` |
| Sentinel `OPERATOR-DISPATCH [role]` | terminal id from the tailer | role token, same router | `transcript.ts:565`, `DashboardView.tsx:1937-1994` |
| Sentinel `OPERATOR-REPLY [role]` | terminal id from the tailer | `roster.find(r => r.id === to)` then `tabs.find(role && project && !ended)` (first match) | `DashboardView.tsx:1519-1546` |
| `report` | env terminal + project + role, stored in `reports` | none (`to_role` is never written) | `mcp-serve.ts:227-243`, `chat-store.ts:381` |
| Report announcement | coordinator tab chosen by role id `operator` | coordinator of the report's project | `DashboardView.tsx:3932-4006`, `chat-store.ts:443` |
| Human Send / Start all | none | `terminals.find(project && role)` (first match), else launch | `DashboardView.tsx:2890,2920,2979` |
| Approve / retry / assign a held dispatch | `find(role === rec.fromRoleId)` | `find(role === rec.toRoleId)` | `DashboardView.tsx:2008,2062,2068,2087` |

Note the router has two different resolvers for the same question: `pickLaneTab` (most recently active,
`dispatch.ts:49`) and a bare `terminals.find` (first in array order) at `DashboardView.tsx:1546,2008,2062,2068,2087,2890,2920,2979`.
They only agree while each role has one live session.

### 1.2 Keys by bare role, with scenarios

Scenarios marked **(today)** can happen with one session per role. Scenarios marked **(2+ instances)** only
appear once a role can have two live sessions.

**K1. Brake budget, pair chain and exhaustion, keyed `project/role`.** `agent-delivery.ts:123,111,194,211`;
callers `dispatch-bus.ts:174-175`, `DashboardView.tsx:1549-1550,1714,2889,2928,5401`.
- (2+ instances) Code#1 and Code#2 in the same project share `laneSends["p/code"]`. Code#1 sends 24 messages;
  Code#2, which sent none, is refused ("has sent 24 ... with no human in the loop").
- (2+ instances) The user types into Code#2 (`onHumanSubmit`, `DashboardView.tsx:5401`). That resets
  `p/code` for both, so Code#1's runaway loop is released without any human input to Code#1.
- (2+ instances) `chainHop["p/operator>p/code"]` is inherited by whichever `p/code` replies back
  (`agent-delivery.ts:194`). A hop-depth built with Code#1 counts against a fresh thread with Code#2.
- (today) Fixed since 09-14: coordinators of different projects no longer share a budget. Still unfixed
  from that audit: B2 is partly fixed (`onHumanSubmit` exists now), B5/B6/B7/B8 not re-checked here.

**K2. `pickLaneTab`: most recently active live tab wins.** `dispatch.ts:49-58`, used by `routeDispatch`
(`dispatch.ts:107`) and by the launch reuse guard (`DashboardView.tsx:2742`).
- (2+ instances) The coordinator dispatches "fix the login bug" to `code` while Code#1 is mid-turn and Code#2
  is idle. `lastActivityAt` favours the busy one, so the task lands in the busy session's queue, and a second
  dispatch a minute later goes to the same session. Nothing lets the coordinator say "the other one".
- (2+ instances) The launch guard (`DashboardView.tsx:2743-2747`) returns the existing lane and types the
  prompt into it instead of spawning. A "Launch Code" click, or a dispatch that should start a second
  instance, joins the first one's composer. This is the guard that makes a second instance impossible today,
  and it is intentional (it was added because duplicates were unreachable).

**K3. Sentinel reply resolves `to` by role and delivers to the FIRST live tab.** `DashboardView.tsx:1519-1521,1546`.
- (2+ instances) Code#2 asks the coordinator something and the coordinator answers `OPERATOR-REPLY [code]`.
  The reply goes to whichever `code` tab sits first in `terminals`, which can be Code#1. The reply carries no
  correlation id, so Code#2 never sees its answer and Code#1 acts on a message about someone else's work.
- (2+ instances) The reply's record is deduped by `replyId = hash(sessionId|to|text)` (`transcript.ts:569`,
  `directives.ts:102`). Two instances answering the same short text ("done") are distinct because the
  sender session differs, but the addressee is not part of the id, so one sender answering two instances the
  same text is delivered once. Inferred, not run.

**K4. Human send and start-all use `terminals.find(project && role)`.** `DashboardView.tsx:2890,2920,2979`.
- (2+ instances) Send -> on a task assigned to `code` types it into the first `code` tab, and
  `markTasksRunning` stamps that tab's `claudeSessionId` on the task (`DashboardView.tsx:2923`). The user
  cannot choose the instance on the card.
- `startProjectTasks` groups tasks by role (`DashboardView.tsx:2958-2961`), so N queued tasks for `code` are
  sent as one combined message to one instance.

**K5. Approve, retry-undelivered and assign resolve tabs by the record's role.** `DashboardView.tsx:2008,2062,2068,2087`;
`DispatchRecord` only stores `fromRoleId`/`toRoleId` (`types.ts:610-664`).
- (2+ instances) Retry of an `undelivered` dispatch calls `submitQueue.clearComposer(targetTab.id, ...)` on
  the first tab with that role (`DashboardView.tsx:2068-2069`). If the original went to Code#2 and Code#1 is
  first in the array, it deletes the pasted lines from Code#1's composer (bounded to the text Operator pasted,
  but it is still the wrong session) and re-delivers into Code#1.
- (2+ instances) The record cannot say which instance the original went to, so "re-route against current
  lanes" (comment at `DashboardView.tsx:2006`) has no memory to route by.

**K6. Task ownership by role.** `ProjectTask.roleId`, `claudeSessionId` optional (`types.ts:196-222`).
- Queued tasks are picked up by the first launch of the role: `queued.filter(t => t.roleId === role.id)`
  (`DashboardView.tsx:2759`). (2+ instances) Code#2's launch would take the whole backlog that was meant for
  Code#1, or the reverse, because a queued task has no instance to belong to.
- Completion: `completeTerminalTasks` matches by `claudeSessionId` first, and by role only for tasks with no
  session stamp (`DashboardView.tsx:1370-1375`). That guard is right. But the two callers that decide WHEN to
  complete match by role alone: `hasRunning` (`DashboardView.tsx:3875`) and `openWork` (`DashboardView.tsx:3348`).
  (2+ instances) Code#1 finishing a turn triggers `completeTerminalTasks` because Code#2 holds a running task
  for the role; the actual close is still guarded, but the diff capture and the project check command run
  for nothing (its own comment at `DashboardView.tsx:3873` says that must not happen), and Code#1's
  idle-close logic is held open by Code#2's work.
- (today) Tasks stamped before `claudeSessionId` existed fall back to `terminalId + role`
  (`task-lifecycle.ts:84`). Terminal ids restart at `t0` every run, so this adopts a wrong lane at most once
  per old task (documented in that file).

**K7. Report attribution and announcement.** `reports.role_id`, `to_role` always NULL (`chat-store.ts:381,443`);
`announcement()` says `from ${roleId}` (`comms.ts:217`); the Comms log shows `from: r.roleId || r.terminalId` (`comms.ts:135`).
- (2+ instances) "report #900 from code" cannot be told apart from Code#1 or Code#2. The task card carries
  the taskId, but reports without a taskId (most of them) are anonymous within the role.
- (2+ instances, only if the coordinator also becomes multi-instance) `undeliveredFor(role, project)` is not
  claimed by an instance: whichever coordinator is idle first announces the report and marks it delivered
  (`DashboardView.tsx:3934-3999`); the other never hears it. There is also a single app-wide `announcingRef`
  (`DashboardView.tsx:3932`), so a stuck submit in one coordinator blocks all (from the 09-14 audit, R4).

**K8. `resolveCaller` fallback in the MCP server.** `mcp-serve.ts:68-86`.
- (today) A lane spawned by an older build has no `OPERATOR_PROJECT_ID`/`OPERATOR_ROLE_ID`, so the server reads
  `sessions.json` and takes the FIRST row with that `terminalId`. Terminal ids repeat across runs and
  projects (its own comment: `t2` four times). That stamps the wrong project and role on a report or dispatch.
  Only lanes older than that build can hit it. Also the live `sessions.json` I read has 41 rows, with
  `(project, role)` pairs appearing twice for `qa`, `review`, `research`, `operator` (stale or suspended rows).
- Neither env nor `dispatch_requests` carry the Claude session uuid. `terminal_id` is enough inside one run
  but not across runs (rows older than 30 s are expired, `chat-store.ts:551`, so the exposure is small).

**K9. Restore/resume by role.** `DashboardView.tsx:2774-2776` takes the most recently active suspended
session for `(project, role)` and resumes it.
- (2+ instances) Launching a NEW Code instance while Code#1 is suspended resumes Code#1's conversation in the
  new session. Two live tabs then share one Claude session uuid and one bus address; `preferSession`
  (`session-bus.ts`) keeps only the newest descriptor, so messages for one of them are silently unreachable.

**K10. UI maps keyed by role, where a second instance disappears.**
`live[t.roleId] = t.id` (`DashboardView.tsx:5187`) then `laneRuntime[roleId]` (`5200`);
`byRole` for the numbered shortcuts (`DashboardView.tsx:3655`); `liveByRole` (`ProjectGallery.tsx:415`);
AgentsHub key `${projectId}:${roleId}` (`AgentsHubView.tsx:39`); ProjectRail row and drag id `roleId`
(`ProjectRail.tsx:404-450,979,1141`); TaskBoard chips (30 `roleId` uses); RosterPanel live dots
(`RosterPanel.tsx:79`). Second instance overwrites the first in each map: the board shows one lane's phase,
the sidebar row is duplicated with the same drag/`data-lane-row` id, and shortcuts skip it. This is display
only, no message goes astray, but it hides which instance holds work.

**K11. Launch in-flight guard `project:role`** (`DashboardView.tsx:2733,1889,1803`). (2+ instances) A second
launch of the same role while one is spawning joins the first instead of creating another.

### 1.3 Not keyed by role (checked, no mixing)

- Worktree path and branch: `operator/<random shortId>` and `<project>-<shortId>` (`worktree.ts:290-293`),
  so two launches never collide. `laneId` in provenance is the role id (`worktree.ts:298`), a label only.
- Dev port: reserved per cwd (`portsByCwd`, `terminals.ts:111`, `port-alloc.ts:70-90`). Worktree lanes get a
  port each. Two lanes on the same cwd deliberately share one.
- CDP port: one per pty, unshared (`terminals.ts:628-640`).
- Delivery confirmation: `takeSend` is keyed by sender terminal + address (`dispatch-bus.ts:302-329`).
- Saved sessions: `SavedSession.key` is a uuid per session (`DashboardView.tsx:2405,2683`).
- Report/task_status rows carry `terminal_id` and `project_id`; task ids are uuids.

## Part 2 — what assumes one live session per role per project

| Area | Assumption | Location | Change needed for instances |
|---|---|---|---|
| Launch guard | one live tab per `(project, role)` | `DashboardView.tsx:2742-2748` | make reuse conditional: reuse only when the caller asked for "the" lane; allow spawn when `newInstance` is set |
| Resolver | `pickLaneTab` returns one tab | `dispatch.ts:49` | return candidates; add `pickInstance(role, target, tasks)` |
| Sidebar/board/roster | maps keyed by role | K10 | key by instance (`claudeSessionId` or tab id); group under the role |
| Sessions store | rows carry `roleId` only; unique key is `key` (uuid) | `types.ts:704-737`, `sessions.json` | add `instance` (small int) and `label`; nothing else |
| `projects.json` | `Role` is already a profile: model, effort, permissionMode, agentName, useWorktree, prompt, remoteControl (`types.ts:155-185`) | | add `instances?: {max, worktree: 'always' \| 'extra' \| 'inherit'}` |
| Tasks | `roleId` only; running tasks stamped with `claudeSessionId` | `types.ts:196-222` | add optional `instanceKey` for queued tasks ("pin this task to Code#2"); running tasks already have the session |
| DispatchRecord | `fromRoleId`/`toRoleId` | `types.ts:610-664` | add `fromKey`/`toKey` (session key), keep the role ids for display |
| Brakes | `laneKey = project/role` | `agent-delivery.ts:123` | key by instance: `project/role#n` or the session key; reset per instance |
| MCP env | terminal, project, role | `terminals.ts:278-291` | add `OPERATOR_SESSION_ID` (claude uuid) and `OPERATOR_INSTANCE` |
| `dispatch_requests`, `reports`, `task_status` | `terminal_id`, `role_id` | `chat-store.ts:252-305` | add `session_id`, `to_key` columns (nullable, additive, same `ALTER` pattern as `migrateReports`, `chat-store.ts:375`) |
| Worktree policy | `useWorktree` per role | `lane-workspace.ts:26`; `Role.useWorktree` | an instance beyond the first must get its own worktree even if the profile says no, otherwise two agents edit one checkout |
| Ports | per-cwd dev port; per-pty CDP port | K-section 1.3 | no change with worktrees; without worktrees two instances share a dev port and, for Electron projects, two apps start in one cwd (single-instance lock and userData clash). Inferred. |
| Reattach | joins on `claudeSessionId` | `session-reattach.ts:63-90` | already instance-safe |
| Suspended resume | most recent by `(project, role)` | `DashboardView.tsx:2774` | resume by `key`, never by role, when spawning a new instance |
| Reports announce | one coordinator, `announcingRef` global | `DashboardView.tsx:3932` | keep coordinator single-instance (recommended); per-instance announcing flag |
| Bus | sessions by uuid | `session-bus.ts` | no change |

## Part 3 — proposal

### 3.1 Identity

- **Profile** = today's `Role` (id, name, model, effort, permission, prompt, worktree policy). Unchanged. It
  is what the roster edits.
- **Instance** = one Claude session launched from a profile. Identity is `claudeSessionId` (uuid, assigned
  at spawn with `--session-id`, `buildArgs` in `launch-args.ts:31-32`). Its persisted twin is
  `SavedSession.key`. Do not invent a third id.
- **Display label** = `<role name>` for the first instance, `<role name> 2`, `3` after that. Store the number
  (`instance: number`) on the saved session so it survives restarts, and never renumber a live one. The label
  is only for humans and for `reply`/`dispatch` addressing (`code`, `code#2`).
- **Terminal id stays a per-run handle** and is never a key across runs.

### 3.2 Addressing and choosing an instance

`dispatch` and `reply` keep `lane` and gain an optional `instance`. The lane string may be `code` or `code#2`
(parsed in one place). Resolution order in `resolveDispatch` (`dispatch-bus.ts:89`):

1. **Explicit**: `code#2` or a session key, live -> that instance. If it is not live: refuse (do not fall
   back to another instance; a message meant for #2 must not land in #1).
2. **Bare `code`, one live instance**: that one (today's behaviour, no change for single-instance projects).
3. **Bare `code`, several live**: prefer an idle one (phase `idle`, no running task), most recently active
   among idle ones. If none is idle: launch a new instance when the profile allows (`instances.max` not
   reached, default 1 so nothing changes until opted in), otherwise queue on the least-loaded one (fewest
   running tasks) and say so in the verdict `reason`.
4. **Launch new**: `verdict.outcome = 'launching'` as today, with the new instance number in `reason` and
   the resulting label returned so the caller can address it as `code#2` next time. A new instance never
   resumes another instance's suspended session (fixes K9).

`reply` is stricter: it never launches, and a bare-role reply with several live instances is refused with the
list of live labels. Reason: a reply is an answer to a specific session, and guessing is exactly K3.
The reply text prefix already names the sender (`deliveryPrefix`, `agent-delivery.ts:172`); add the
instance label there so the recipient can answer to `#2`.

The verdict already returns `target: { roleId, terminalId }` (`dispatch-bus.ts:46`). Add `sessionKey` and
`label`, and record them on the `DispatchRecord` and on the running task (`instanceKey`), so Approve/Retry
(K5) act on the recorded instance, not on "whichever has the role".

Human actions on a card: Send -> gets an "on" selector defaulting to the instance recorded on the task, else
the idle one, else a "new instance" entry. `startProjectTasks` splits a role's queue across instances only if
the profile allows, otherwise it stays as one message to one instance.

### 3.3 Brakes

Key `laneKey` by instance: `project/role#n`. A pair chain is then `from-instance > to-instance`, budgets are
per instance, and `onHumanSubmit` (`DashboardView.tsx:5401`) resets only the session the human typed into.
`resetChainFor(state, key)` splits on `>` and matches on the lane key, so it works unchanged with the longer
key. The coordinator stays a single instance, so its budget is unchanged.

### 3.4 Storage and migration

All additive; nothing is rewritten, so a downgrade still reads the files.

| Store | Change | Existing data |
|---|---|---|
| `sessions.json` | add `instance?: number` | absent = 1. On load, if a `(project, role)` has several rows with `claudeSessionId` and none is suspended, number them by `lastActiveAt` ascending. Stale duplicate rows (the 2-per-pair rows I saw) should be reviewed first, since numbering a dead row would show a phantom instance. |
| `projects.json` `Role` | add `instances?: { max: number; worktree: 'inherit' \| 'extra' \| 'always' }` | absent = `max: 1`, `inherit`. Behaviour identical to today. |
| `projects.json` `ProjectTask` | add `instanceKey?` | absent = role-wide, as today |
| `projects.json` `DispatchRecord` | add `fromKey?`, `toKey?`, `toInstance?` | absent = display by role, as today |
| `artifacts.db` | `ALTER TABLE ... ADD COLUMN session_id TEXT` on `reports`, `dispatch_requests`, `task_status`; `to_key TEXT` on `dispatch_requests` and `reports` | old rows NULL; readers use `role_id` when NULL. Guarded like `migrateReports` (`chat-store.ts:375-378`). |
| Environment | export `OPERATOR_SESSION_ID`, `OPERATOR_INSTANCE` at spawn (`terminals.ts:290`) | Running older lanes lack them: `resolveCaller` keeps its terminal-id fallback but should prefer a `terminalId + appPid` match, and refuse when two rows match instead of taking the first (`mcp-serve.ts:72`). |
| `worktree-provenance.json` | `laneId` stays the role id; add `sessionKey` | absent = unknown owner, as today |

Roll out behind `instances.max = 1` default, so shipping the identity plumbing changes nothing until a user
raises the number on a profile.

### 3.5 Recommended build order

1. Instance-keyed brakes and a single resolver. Replace all eight `terminals.find(role)` sites (K3-K5) with
   one function returning an instance, and make the bare-role case deterministic. This fixes real ambiguity
   even before a second instance exists, and it is the part that stops mixing.
2. Session id and instance number in the env, in `dispatch_requests`/`reports`/`task_status`, and on the
   verdict, record and task.
3. UI: key the maps in K10 by instance, group rows under the profile, add the selector on Send.
4. Launch: lift the reuse guard (K2) behind `instances.max`, force a worktree for instance 2+, never resume
   another instance's suspended session (K9).
5. Reports: keep the coordinator single-instance; add `to_key` so a report can be aimed at one session.

### 3.6 Risks and open questions

- The Claude CLI answers `SendMessage` for an unknown or dead socket with a failure, not silence
  (`dispatch-bus.ts:225-265`); addressing a specific instance keeps that property and improves it, because a
  dead target is refused up front instead of falling to a neighbour.
- `pickLaneTab`'s tie-break by last activity is what the current tests encode (`dispatch.test.ts`); step 1
  changes the meaning of "bare role with several live", so those tests are rewritten, not just extended.
- Prompts: `DISPATCH_PROTOCOL`/`REPLY_PROTOCOL` (`roster.ts:120-135`) tell lanes to address `<lane-id>`. They
  need one line explaining `code#2` and the "list of live labels" refusal. Lanes already running keep the old
  prompt, so bare-role handling must stay correct, not rely on the new syntax.
- Two instances on one checkout (`useWorktree: false`) is the most likely way to lose work; the recommendation
  above (force a worktree for instance 2+) should be a hard rule, not a setting.
- Not measured: how often a role actually has two live tabs today. `sessions.json` shows duplicate rows per
  role but those may be suspended or ended; I did not check which are live.

## Verified vs assumed

Verified by reading: all file:line references above; the K1 fix; `pickLaneTab` vs `find` mismatch; the resume
selection; the env variables set at spawn; the additive DB migration pattern.
Inferred, not run: K3 second bullet (hash excludes the addressee), K7 second bullet, the Electron
single-instance clash in Part 2, and the exact effect of a wrongly resumed session sharing a uuid (K9).
Not re-checked from the 09-14 audit: B3-B8, R1-R6, T1-T3.

## Part 1B — across projects (mantel received uwazi's Design messages)

### Evidence checked (all read-only)

| Check | Result |
|---|---|
| Every `[Operator] report #N from X` line typed into a session, joined to `reports.project_id` (259 lines in sessions I can map to a project through `sessions.json`, plus 1171 lines by directory) | 75 cross-project announcements, all filed before 0.19.0 (2026-08-25..29: reports #313-#347, #391-#400 announced into the `operator` coordinator). Project scoping of the announce queue shipped in 0.19.0 (`7f2bdd8`, tag `electron-v0.19.0`, 2026-08-29). **After 2026-08-30: zero.** |
| Delivered OPERATOR-REPLY text (`chat.db` `replies`, 977 rows across all projects) searched in every transcript as `[Operator · message from ...]` user turns | Nothing landed outside its own project. |
| `sessions.json` (41 rows): project stamp against the session's cwd and the project's path | All consistent except one unstamped row (`projectId` missing, 2026-08-13, mantel-sincopa). No mis-stamped rows. |
| Terminal ids in `sessions.json` | 14 ids appear under 2-3 different projects (e.g. `t2` = operator/review, el-encanto/code, mantel/code; `t5` = no project/operator, operator/design, mantel/design). Ids restart at `t0` each run, so these are stale rows, not live collisions. |
| Cross-session messages in transcripts (1676 `cross-session-message` entries, sender name against receiving session's project) | Only sends where the sending lane addressed another project on purpose: el-encanto -> mantel (9, 2026-08-31/09-01, "El-encanto found a tablet-view overscroll defect you likely share"), web27 -> operator (15), operator research probe -> mantel (2, 2026-09-06). No uwazi -> mantel. |
| `reports.to_role` | NULL on every row; `project_id IS NULL` on 2 rows. |

So the stored data shows two things and not the third. Cross-project announcements did happen and were fixed
in 0.19.0. Cross-project traffic is possible today because the bus is machine-wide. The uwazi Design ->
mantel case is not in any store I could read. `dispatch_requests` keeps rows for 24 h only
(`chat-store.ts:596`), the address stored there is a socket path whose pid is gone, and the Comms log rows
for bus dispatches are per project, so a misdelivery on the bus leaves no cross-project trace. The user's
observation may be right and simply unrecoverable from disk.

### Every place a message, brake, address or queue is keyed by role without a project, or resolved by role across projects

**X1. The session bus is machine-wide and names carry no role.** Verified. Descriptors live in
`~/.claude/sessions/*.json` (13 today); `session-bus.ts` reads them all. The display names are
`<cwd basename>-<2 hex>` (`mantel-2b`, `mantel-b0`, `mantel-b3`, `mantel-f4`, `uwazi-app-8f`,
`uwazi-app-ab`, worktree lanes `mantel-55da80-d7`). Operator passes no `--name` (`launch-args.ts:29-35`), so
the name says the directory and nothing about the role or project id. Any lane can call `SendMessage(to:
<name>)` or `ListAgents` and reach any session on the machine; Operator's project scoping
(`dispatch-bus.ts:95-99`, `routeDispatch(..., projectId)`) only governs what Operator hands out.
Scenario: uwazi's Design lane is told to notify "Design" and calls `ListAgents`; the list holds `mantel-*`
and `uwazi-app-*` sessions with no role, so it picks a name by prefix, and a wrong hex or a stale name from an
earlier turn is a mantel session. Confirmed as a live behaviour by the el-encanto -> mantel sends above
(intentional there, same mechanism). Nothing in Operator observes or brakes these sends: the brakes are only
consulted for OPERATOR-REPLY and `mcp__operator__dispatch|reply`.

**X2. Brakes with no project.** `laneKey(projectId, roleId)` returns the bare role when `projectId` is falsy
(`agent-delivery.ts:123-124`). Callers pass `t.projectId` from a tab (`DashboardView.tsx:5401`) or the
sender's tab (`DashboardView.tsx:1549`). Any tab without a project (`orphanTabs`, `dispatch.ts:70`, or the
one unstamped saved row) shares the key `design`/`operator` with every other unstamped tab, across projects.
`resetChainFor` would also clear it for all of them. Scope: only unstamped sessions.

**X3. Report announce queue.** `undeliveredFor(role, limit, projectId)` filters `project_id = ? OR project_id
IS NULL` (`chat-store.ts:444`); when the announcing tab has no `projectId`, `ipc.ts:189` passes null and the
query is UNSCOPED (comment at `chat-store.ts:440`: "the pre-scoping behaviour"). `expireUndelivered`
(`chat-store.ts:461`) has the same fallback and would mark other projects' reports delivered without
announcing them. Scenario: a mantel coordinator tab that lost its stamp announces uwazi's Design reports
and marks them delivered, so uwazi's own coordinator never sees them (delivery is stamped once,
`chat-store.ts:401`). Only the stamp-less case; 2 NULL-project rows exist today.
Also: `to_role` is never written, so a report from uwazi Design has no addressee, only a project.
The announce loop selects the coordinator by role name alone (`DashboardView.tsx:3935`), one app-wide
`announcingRef` (`3932`) serialises all projects.

**X4. MCP caller identity fallback resolves by terminal id across the whole file.** `mcp-serve.ts:68-86`.
A lane from an older build has neither env variable, so `sessions.json` is searched by `terminalId` and the
first row wins. With 14 ids present under 2-3 projects, the report/dispatch is stamped with the wrong
project and role (its own comment names `t2` four times). This is the one path where a message really
is attributed to another project by role/terminal alone. Only lanes older than the env stamp; they exist
after an app update while a lane keeps running.

**X5. Tab identity is a per-run terminal id, and the router mixes sources.** In the bus tick the project comes
from the request env (`DashboardView.tsx:1665`, `r.projectId ?? srcTab?.projectId`) but the sender role
comes from the tab first (`1684-1685`, `srcTab?.roleId ?? r.roleId`), and the sender tab is found by
`t.id === r.terminalId` (`1664`). A request left over from a previous run (rows live up to 30 s,
`chat-store.ts:551`) whose terminal id matches a different lane of this run gets the current lane's role
under the old lane's project. Window: 30 s after a restart. Low.

**X6. Renderer-only stamps.** A tab's `projectId`/`roleId` is a label set at launch or re-stamped every 5 s
from `claudeSessionId` (`DashboardView.tsx:548-575`); routing trusts it (`pickLaneTab`,
`dispatch.ts:49-58`), and the bus address comes from joining tab id to the live session list
(`DashboardView.tsx:1676-1678`, `uuidOf`). If a tab were labelled (uwazi, design) while its pty runs in mantel,
`pickLaneTab` picks it as uwazi's Design (most recently active) and the verdict hands out that mantel
session's socket. This is the mechanism that fits "uwazi Design messages reach mantel" best in code, but I
found no mis-stamped row today (see evidence table) and the join is on `claudeSessionId` since the
reattach fix (`session-reattach.ts:63-90`), so I rate it "possible, not observed". Inferred.

**X7. Content-hash dedupe shared by all projects.** `operator.reply.seen` and `operator.dispatch.seen` in
localStorage, last 500 ids across every project (`DashboardView.tsx:1503-1508,1936-1941`). Ids include the
sender session uuid (`directives.ts:102`) so they cannot collide across projects, but a busy fleet pushes
old ids out and a transcript re-read re-delivers them. Reply delivery has a durable per-project guard
(`DashboardView.tsx:1544`); the dispatch subscription does not.

**X8. Role defaults are global.** `~/.operator/role-defaults.json` and `resolveAgentConfig`
(`DashboardView.tsx:2769`) apply one Design/Code default to every project's lane of that name. Not a message
path, but a role id is treated as the same lane in every project.

**X9. Coordinator identity is the role id `operator`.** `COORDINATOR_ROLE_IDS` (`dispatch.ts:14`) and
`dispatchNeedsApproval` decide authority by role id. Every project has one, and the seed roster shares the
id, so any place that filters by `role === 'operator'` without a project (announce loop `3935`, chat-store
role filter `447`) treats all projects' coordinators alike.

**Already fixed and verified in code:** brake budget and pair chains per project (`agent-delivery.ts:123`);
report queue scoped by project (`chat-store.ts:443`); MCP caller stamped from env (`terminals.ts:290-291`);
`routeDispatch`/`pickLaneTab` require the project (`dispatch.ts:52,107`); OPERATOR-REPLY target requires the
project (`DashboardView.tsx:1546`); `dispatch_requests` and `reports` carry the project.

### What I could not establish

- The exact mantel/uwazi event. If it happened after 2026-09-24 the transcript of the receiving mantel session
  will show a `[Operator · message from ...]` or `<cross-session-message from=... from-name=...>` turn;
  the `from-name` tells whether it was a bus send (`uwazi-app-*`) or an Operator delivery, and the report or
  dispatch id in the text identifies the source. That single line separates X1 (bus, lane-chosen) from
  X3/X4/X6 (Operator-chosen).
- Whether uwazi's Design lane was told a bare `design`/`mantel` name by any prompt. `DISPATCH_PROTOCOL` tells
  lanes to send to the `to` field Operator returns (`roster.ts:120-135`); I did not find a prompt that asks
  lanes to look up peers by name.

### Recommended fixes for the cross-project class (small, independent of Part 2)

1. Name every session by project and role at spawn (`--name mantel/design` or similar; verify the flag against
   the installed CLI first). This alone makes `ListAgents` and any name-based send unambiguous and lets
   Operator recognise a bus send that leaves its project.
2. Refuse the unscoped fallback: `undeliveredFor`/`expireUndelivered` with no project return nothing,
   and `laneKey` with no project returns a key that includes the terminal id.
3. In `mcp-serve.ts`, when the environment lacks project/role and several `sessions.json` rows match the
   terminal id, return an error instead of the first row.
4. Write `to_role` and add `to_project` on reports, so a report has an addressee.
5. Tell lanes in the prompt to address peers only through `mcp__operator__dispatch|reply`, and log any
   `SendMessage` whose target session belongs to another project (the tailer already parses every
   `SendMessage` result: `DeliveryEvent` in `transcript.ts:62`).
