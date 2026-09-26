# Lane profiles with several live instances — implementation plan, 2026-09-25

Research lane, read-only. Base: `main` = `b4938a7` (0.26.0 plus docs commits). Builds on Parts 2 and 3 of
`dev/results/lane-instances-and-message-mixing-2026-09-25.md`. The queued cross-project work (Code adds
`claude --name <project>-<role>` with room for a `-2` suffix, and re-keys unstamped brakes) is NOT in `main`
yet (grep of `launch-args.ts` and `terminals.ts` finds no `--name`); the plan treats it as step 0.

Marks: **[V]** verified by reading code or running `--help` at this commit. **[A]** assumed, needs a check by
the Code lane before relying on it.

## 1. Model

### 1.1 Terms

- **Profile** = `Role` in `projects.json` (`types.ts:155-185`). Unchanged. Gains one optional field, `instances`.
- **Instance** = one live or suspended Claude session launched from a profile in one project.
- **Instance identity** = `claudeSessionId` (uuid, assigned with `--session-id`, `launch-args.ts:32` [V]).
  Its persisted twin is `SavedSession.key` (uuid, `types.ts:704`; `DashboardView.tsx:2683` [V]). Both already
  exist, both are unique, both survive restart, and reattach already joins on `claudeSessionId`
  (`session-reattach.ts:63-90` [V]). No new id is minted.
- **Instance number** `n` (integer >= 1) = the human-facing ordinal within `(project, role)`. Stored on
  `SavedSession.instance` and `TerminalTab.instance`. Absent means 1.
- **Terminal id** (`t7`) stays a per-run handle for ptys and the submit queue. Never a cross-run key.

### 1.2 Label, address token, CLI name

| Thing | Instance 1 | Instance 2 | Where used |
|---|---|---|---|
| Display label | `Code` | `Code 2` | sidebar, board chips, toasts, message prefix |
| Address token (dispatch/reply/sentinels) | `code` | `code#2` | `mcp__operator__dispatch(lane)`, `OPERATOR-DISPATCH [code#2]` |
| Explicit "make a new one" | | `code#new` | dispatch only |
| CLI session name (`--name`) | `mantel-code` | `mantel-code-2` | `ListAgents`, bus descriptor `name` |

Rules:

- `n` for a new instance = the smallest positive integer not used by a live OR suspended instance of the same
  `(project, role)`. A suspended instance keeps its number so it resumes as the same label.
- Numbers are never reassigned while an instance exists; closing Code 1 while Code 2 lives leaves Code 2.
- Token parsing is one function. It tries the roster id first (so a user role named `code-2`, which
  `roleIdFrom` can generate, `roster.ts:481-487` [V], still resolves as a role), then `<roleId>#<n>`.
  `#` is chosen over `-2` because `-` is already in roster ids. The sentinel parser accepts any text between
  the brackets (`directives.ts:81-85` [V]), so `[code#2]` parses today without a change.
- CLI name collision: role `code-2` instance 1 and role `code` instance 2 would both be `mantel-code-2`. [A]
  The name builder must check live names and, on a clash, fall back to `mantel-code-i2`. Tell the Code lane
  doing step 0 so the `-2` suffix is built by one shared function (`sessionName(project, role, n)`).
- The delivered-message prefix carries the token, not just the name: `[Operator · message from Code 2 (code#2)]`
  (`agent-delivery.ts:172-174` [V] builds it from a label only). This is what lets a coordinator answer the
  right instance without a lookup.

### 1.3 What stays one per role: the coordinator

The coordinator (`operator`, and legacy `orchestrator`) is clamped to `max = 1` in the resolver; the settings
control is hidden for it. Reasons, all [V]:

- Authority gate by role id: `COORDINATOR_ROLE_IDS` and `dispatchNeedsApproval` (`dispatch.ts:14-27`).
- Reports are announced only to the coordinator, one app-wide `announcingRef`, and marked delivered once
  (`DashboardView.tsx:3932-4006`, `chat-store.ts:401`). Two coordinators would split the queue.
- Its note describes the team (`roster.ts:333-345`); two coordinators would each believe they own the plan.
- `to_role` is never written on reports, so "the coordinator" is the only addressee that has ever existed.

Non-coordinator profiles default to `max = 1`, so nothing changes until a user raises it.

## 2. Ordered steps

Each step is one Code task, merges alone, and leaves behaviour identical while every profile has `max = 1`.
Steps 0-6 are dark (no second instance can exist). Step 7 is the only one that enables one.

### Step 0 (queued, not part of this plan's work): `--name` and unstamped brake keys

Add: one shared `sessionName(project, role, n = 1)`. Ask that it takes `n` now, returns `<project>-<role>` for 1
and `<project>-<role>-<n>` after. Verified: installed CLI has `-n, --name <name>` [V, `claude --help`].
The re-key of unstamped brakes should end with `laneKey(projectId, roleId, n)` (see step 5); if step 0 lands
first with a two-argument `laneKey`, step 5 extends it.

### Step 1: identity module (pure)

New `src/renderer/lib/lane-instance.ts`, no callers yet:

- `type InstanceRef = { key: string; claudeSessionId?: string; roleId: string; n: number }`
- `instanceLabel(roleName, n)`, `instanceToken(roleId, n)`, `sessionName(project, roleId, n)` (shared with step 0)
- `parseLaneToken(token, roster)` -> `{ role, n?: number, mode: 'bare' | 'explicit' | 'new' } | undefined`
- `nextInstanceNumber(taken: number[])`
- `pickInstance(role, candidates, tasks, sessions)` -> `{ kind: 'send', instance } | { kind: 'launch', n } | { kind: 'queue', instance } | { kind: 'ambiguous', live }` implementing 3.1
- `clampMax(role)`: coordinator = 1, else `role.instances?.max ?? 1`

Tests (`lane-instance.test.ts`): token grammar incl. `code-2` role id, `code#2`, `code#new`, unknown; number
assignment with a suspended number held; every branch of `pickInstance` (idle wins, tie by last activity,
none idle + room -> launch, none idle + full -> least loaded, explicit dead -> refuse, coordinator clamp).

### Step 2: stamp and persist `instance`

Sites [V]:
- `types.ts:704` `SavedSession`: add `instance?: number`. `DashboardView.tsx:88` `TerminalTab`: same.
- Launch: `DashboardView.tsx:2683-2692` (tab creation) stamps `instance`; `2405,3064-3073` restore paths carry it.
- Persist effect `DashboardView.tsx:3454-3464` (`operatorFields`) includes it.
- Spawn env: `terminals.ts:290-291` add `OPERATOR_SESSION_ID` (claude uuid; `SpawnOptions.sessionId` exists,
  `terminals.ts:80`) and `OPERATOR_INSTANCE`. Older lanes lack them; every reader must tolerate absence.
- `ProjectPatch`/`Role`: add `instances?: { max: number; worktree: 'inherit' | 'always' }` to `types.ts:155`.
  (`'extra'` from the earlier draft is dropped: the rule is fixed, see step 7.)

Tests: `session-reattach.test.ts` (instance survives join; absent reads as 1); `lane-instance.test.ts`
(numbering from a saved list). No behaviour change.

### Step 3: identity in the artifact store and the MCP caller

Sites [V]:
- `chat-store.ts:252-305` tables `reports`, `dispatch_requests`, `task_status`; add nullable `session_id TEXT`
  and `instance INTEGER` via the existing tolerated `ALTER` loop (`chat-store.ts:375-378`, `migrateReports`).
  Add `to_key TEXT` on `dispatch_requests` and `reports` (unused until step 6/10).
- `insertReport` (381), `openDispatch` (520), `insertStatus` (502): accept and write the new fields.
- `mcp-serve.ts:33-88` `resolveCaller`: read `OPERATOR_SESSION_ID`/`OPERATOR_INSTANCE`; in the
  `sessions.json` fallback, if more than one row matches `terminalId` (X4 in the previous report, `72`), return
  an error instead of the first row.
- `mcp-serve.ts:268-272`: pass session and instance to `openDispatch`.

Tests: `chat-store.test.ts` (migration on a database without the columns, old rows read as NULL);
`mcp-serve.test.ts` (env present -> stamped; env absent and two matching rows -> error).

### Step 4: one resolver for "which terminal is this lane"

Replace every role-keyed tab lookup with functions from step 1. Sites [V]:

| Site | Now | Becomes |
|---|---|---|
| `dispatch.ts:49-58` `pickLaneTab` | most recent active of role | thin wrapper over `pickInstance` for the `bare`/one-live case |
| `dispatch.ts:89-109` `routeDispatch` | role token | takes parsed token, returns instance candidates |
| `dispatch.ts:111-124` `liveLaneNames` | role name per tab | one entry per instance, label with number |
| `DashboardView.tsx:1546` reply target | `tabs.find(role && project && !ended)` | resolver, strict (no guess) |
| `2008, 2062, 2087` approve / retry / assign: sender tab | `find(role === rec.fromRoleId)` | by `rec.fromKey`, fall back to role when absent |
| `2068` retry: target tab, and its `clearComposer` | `find(role === rec.toRoleId)` | by `rec.toKey`, fall back to role when absent (the destructive call must never guess) |
| `2742` launch reuse | `pickLaneTab` | see step 7 |
| `2890, 2920, 2979` human Send / Start all | `terminals.find(project && role)` | resolver; with `max = 1` identical |
| `1889, 1803, 2733` in-flight keys `project:role` | role | `project:role:n` (step 7) |

Tests: `dispatch.test.ts` (every existing case unchanged with one instance; new: two live, explicit, ambiguous
reply refused); a regression test that no call site uses bare `find` on `roleId` (a grep-style test over
`DashboardView.tsx` is brittle, so instead export the resolver and assert the call sites via the
`dispatchToRole`/`approve` handlers with two fabricated tabs). Behaviour change only where two tabs share a
role, which cannot occur before step 7.

### Step 5: brakes per instance

Sites [V]: `agent-delivery.ts:123-124` `laneKey`; callers `dispatch-bus.ts:174-175`,
`DashboardView.tsx:1549-1550, 1714, 2889, 2928, 5401`.

- `laneKey(projectId, roleId, n = 1)`: `project/role` for n = 1 (identical to today, so the in-memory state and
  every test keep working), `project/role#n` otherwise. Unstamped tabs get `orphan:<terminalId>/role` (this is
  the queued cross-project re-key; align with it).
- `resetChainFor(state, key)` splits on `>` (`agent-delivery.ts:288`); `#` does not interfere. Add a test.
- `onHumanSubmit` (`5401`) passes the tab's own instance, so typing into Code 2 resets only Code 2.

Tests: `agent-delivery.test.ts` (two instances of one role have separate budgets, chains, exhaustion; typing
resets one; n = 1 key equals the old key).

### Step 6: dispatch selection, verdict, records

Sites [V]: `dispatch-bus.ts:57-66` (`DispatchRequest`), `89-221` (`resolveDispatch`), `26-55` (`DispatchVerdict`),
`mcp-serve.ts:115-146` tool schemas and `292-298` JSON answer, `DashboardView.tsx:1654-1785` tick,
`types.ts:610` `DispatchRecord`, `types.ts:196` `ProjectTask`.

- `resolveDispatch` uses `parseLaneToken` + `pickInstance` (selection rules in 3.1). Returns
  `target: { roleId, terminalId, key, n, label }` and, for `launching`, the `n` it will use.
- `mcp-serve` answer JSON adds `label` and `token`; tool descriptions explain `code#2` and `code#new`.
- `DispatchRecord`: add `fromKey?`, `toKey?`, `toInstance?`. `ProjectTask`: add `instanceKey?` (set for
  running tasks from the verdict; queued tasks may be pinned by the board, step 9). Written at
  `DashboardView.tsx:1727-1731, 1764, 1853`.
- `reply` (`kind === 'reply'`): never launches; bare role with more than one live instance is refused with the
  list of live tokens (3.1). The sentinel reply path (`1519-1546`) gets the same rule.
- Delivered prefix gains the token (`agent-delivery.ts:172`).

Tests: `dispatch-bus.test.ts` (each branch in 3.1, including refusal texts, that a refused dispatch charges
no budget, and that `launching` returns the number), `agent-delivery.test.ts` (prefix), `mcp-serve.test.ts`
(answer JSON shape), `directives.test.ts` (`[code#2]` target parses [V by reading; add the test]).

### Step 7: launch, worktree rule, resume (enables instance 2)

Sites [V]: `DashboardView.tsx:2732-2815` `handleLaunchRole`, `2597-2720` `handleLaunchSession`,
`lane-workspace.ts:26-33`, `model-config.ts:83` `resolveAgentConfig`, `2774-2801` resume.

- `handleLaunchRole(project, role, prompt, launchDevServer, { focus, instance })`: `instance` is `undefined`
  (today: reuse the live lane), a number (that one), or `'new'`. Reuse guard (`2742-2748`) applies only when
  `instance` is undefined and a live one exists. `'new'` is allowed only while `live < clampMax(role)`.
- Resume (`2774-2776`): pick the suspended row for `(project, role, n)`; `'new'` never resumes another
  instance's row. Fixes K9 of the previous report.
- Worktree rule, hard: `n >= 2` launches with `useWorktree = true` regardless of the profile. If
  `worktreeCreate` fails (`2628-2631` today falls back to the main checkout with only a `console.warn` [V]),
  an instance >= 2 refuses to launch and toasts, because two agents in one checkout is the way to lose work.
  Instance 1 keeps today's fallback.
- `launchWorkspace` gains `n`; `sharesMainCheckout` is false for `n >= 2`.
- Pass `--name` via the shared `sessionName` and `OPERATOR_INSTANCE` (steps 0, 2).
- Per-instance system note (step 8).

Tests: `lane-workspace.test.ts` (n >= 2 forces a worktree, refuses without one), a pure `planLaunch(...)`
extracted from `handleLaunchRole` and tested for: reuse, join in-flight, new instance under and at the cap,
resume by number. Manual GUI check listed for the user (not verifiable here).

### Step 8: prompts and the coordinator's launch note

Sites [V]: `roster.ts:120-135` `DISPATCH_PROTOCOL`/`REPLY_PROTOCOL`, `roster.ts:321-375` `orchestrationNote`,
`laneSummary` (`roster.ts:308`).

- Worker note: "You are Code 2 (token `code#2`)" when n >= 2; unchanged for n = 1.
- Coordinator note (`roster.ts:333-345`): the team list stays per profile (`"Code" (id: code, opus) —
  purpose`), plus one line for profiles with `max > 1`: "may run up to N sessions; address one as `code#2`, ask
  for a new one with `code#new`, or write `code` and Operator picks an idle one". It cannot list live
  instances: the note is fixed at spawn and instances come and go. So liveness reaches the coordinator two
  ways: (a) every dispatch answer and refusal carries the live labels, (b) the existing `feedback()` line
  (`DashboardView.tsx:1858-1863`, `liveLaneNames`) names live instances with tokens.
- Optional, deferred: a read-only `mcp__operator__lanes` tool returning live instances for the caller's
  project. Needs the app to publish live state to the store (the renderer owns it), same request/verdict shape
  as `dispatch_requests`. Not needed for step 7.
- Lanes already running keep the old prompt, so a bare role must always stay correct.

Tests: `roster.test.ts` (note contents for n = 1, n = 2, `max > 1` and `max = 1`; coordinator never shows the
multi-instance line).

### Step 9: task ownership

Sites [V]: `DashboardView.tsx:1259-1268, 1344-1350` add/assign, `1362-1385` `completeTerminalTasks`, `2759`
queued pickup, `2923` mark running, `2958-2961` start-all grouping, `3348` `openWork`, `3875-3878` `hasRunning`,
`task-lifecycle.ts:60-62, 84`.

- Running tasks already carry `claudeSessionId` (`types.ts:219`); make the two role-only triggers
  (`3348`, `3875`) match by `claudeSessionId` when the task has one, role only for unstamped legacy tasks.
- Queued tasks: `instanceKey?` optional. Launch pickup (`2759`) takes tasks with no `instanceKey` (role-wide) or
  with this instance's key. Send -> targets `instanceKey` when present, else the resolver's choice.
- Start all (`2958`): group by `(role, instanceKey)`; role-wide tasks go to one instance (idle first).
- `roleCounts` (`task-lifecycle.ts:60`): count per role stays; add per-instance count for the board.

Tests: `task-lifecycle.test.ts` (Code 1 finishing a turn does not trigger completion for Code 2's running task;
legacy unstamped task still matches by role), pickup test for pinned and role-wide tasks.

### Step 10: reports

Sites [V]: `mcp-serve.ts:227-243`, `chat-store.ts:381,443`, `comms.ts:135,217`, `DashboardView.tsx:3932-4006`.

- Write `session_id`, `instance` (step 3); announcement and Comms log show the label
  (`comms.ts:217` `from ${roleId}` -> label).
- Coordinator stays single; `announcingRef` becomes per project (removes the cross-project stall, R4 in the
  09-14 audit).
- `to_key` stays unused until a lane can address a specific instance with a report; not needed now.

Tests: `comms.test.ts` (label), `chat-store.test.ts` (columns).

### Step 11: display maps keyed by instance (no visual change)

Sites [V]: `DashboardView.tsx:5187,5200` (`live[roleId]`, `laneRuntime`), `3655` (`byRole` shortcuts),
`ProjectGallery.tsx:415`, `AgentsHubView.tsx:39`, `RosterPanel.tsx:79,472`, `ProjectView.tsx:51-53,213`,
`ProjectRail.tsx:404-450,979,1141`, TaskBoard chips (30 `roleId` uses). Change the data maps from
`roleId -> x` to `roleId -> x[]` (or keyed by tab id), keeping today's rendering by showing the first. This
lands before Design work so the UI step is only presentation. Tests: existing view tests plus a fixture with
two tabs per role that asserts nothing is dropped from the maps.

### Step 12: UI and settings (blocked on Design)

See section 4 for the questions. Includes the `instances.max` control in `RosterPanel` and the instance
selector on Send ->.

## 3. Behaviour

### 3.1 How dispatch picks an instance

Input: token from `lane` (or the sentinel target), project, sender.

1. `code#N` or a session key -> that instance if live; else refuse ("Code 2 is not running. Live: Code, Code 3").
   Never fall back to a different instance.
2. `code#new` -> launch a new instance if `live < max`, else refuse with the live list.
3. Bare `code`:
   - zero live -> launch instance 1 (today's `queue` path).
   - one live -> it (today).
   - several live -> the idle ones (phase `idle`, no running task stamped with its `claudeSessionId`); among
     them the most recently active. None idle: launch a new one if `live < max`; else queue on the instance with
     the fewest running tasks and say which in `reason`.
4. `reply` differs: never launches; bare role with several live is refused with the live tokens, because a
   reply answers a specific session and guessing is what causes the mix-up.
5. The authority gate (`dispatchNeedsApproval`), brakes and approval flow run after the target is fixed, on
   the chosen instance's key. Approval stores `toKey` so an approved dispatch goes where it was routed.

Assumed [A]: "idle" as defined matches what users expect; `session.phase` and running-task stamps are both
available in the resolver context (`DashboardView.tsx:1676-1678` builds `lanes` with `claudeSessionId`, phase
comes from `sessionsRef`). The Code lane should confirm the phase names in `types.ts` (`AgentSession.phase`).

### 3.2 Worktrees, dev ports, CDP ports

- Worktrees [V]: name and branch are random per launch (`worktree.ts:290-293`, `operator/<shortId>`,
  `<project>-<shortId>`), so several instances never collide. Resume reattaches the recorded branch
  (`worktree.ts:259-271`). `laneId` in provenance is a label only (`worktree.ts:224,298`; nothing else reads
  it, grep [V]); step 7 may pass `role#n` for readability. `worktree_done` uses the lane's own cwd from
  `OPERATOR_LANE_CWD` (`mcp-serve.ts:314`), so it is already per instance. Rule for n >= 2: always a worktree.
- Dev ports [V]: reserved per cwd, and lanes in the same cwd share one deliberately (`terminals.ts:111`,
  `port-alloc.ts:70-90`). Instances in their own worktrees have distinct cwds, so each gets its own port from
  1420-1520 (101 ports, `port-alloc.ts:32`). Instance 1 in the main checkout keeps today's shared port. No change
  needed. Watch: the window is finite; six projects x several worktree lanes is still far below 101, but the
  port-exhaustion note in the spawn prompt (`terminals.ts:244-252`) already handles running out.
- CDP ports [V]: one per pty, unshared (`terminals.ts:628-640`, window 9340-9440, `preview-cdp-port.ts:14-15`),
  so two Electron-app instances each get their own. The dev-server rule that "another lane may already serve
  this code" (`terminals.ts:244-248`) does not apply across worktrees.
- Not verified: two instances of an Electron app started from two worktrees of the same project may still
  clash on a single-instance lock or a shared `userData` directory, which is app-specific and outside
  Operator. [A] The launch note for an Electron project could say "use a distinct `--user-data-dir`"; suggest
  adding one line in step 8 for instances >= 2 in Electron projects.

### 3.3 Sessions and bus

The bus is already per session uuid [V] and `--name` (step 0) makes names readable. `resolveDispatch` keeps
returning the socket of the chosen instance (`dispatch-bus.ts:192`). Two tabs must never share one
`claudeSessionId`; step 7's resume rule guarantees it, and `preferSession` (`session-bus.ts`) is the
existing backstop.

## 4. UI questions for Design (not designed here)

1. Sidebar: one row per instance or one row per profile with a count? How are `Code` and `Code 2` told apart
   at collapsed width (`resolveLaneInitials`, `ProjectRail.tsx:404-450` today assumes one disc per role)?
2. Row identity and drag: rows reorder the ROSTER by role id (`ProjectRail.tsx:243,979`). What does dragging
   `Code 2` mean, and where does a second instance sit relative to its profile?
3. Board: task chips name a role (`TaskBoard.tsx`, 30 uses). Should a running card show the instance
   (`Code 2`), and how does a user pin a queued task to an instance or leave it role-wide?
4. Send -> and Start all: a target selector (default: recorded instance, else idle one, else "new instance")?
   What does Start all do when a profile has several instances?
5. Team/Roster card: where does `instances.max` live and how is a running count shown (`RosterPanel.tsx:79,472`)?
   The coordinator card hides it.
6. Numbered shortcuts (`⌘1..9`, `DashboardView.tsx:3655`): do instances take a number each?
7. Comms log and dispatch log rows: how are `from Code 2 -> Operator` shown, and what do old rows (role only)
   look like?
8. Close and forget: closing Code 1 while Code 2 lives; does Code 2 renumber visually? (Recommendation: no.)
9. Launch affordance: "add another Code" button, its placement, and the message when `max` is reached or a
   worktree cannot be created.

## 5. Migration

All additive; nothing is rewritten in place, so a downgrade still reads every file.

| Store | Change | Existing data |
|---|---|---|
| `sessions.json` (41 rows [V]) | `instance?` on rows | Absent = 1. No file rewrite. When two rows of one `(project, role)` are both restored live (the file has pairs for `qa`, `review`, `research`, `operator` today [V]), assign numbers by `lastActiveAt` ascending in memory at restore, and let the persist effect (`DashboardView.tsx:3454`) write them. Rows that are suspended or ended keep their number or none. Review those pairs first: they may be stale rows, and numbering a dead row would show a phantom instance [A]. |
| `projects.json` | `Role.instances?`, `ProjectTask.instanceKey?`, `DispatchRecord.fromKey/toKey/toInstance?` | Absent = `{max: 1, worktree: 'inherit'}`, role-wide, role-only display. |
| `artifacts.db` | nullable `session_id`, `instance`, `to_key` | Old rows NULL; readers fall back to `role_id`. Uses the tolerated `ALTER` pattern (`chat-store.ts:375-378` [V]). |
| Env | `OPERATOR_SESSION_ID`, `OPERATOR_INSTANCE` | Lanes already running lack them; `resolveCaller` keeps its terminal-id fallback, now refusing ambiguity. |
| `worktree-provenance.json` | optional `sessionKey` | Absent = unknown owner, as today. |
| localStorage seen-sets | none | Directive ids include the target token (`directives.ts:102`), so `code#2` and `code` get distinct ids [V]. |

## 6. Risks and order notes

- Step 4 is the riskiest edit (eight call sites in a 5,650-line file). It changes nothing with `max = 1`, so it
  can merge early and run for a release before step 7.
- Step 7 must not merge before steps 4, 5, 6 and 9's completion matcher fix, or a second instance will
  receive the first one's messages and tasks.
- `--name` collisions (1.2) and the CLI name of a resumed session: a resumed session may keep its original name
  and ignore `--name` [A]. Check with the installed binary before step 0 ships the suffix logic
  (`feedback_verify_against_installed_binary`).
- The renderer respawns under memory pressure (`DashboardView.tsx:525-533`); instance numbers live in
  `sessions.json` and are re-read on reattach, so they survive. The tab's `instance` must be restored from the
  saved row, not recomputed, or Code 2 could become Code 1 after a respawn.
- Lane prompts are fixed at spawn (1.2, step 8): a lane launched before this ships treats `code` as one lane.
  Bare-role handling must stay correct for it.

## 7. Verified vs assumed

Verified by reading at `b4938a7`: every file:line above; `claude --help` shows `-n, --name`; identity fields
exist and are unique; worktree/branch names are random per launch; dev ports are per cwd and CDP ports per
pty; the sentinel parser accepts any bracket text; `roleIdFrom` can generate `code-2`; the ALTER migration
pattern; worktree-creation failure falls back to the main checkout with a warning only.

Assumed, to check in the task that touches it: CLI name collision handling and whether a resumed session keeps
its name (step 0); phase names for "idle" (3.1); whether the duplicate `sessions.json` rows are live, suspended
or stale (5); Electron single-instance and `userData` clashes (3.2); that Design agrees with hiding numbers
from collapsed rows (4).
