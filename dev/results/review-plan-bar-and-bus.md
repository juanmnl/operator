# Review — `operator/plan-bar` (983e44f) and `operator/dispatch-bus` (0554ffa)

Reviewed 2026-09-06 against `main` = `1f5277c`. Both branches fork from `df7bc46`, one commit each,
independent. Accounts: `dev/results/plan-bar-implement.md`, `dev/results/dispatch-over-bus.md`.

Verified in detached worktrees:

| | tsc | renderer | electron |
|---|---|---|---|
| `plan-bar` @ `983e44f` | clean | 1095 / 0 (74 files) | 501 / 0 (25) |
| `dispatch-bus` @ `0554ffa` | clean | 1089 / 0 (74 files) | 508 / 0 (26) |

`cargo test` not run on `plan-bar`; its Rust change is a mirror of the TypeScript one with four new
unit tests, and the defect below is present in both halves identically.

---

# `operator/dispatch-bus`

## 1 — HIGH · The bus path bypasses the authority gate, so any lane can commission work

`src/renderer/views/DashboardView.tsx:1531-1620` (the bus poll) vs `:1789` (the sentinel).

The sentinel path holds a non-coordinator's dispatch, and its own comment states the rule:

> AUTHORITY GATE. Only the coordinator commissions work unsupervised. Any other lane's dispatch is
> recorded `pending-approval` and NOT delivered … EVERY route is held, including `unassigned`.
> Filing a task into the backlog is still commissioning work.

`dispatchNeedsApproval` has exactly one call site in the repo — `DashboardView.tsx:1789`, inside
the `onOrchestratorDispatch` subscription. The bus poll never calls it, `resolveDispatch` never
calls it, and `mcp-serve.ts`'s `TOOLS` array is a module-level constant offered to every lane
regardless of `OPERATOR_ROLE_ID`.

**Failure scenario.** The Code lane calls `mcp__operator__dispatch(lane: "qa", task: "…")`.
Operator resolves the role, and either launches a QA lane with that text as its opening brief
(`DashboardView.tsx:1590` → `deliverDispatchRef`) or creates a running task on the board and hands
Code a socket address and the wrapped text to deliver itself. No `pending-approval` record, no
toast asking the user, no held dispatch in the log. The guardrail the sentinel path enforces is
simply not on this path.

This is not a subtle omission: the tool description says "Operator resolves the lane, applies the
delivery brakes, creates the task and its board entry", and the brakes it applies
(`evaluateDelivery`, the hop budget) are a different guardrail from the authority gate. The account
claims "The app applies exactly what the sentinel applies — role resolution through the same
`routeDispatch`, the same brakes, the same task and board entry". The authority gate is the one
thing it does not apply, and it is the one that decides whether a lane may put work into another
lane at all.

Note the two paths now each hold one guardrail and not the other:

| | authority gate | hop budget |
|---|---|---|
| sentinel `OPERATOR-DISPATCH` | yes (`:1789`) | no |
| sentinel `OPERATOR-REPLY` | n/a | yes (`:1474`) |
| bus `dispatch` / `reply` | **no** | yes (`dispatch-bus.ts:122`) |

The session-bus spike said this in advance: "what it does *not* give Operator for free is pre-send
brakes: native `SendMessage` lets any lane message any other". Routing through Operator was
supposed to restore that, and for the hop budget it does. For authority it does not.

## 2 — HIGH · The delivery-confirmation half does not exist

`src/renderer/lib/dispatch-bus.ts:192` (`readDeliveryResult`), `:35` (`DispatchVerdict.taskId`).

`readDeliveryResult` is exported, carries a 13-line doc comment beginning "THIS REPLACES THE PTY
WATCHDOG for bus dispatches", and has five tests. It has **no caller anywhere** in `src/` or
`electron/src/`. Neither tailer was touched on this branch — `transcript.ts` and `transcript.rs`
are not in the diff — so nothing reads a `SendMessage` tool result, and `SendMessage` appears in
`electron/src/` only inside prompt strings.

`taskId` compounds it. `DispatchVerdict.taskId` is documented as "The task this dispatch created or
matched, so the lane's `SendMessage` result can be recorded against it" — and `resolveDispatch`
never sets it on any branch. `DashboardView.tsx:1611` faithfully forwards `taskId: verdict.taskId`,
which is always `undefined`. So even if the tailer were wired, there would be no correlation key.

**This answers the brief's question directly.** There is no `tool_result` → task outcome mapping on
this branch, so "unrecognised = failed" is a property of dead code, and "a `SendMessage` the lane
makes for its own reasons must not be attributed to a dispatch" cannot go wrong because nothing
attributes anything. The consequence is the reverse of what was intended: **a bus dispatch has less
delivery confirmation than the pty path it replaces.** `addRunningTask` marks the task running at
`DashboardView.tsx:1601`; the lane may then fail to send — the spike measured the exact failure the
CLI returns for a stale socket, `{"success":false,"message":"Failed to send to uds:… ENOENT … this
socket path is stale"}` — and nothing observes it. The board shows work in progress that was never
delivered, which is the failure mode the branch's own prose says it exists to end.

## 3 — MEDIUM-HIGH · The 500ms poll has no in-flight guard, so a slow tick duplicates every side effect

`src/renderer/views/DashboardView.tsx:1617`: `window.setInterval(() => { void tick() }, 500)`.

`tick` is `async` and awaits an IPC round trip for `openDispatches()`, then per request awaits
`answerDispatch`. The only guard is `stopped`, which covers unmount. Nothing prevents a second tick
starting while the first is still between `openDispatches()` and `answerDispatch`, and a tick that
launches a lane (`deliverDispatchRef` → `worktreeCreate` + `terminalSpawn`) takes seconds.

`answerDispatch`'s `WHERE id = ? AND answered_at IS NULL` (`chat-store.ts:483-485`) makes the
*write* idempotent, so a verdict cannot be applied twice — that part is right. The side effects are
not behind it:

- `deliveryStateRef.current = brakes` (`:1588`) runs on every pass, so one dispatch charges the hop
  budget twice.
- `addRunningTask` (`:1601`) runs on every pass, so the board gets duplicate task rows.
- `deliverDispatchRef` (`:1590`) runs on every pass; `launchingLanesRef` de-duplicates the spawn but
  the second call still lands `record('launched')` and a second `[Operator] …` note into the
  caller's pty.

Worse, the second pass recomputes `resolveDispatch` against the already-charged brake state, so it
can produce `refused` where the first produced `send`. The first `answerDispatch` wins, so the lane
gets the right answer — while the brake state and the board carry the second pass's damage. A
`busy` flag around `tick` is the whole fix.

## 4 — MEDIUM · Unanswered requests never expire, so downtime replays as a burst of launches

`electron/src/main/chat-store.ts:479-483` — `openDispatches()` selects `WHERE answered_at IS NULL
ORDER BY id` with no age cutoff. `pruneDispatches` only deletes rows that were *answered*
(`:492-494`), and the account confirms nothing calls it at all.

**Failure scenario (the brief's "what if the app is not running").** The app is closed. Lanes keep
running — they are ptys, and `--mcp-serve` is spawned by `claude`, not by the app. Each
`mcp__operator__dispatch` inserts a row, blocks 15s (`mcp-serve.ts:191`), times out, and correctly
tells its caller "Operator did not answer in time. Nothing was sent and no task was created". The
row stays. The app starts the next morning; the first tick reads every one of those rows and acts
on all of them — creating tasks and launching lanes for dispatches whose callers gave up hours ago
and whose context is gone. The message the caller received ("no task was created") becomes false
retroactively.

An `at > now - 60s` filter in `openDispatches`, or answering stale rows `refused` without side
effects, closes it.

## 5 — MEDIUM · The prompt tells the model to read `to`; the payload carries `address`

Traced through all four hops:

- `resolveDispatch` returns `{ outcome, to, text }` (`dispatch-bus.ts:163`) — renderer-internal.
- `DashboardView.tsx:1611` writes it as `address: verdict.to`.
- The column is `address` (`chat-store.ts` schema), and `dispatchVerdict` reads it back as
  `{ outcome, address, text, taskId, reason }` (`:456-465`).
- `mcp-serve.ts:270` returns `JSON.stringify(verdict)` verbatim.

So the lane receives `{"outcome":"send","address":"uds:/tmp/cc-socks/1234.sock","text":"…"}` while
both the tool description (`mcp-serve.ts:119`) and `DISPATCH_PROTOCOL` (`roster.ts`) say "call
`SendMessage` with the `to` and `text` it returns". The account calls this text load-bearing — "a
model that reads `dispatch` as delivering would report work as handed off that never left" — and it
names a field that is not in the payload. A model will probably recover from one obvious
address-shaped value, but this is the one instruction that must not need recovering, and it has
never been exercised end to end.

(Two renamings in one instruction, in fact: `SendMessage`'s own parameters are `to` and `message`,
not `to` and `text`.)

**The `uds:` form itself is fine** — the spike verified `SendMessage`'s `to` accepts a raw
`uds:/tmp/cc-socks/<pid>.sock` path directly, and used it successfully. No concern there.

## 6 — MEDIUM · `refused` carries no instruction, and a brake refusal reads as "try again"

`roster.ts` `DISPATCH_PROTOCOL`: "On `refused` nothing was sent."

That states a fact and stops. Two very different refusals arrive under it:

- `unassigned` — `reason` lists the roster (`dispatch-bus.ts:89-90`). Retrying with a correct lane
  name is the right move.
- a brake — `reason` is `delivery brake: <note>` (`:134`). Retrying is precisely the runaway the
  brake exists to stop, and a model given a roster list in one case and a terse note in the other
  will generalise from the first.

`launching` and `send` are both unambiguous and correctly written. `refused` needs one clause
distinguishing "pick a different lane" from "stop, and tell the user".

## 7 — MEDIUM · The bus registry has no liveness check, and a duplicate `sessionId` resolves arbitrarily

`electron/src/main/session-bus.ts:67-79`.

`readBusSessions` reads every `.json` in `~/.claude/sessions` and returns them keyed by session
uuid. There is no `kill(pid, 0)`, no mtime check, and no reconciliation against the pids Operator
knows. The doc says "Every live session" and `addressOf`'s comment argues that null "is a real
answer" — but a **stale descriptor makes a dead lane look live**, which is the case that comment
does not cover. A `claude` killed with SIGKILL leaves its file behind; Operator then answers `send`
with a dead socket. Combined with finding 2 the send fails and nothing notices.

The duplicate case is sharper. `out.set(s.sessionId, s)` (`:75`) runs inside `Promise.all`, so with
two descriptors carrying the same `sessionId` the winner is whichever `readFile` resolves last —
nondeterministic, and it can be the dead one. That collision is not hypothetical: Operator's own
restore path spawns with `--resume <same uuid>`, so a crashed process's descriptor and the live
one's differ only by pid. A `kill(pid, 0)` filter, or preferring the highest pid / newest mtime,
would make it deterministic.

Permissions are handled correctly: only `.json` is read, the owner-only `.key` siblings are never
touched, and an unreadable directory degrades to "no sessions" rather than throwing.

## 8 — LOW-MEDIUM · The board entry is re-derived from the address, and silently skipped when it misses

`DashboardView.tsx:1598`:

```js
const target = lanes.find((l) => l.roleId && verdict.to === addresses.get(l.claudeSessionId ?? ''))
if (target?.roleId) { addRunningTask(...) }
```

`resolveDispatch` already knows the routed role (`route.role.id`) and does not return it, so the
caller reverse-engineers the target by matching addresses. If the lookup misses — a lane with no
`roleId`, a `claudeSessionId` that changed between the two reads — **no task is created at all**
while the lane is still told `send`. That is the same "delivered but invisible" shape the branch
sets out to fix, arrived at from the other side. Returning `targetRoleId` on the verdict removes
the guesswork.

## 9 — LOW · `launching` notifies the caller twice, once into a mid-turn pty

On `launching`, the caller gets the JSON verdict as its tool result *and*, a moment later,
`deliverDispatch`'s `feedback()` types `[Operator] The "X" lane wasn't running — Operator is
LAUNCHING it now…` into the caller's own pty via `submitQueue`. The caller is mid-tool-call, so per
`project_queued_prompts_no_user_turn` that becomes a queued message rather than a turn. Harmless,
but it is a second copy of information the tool already returned, arriving as pending user input.

## 10 — LOW · The poll runs for the app's whole life

`setInterval(500ms)` with no gating on whether any lane has the MCP config, whether any project is
open, or whether the table has ever had a row. It is an IPC round trip plus a SQLite read twice a
second, forever. The `if (!rows.length) return` guard correctly avoids `readBusSessions` in the
common case, so the cost is small — but it is unconditional, and an event or a longer idle interval
would cost nothing.

## Things I checked and found correct

- **Cross-project addressing through Operator.** `resolveDispatch` passes `req.projectId` into
  `routeDispatch`, which resolves the role against *this* project's roster and then calls
  `pickLaneTab(tabs, projectId, role.id)` — filtered on `t.projectId === projectId`. A live lane in
  another project is never a `send` target; naming a preset that exists elsewhere yields `queue` →
  a launch in *this* project. `projectId` originates from `OPERATOR_PROJECT_ID`, set by Operator at
  spawn, so a lane cannot forge it, and `mcp-serve.ts:242` refuses a caller with no project at all.
  The scoping is real. The account's caveat is also real and correctly stated: once a lane holds a
  `uds:` address it can send anywhere on the bus without asking, and it can read
  `~/.claude/sessions` itself. Operator's scope is a convention, not a boundary — and this branch
  now hands lanes socket addresses, which the sentinel path never did.
- **`create` is bounded.** `routeDispatch` only creates from `presetFor(roleToken)`, so an
  unrecognised token falls to `unassigned` rather than inventing a lane. The launch-without-brakes
  path is therefore capped at the preset list, not unbounded.
- **Route-before-brakes, as an ordering.** The argument holds: `evaluateDelivery` blocks any message
  to a lane that is not live, so consulting it before the route would refuse every launch. And the
  bypass it opens is narrow — a `launching` verdict costs no hop budget, but the lane is running
  afterwards, so the next dispatch to it is braked normally. One un-braked message per launch cycle
  is the exposure, and a lane cannot force a target to stop and re-arm it.
- **Verdict can't be applied twice or attached to the wrong request.** `answerDispatch` is guarded
  on `answered_at IS NULL`; `dispatchVerdict` reads by primary key; `lastInsertRowid` is
  per-connection, so two concurrent MCP servers cannot cross ids.
- **SQLite under contention.** `openDb` sets `journal_mode = WAL`, so the server's 100ms polling
  reads never block on the app's writes and vice versa; better-sqlite3's default busy timeout
  covers a write-write collision between two servers. `Atomics.wait` on the main thread is
  permitted in Node, and the 15s block is per short-lived server process, not shared.
- **The Tauri bridge stubs** return an empty request list rather than throwing, with an accurate
  reason (no lane there carries `--mcp-config`).

## Verdict — `operator/dispatch-bus`: do not merge yet

The design is right and the parts that exist are well made: the request/verdict protocol is sound
under concurrency, WAL removes the lock question, the project scoping is genuine, and the
route-before-brakes ordering is argued correctly rather than assumed. The account is honest that
nothing has run end to end.

Three things have to change first:

- **Finding 1** removes a guardrail that currently exists. Shipping the tool as-is gives every lane
  the authority the sentinel path denies it, and the tool's own description claims otherwise. This
  is the blocker.
- **Finding 2** means the branch's second headline — delivery confirmation — is not in it. Either
  wire `readDeliveryResult` (which needs `taskId` populated and a tailer change neither of which is
  here) or delete it and say plainly that a bus dispatch is fire-and-forget, so the next reader is
  not misled by a doc comment describing a feature that does not run.
- **Finding 3** is a five-line fix and without it a slow tick double-charges the brakes and doubles
  the board.

Findings 4–6 are small and worth the same pass; 4 in particular changes what happens on the first
launch after any downtime. 7–10 can follow. Given that nothing has run end to end, I would want the
two-lane manual test the account names as the gate on merge, not on the release after it.

---

# `operator/plan-bar`

## A — HIGH · `contextTokens` is not sidechain-guarded, in either tailer

`electron/src/main/transcript.ts:480`; `src-tauri/src/transcript.rs:580`.

In both files the new assignment sits inside the `usage` / message-id-dedup block, which is
*outside* the sidechain guard immediately above it. The Electron shape:

```ts
if (v.isSidechain !== true && typeof msg.model === 'string' && …) { this.model = msg.model }   // guarded
const usage = msg.usage …
if (usage) {
  if (mid && this.lastUsageMsgId !== mid) {
    …
    this.contextTokens = g('input_tokens') + g('cache_read_input_tokens') + g('cache_creation_input_tokens')  // NOT guarded
```

The Rust half is identical: `let is_side = …; if !is_side { …model… }` closes, and
`self.context_tokens = …` is assigned below it.

The guard is right there and the comment beside it states exactly the principle this violates — "A
SUBAGENT'S model is not the lane's model. Reading it from a sidechain turn would show the lane
running whatever its last subagent used."

**Failure scenario.** A lane sits at 780k of 200k… of its window, about to compact. It spawns an
Explore subagent. The subagent's first assistant record carries its own `message.id` and its own
`usage` — a fresh context of perhaps 15k. `contextTokens` is overwritten and the footer reports the
lane at 15k with a nearly empty bar. The main thread's next record puts it back near 780k. For the
whole duration of any subagent the cell flips between near-full and near-empty, and it is at its
most wrong exactly when the reading matters — a lane about to compact reads as fresh.

The cumulative `usage` totals are also unguarded, but that is pre-existing and arguably correct: a
subagent's tokens are the lane's cost. A "how full is the context right now" reading is a
single-thread quantity and mixing threads has no defensible reading.

Neither shell has a sidechain test for this field — the Rust suite covers "latest not a running
total" and "ignores a re-emitted message", and the Electron scenarios test adds the same two.

## B — MEDIUM · The 1M window cannot be detected from a transcript model, and I checked

`src/renderer/lib/model-config.ts` `contextWindowOf` matches `/\[1m\]/i` on the model id.
`contextReading` (`footer-reading.ts:33`) feeds it `session.model`.

`session.model` is `t.model ?? hookSession.model` (`DashboardView.tsx:3054`) — the tab's launch
value first, the transcript's observation as fallback. I checked what the transcript actually
carries: across every `.jsonl` in `~/.claude/projects` on this machine, the distinct
`message.model` values are

```
<synthetic>, claude-fable-5, claude-fable-5-1, claude-haiku-4-5-20251001,
claude-opus-4-7, claude-opus-4-8, claude-opus-5, claude-sonnet-5
```

Not one carries a `[1m]` suffix. So the marker can only ever arrive from `tab.model` — i.e. from a
roster pin or a hand-typed id in the toolbar's "Other…" field. A lane whose long-context model was
selected inside Claude Code (`/model sonnet[1m]` typed into the terminal) keeps its old `tab.model`
and gets the 200k denominator.

**Failure scenario.** A 1M lane at 400k reads as 200% full. `Bar` clamps at 100%, `toneFor` returns
`danger`, and the cell sits pinned at full red for four fifths of the lane's life. The code comment
promises the opposite — "so a `[1m]` lane is not reported as 84% full at 840k".

The fallback direction is defensible (the comment says a 200k denominator on a 1M model is "wrong
in the safe direction") but that is only true for a *brief* overrun, not for a lane that lives most
of its life past the mark. Whether Claude Code writes the marker into `message.model` at all is
unverified by the branch; the only evidence available says it does not.

## C — LOW-MEDIUM · There is no plan reading outside a session any more

`ProjectRail.tsx:1255-1270` removes `PlanMeter` from the rail foot. The branch states the cost
honestly in the replacement comment — "there is no plan reading outside a session until the same
component renders in the gallery/project header (the design's S3)" — so this is a scoped decision
rather than an oversight. Worth restating because the deleted component's own comment named this
exact case as its reason to exist: "Needs no session and no project … so it is live at the gallery
and on first launch, which is exactly when you are deciding what to start."

Two smaller consequences ride along:

- The "What's driving this →" link in the plan popover goes with it. That was the Tuning page's
  highest-value entry point by the usage-view design's own argument (the moment the question gets
  asked). `FooterReading`'s plan cell is now the replacement — the whole cell opens Tuning — but
  only while a session is open.
- The freshness affordances the popover carried (explicit Refresh, the "updated N ago" line)
  reduce to a 4px amber dot and a `title`.

## D — LOW · The `loading` state is unreachable

`planReading(limits, now, loading = false)` takes a loading flag and `PlanCellState` includes
`'loading'`, but `PlanCell` calls `planReading(limits, now)` (`FooterReading.tsx:166`) without it,
and `FooterReading`'s props (`:63`) have no `loading` at all — `DashboardView.tsx:4785` passes only
`limits` and `now`, though `planLimits.loading` is right there on the same object.

So during the 1200ms deferred first read plus however long `claude -p "/usage"` takes, the footer
shows a definitive "no reading" chip rather than a loading state. That is the one case where
"absent is not zero" is being applied to a value that is merely not back yet.

## E — NIT · `plan-limits.ts` opens by claiming to be the pure half

Line 1 is `import { useCallback, useEffect, useRef, useState } from 'react'`; line 2 begins "Plan
limits — the pure half. Everything the meter needs to decide, with no DOM and no bridge". The file
holds `usePlanLimits`, which is a hook that calls `window.operator.planLimits`. The pure rules are
genuinely pure and genuinely testable; the header just describes the wrong file now that the hook
moved in with them.

## Things I checked and found correct

- **The rail-foot invariants are not merely preserved — they are repaired.** On `main` the foot
  rendered Agents, Tuning *and* the plan meter at rest, five items, while `RESTING_FOOT_ITEMS`
  listed four (`agents, usage, gallery, open-folder`) and `drive-rail-invariant.mjs` asserted
  `data-rail-usage` and never looked for `data-rail-tuning`. Both the constant and the driver
  agreed with each other and disagreed with the DOM. This branch removes the meter and swaps
  `usage` → `tuning` in both, restoring four resting / four folded, both even, the fold's cut on a
  group seam. The removal is static, not conditional, which is the property the fold work exists to
  protect.
- **`SessionInfoBar.tsx` really was dead.** No import anywhere in `src/` on `df7bc46`; the only
  references were dev documents and one comment. Deleting it is right, and the branch replaces the
  comment that referenced it.
- **Click target.** All three plan rows live inside one `<button>` (`FooterReading.tsx:169-180`),
  so the whole cell is the target rather than the glyph — the lesson the rail driver's section T
  encodes. The effort and context cells are the same shape.
- **Style rules.** No `opacity` anywhere in `FooterReading.tsx`, so nothing stacks on `--fg-muted`.
  The chip is `background: transparent` with a token-coloured 1px border. The binding row is marked
  three ways — ink, bar colour, and a straight 1px rule — none of them a fill behind text. The only
  solid colour is the 3px meter fill itself, which is what a meter is; the old ring did the same.
- **Absent is not zero, on both axes.** `contextReading` returns `used: undefined` for a zero or
  missing count so the cell can draw `—`, and both tailers ship `contextTokens`/`compactions` as
  absent rather than `0`. `planReading` returns no rows at all for `no-reading` and
  `window-closed`, so no percentage is ever drawn from missing data. `windowEnded` is checked ahead
  of `loading`, with a good reason stated.
- **Only the binding row is marked**, computed once from `bindingLimit` and compared by key.
- **The tailers are otherwise in lockstep** on this field: same three-part sum, same
  assignment-not-accumulation, same message-id dedup, same absent-is-not-zero serialisation, same
  `compactions` counter, and `with_tuning` extended rather than duplicated.
- **`usePlanLimits` did not fan out.** It is called once in `DashboardView` (`:214`) and the values
  are passed to `FooterReading` as props, so there is no per-session `/usage` subprocess. The second
  instance in `TuningView` predates this branch and is served from the backend's 5-minute TTL.

## Verdict — `operator/plan-bar`: fix A, then merge

The design work is sound and the branch cleans up more than it adds: the rail-foot drift on `main`
is repaired, a genuinely dead file is removed, the click target and the style rules are right, and
the absent-is-not-zero rule is enforced at every point where it could have slipped.

**A is a blocker and a two-word fix** — move the assignment inside the sidechain guard in both
tailers, and add the test neither shell has. Without it the context cell is actively misleading
during any subagent run, which is a large share of a Code or Research lane's life, and it is
misleading in the direction that matters: a lane about to compact reads as fresh.

**B should be settled before merge but need not block it** — either confirm where the `[1m]` marker
actually appears and read it from there, or say in the code that the 1M window is detected only
from a pinned model id. What is not acceptable is the current comment, which promises a behaviour
the evidence says cannot happen.

C is a stated trade and the user's call, not a defect; D and E are small.

The two branches touch different files and merge independently; nothing here conflicts.
