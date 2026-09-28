# Review: retire a released lane on dispatch — 2026-09-27

Branch `operator/917d80` @ 8cc53fd, diffed against fe6029e. Read with `git show`; not checked out.
The branch's own tests were run from an extracted copy (`git archive`) against the main
checkout's `node_modules`: roster, bus-name, dispatch, dispatch-bus and lane-workspace suites,
169 tests, all pass. Nothing was run in the app.

Line numbers are in the branch's files.

## Findings, most severe first

### H1. A retire ends a lane that took new work after `worktree_done`

`src/renderer/lib/dispatch.ts:203`, `:212-222` (markReleased);
`src/renderer/views/DashboardView.tsx:2045-2053`.

Once a lane calls `worktree_done`, its `worktree_release` row stays open until its pty exits.
Nothing clears it if the lane then takes more work. Three paths still put work into a released
lane, and the result note says so:
- human Send, `sendProjectTask` and Start all type into the live tab directly;
- RosterPanel Launch and the hub card go through `handleLaunchRole`, whose reuse guard picks the
  released tab;
- a sentinel dispatch in the first 4 s after `worktree_done`, before the cache refreshes, routes
  `send`.

In each case the lane works on in its released directory, and the release flag stays on. The first
coordinator dispatch that lands during a pause between turns (`waiting`) then gets `retire`, and:
- `handleCloseSession(session)` kills the session and forgets the saved record, so the thread
  cannot be resumed;
- `completeTerminalTasks(..., 'done')` marks the lane's running tasks done, including the
  human-assigned one, and runs the verification gate for them;
- the worktree is WIP-committed and removed.

Failure scenario:
1. Code releases its worktree.
2. The user presses Launch on Code with a follow-up. The released tab is reused.
3. Code asks the user a plain-text question and goes `waiting`.
4. The coordinator dispatches anything to Code. The follow-up session is killed and its task shows
   `done`.

The lane lifecycle already has the rule this path needs, at `DashboardView.tsx:3537-3538`: "A lane
that took new work invalidates its old report". The retire has no equivalent. For example,
`released` could be dropped for a tab that has running tasks stamped after the release's `at`, or
the release could be dropped when a turn starts after it.

### H2. With a duplicate lane on the role, the relaunch types the brief into that other lane instead of a fresh one

`src/renderer/views/DashboardView.tsx:2903-2910`.

After the retired tab is closed, `handleLaunchRole` excludes only that tab (`replacing`) and runs
`pickLaneTab` over the rest. The file says roles held 4-5 duplicates in the real store, and
`--2` instance naming exists. If another live tab has the same project and role, it becomes
`existing` and the brief is `submitQueue.submit`-ted into it:
- if that tab is also released, this types work into a released lane, which is the case retire
  exists to prevent;
- if it is mid-turn, the brief queues behind the current turn.

The coordinator is still told "ENDED that session and is LAUNCHING a fresh one, in a new
worktree" (`:2066`), and the bus says the same. No new worktree is created. The reuse check here
ignores both `released` and phase.

### M1. The `finishing` refusal has no brake and no idle signal, and on the sentinel path it drives itself

`src/renderer/lib/dispatch-bus.ts:181-190`; `src/renderer/views/DashboardView.tsx:2016-2022`;
`src/renderer/lib/dispatch.ts:203`.

- Bus: the coordinator gets `refused` with "Retry this dispatch once it is idle". Nothing is
  charged, and the coordinator has no way to observe idleness. It can only poll by calling again,
  and each call is answered in about 500 ms.
- Sentinel: `feedback()` types "Dispatch again once it is idle" into the coordinator's pty. That
  starts a new coordinator turn, which emits the same `OPERATOR-DISPATCH` and gets the same answer.
  This is a loop with no human in it that lasts until the lane goes idle. The brakes do not apply
  to it.

How long the loop runs depends on the lane's phase:
- `asking` means an open `AskUserQuestion` on the released lane, and it lasts until the user
  answers, which can be hours.
- An unknown phase (no tracked session, or the session reads `ended` while the tab is live) never
  resolves.

A per-(project, role) cap on consecutive `finishing` answers would stop it. So would a single
automatic re-route when the lane's phase turns idle, bounded to one attempt.

### M2. Retire overrides main's "keep a dirty released worktree" rule

`src/renderer/views/DashboardView.tsx:3305-3325` against
`electron/src/main/worktree-reap.ts:1663-1690`.

`worktree_done` tells the lane: "If anything unsaved appears before then, the worktree is kept
instead." `releaseWorktreeOnExit` implements that: a dirty tree at exit settles the row as `kept`.
The retire goes through the user-close path, which does the following once `finishTasks` resolves:
1. Snapshots uncommitted files as "WIP preserved before reaping this worktree".
2. Calls `worktreeRemove`.

The directory is therefore removed even though main recorded `kept`. The WIP commit lands on a
branch the coordinator may already have merged, where nobody will look for it.

Separately, for a clean tree, main removes the directory at exit while `completeTerminalTasks` is
still capturing the diff and running `runTaskChecks` in that directory. If the lane had any
running tasks, their verification runs against a directory that is being deleted.

This already happened when the user closed a released lane. The branch makes it the automatic
path for every released lane that gets a follow-up dispatch.

### M3. An approved held dispatch that routes to `finishing` drops off the board with no action left

`src/renderer/views/DashboardView.tsx:1998-2000`, `:2016-2022`;
`src/renderer/components/session/TaskBoard.tsx:70`; `src/renderer/lib/dispatch-outcome.ts:40`.

Approval, Retry (`undelivered`) and Assign (`unassigned`) all call `deliverDispatchRef` with
`approving: true`. If the target is released and mid-turn:
- `setDispatchOutcome(..., 'finishing')` overwrites `pending-approval`, and it drops the `note`
  because it takes none;
- `finishing` is not in `WAITING_OUTCOMES`, so the card leaves Waiting;
- `approveDispatch` requires `pending-approval`, so the dispatch cannot be approved again;
- `canDismissDispatch('finishing')` is false;
- the feedback line goes to the sending non-coordinator lane and tells it to "Dispatch again".
  That lane's dispatch would only be held again.

The work survives only as a chip in the comms log. The result note mentions this case, but it
presents it as handled by the toast and the chip. With no button left, the user has to re-type
the task.

### M4. RETIRE_NOTE holds only inside the 10-minute keep-warm window

`src/renderer/lib/roster.ts` (`RETIRE_NOTE`); `src/renderer/views/DashboardView.tsx:3561`;
`src/renderer/lib/lane-lifecycle.ts:169` (`DEFAULT_KEEP_WARM_MINUTES = 10`).

`worktree_done` writes a `done` status, so the lane lifecycle closes a released idle lane after
10 minutes, by default, with `suspend = 'reported-done'`. That keeps a suspended record carrying
the released branch. A dispatch after that routes `queue`, and `replacing` is unset, so
`suspendedToResume` returns the record. The lane resumes the released thread in a worktree
reattached to the released branch, which may already be merged.

The coordinator is told "Operator ends a lane that called `worktree_done` and launches a fresh
one". That is true for a dispatch within 10 minutes and false after, and a follow-up after a
review usually arrives after. The result note flags the interaction as out of scope. The note
added to the coordinator's brief states the opposite as a rule. One fix is for the lifecycle to
close a released lane without `suspend`.

### L1. An error inside the retire IIFE loses the task after the bus has already answered `launching`

`src/renderer/views/DashboardView.tsx:2046-2061`.

`await handleCloseSessionRef.current(session)` and the launch have no try/catch. If either rejects
(for example `terminalKill` IPC):
- `trackOrQueue` never runs, so the task is neither running nor queued;
- joiners' `inflight.then(...)` handlers never run, so their tasks are lost too;
- the rejection is unhandled.

A throwing launch already had this problem. The close adds a second place where it can happen,
on a path the bus has already reported as started.

### L2. The retire decision uses a phase snapshot of up to about 1 s

`src/renderer/lib/dispatch.ts:203`.

`waiting` comes from the 1 s tailer while the pty is quiet. Two things can be lost when the lane
is killed:
- A submission already in `submitQueue` for the released lane, such as an OPERATOR-REPLY or a
  report-inbox line waiting for the turn boundary.
- A prompt a human typed in the last second, before it reaches the transcript.

### L3. On the bus, a second request in the same tick can be refused `finishing` when it should join the relaunch

`src/renderer/views/DashboardView.tsx:1792-1810`.

`tabs` is read once before the loop. The loop awaits `answerDispatch` between requests. If the
first retire's kill has turned the session `ended` by the time a later request resolves, the stale
tab still reads as released, now with no phase. The request is answered `finishing` instead of
`launching` and joining the in-flight relaunch. The coordinator retries, so the only cost is an
extra round trip and a misleading reason.

### L4. Approving a held dispatch can end a lane without saying so

Approval runs the same router. If the target is released and idle, approving a Review → Code
dispatch kills the Code session. The held card and toast say only "wants to dispatch to Code".

### L5. Note-size guards

Measured on the branch:

| Note | `proj` | `mantel` | long name |
|---|---|---|---|
| Coordinator, without bus note | 3938 (guard 4000) | 3940 | 3961 (`uwazi-app-frontend-monorepo`) |
| Coordinator, with bus note | — | 4389 (guard 4400) | 4452 |

The raises match the text added (RETIRE_NOTE plus "or if it says to", about 175 characters), and
lane notes are unchanged. The bus-name guard leaves 11 characters of headroom, so the next edit of
a dozen characters to the coordinator note will fail it. The guard uses a fixed fixture name, so
real project names are not the issue. `bus-name.test.ts:92-93` still says "the longest is Infra"
above the line that corrects it.

The new clause "retry only for a bad lane name or if it says to" now also covers the brake reason
at `agent-delivery.ts:224`: "It can send again once you type into its terminal…". That sentence
does not tell the coordinator to retry, but a model may read it as permission. This is minor and
not verified.

## Checked and clean

- **Another project's tab.** `markReleased` requires terminal id, directory and, when the row
  names one, project id. `pickLaneTab` is scoped to the project and to its path (`tabRunsIn`). The
  session lookup at `:2049` is by terminal id, and main keys `Transcript.tracks` by terminal id,
  one track per id per run. No path found that retires another project's lane.
- **Stale terminal ids.**
  - Rows are scoped to `process.pid`.
  - Terminal ids are a per-run counter and are not reused within a run.
  - A renderer respawn keeps main's ids.
  - Until the first `pendingReleases` read after a respawn, nothing is released, which routes
    `send` as before.
  - A reattached tab that lacks `worktreeBranch` or `sourceCwd` is never marked.
- **The 4 s cache.** It can only be stale toward "not released":
  - Rows settle only after the pty exits, and by then the tab is gone.
  - The bus tick re-reads the rows before routing.
  - The row's `path` is `join(worktreeRoot, name)`, which equals `OPERATOR_LANE_CWD` exactly,
    because `gatherFacts({ only })` filters on that join. Its comparison with `tab.cwd` is sound.
- **Relaunch into the released worktree.** Nothing reuses it:
  - `replacing` excludes the dead tab;
  - `suspendedToResume` returns nothing;
  - `worktreeCreate` gets no branch and makes a new path;
  - `releaseWorktreeOnExit` and the renderer's `worktreeRemove` act only on the old path.
  - The one exception is M4, which is not this code path.
- **Double launch on a burst.**
  - Sentinel and bus both re-route in `deliverDispatchRef`.
  - `launchingLanesRef` is set synchronously before the first await, so a second dispatch joins
    it whether it routes `retire` (old tab still present) or `queue` (old tab removed).
  - The close runs before `launchInFlightRef` is set, so a human Launch during the close could
    spawn beside it. That window is a few milliseconds of IPC. Not listed as a finding.
- **Bus answer against delivery.** `resolveDispatch` and `deliverDispatchRef` run in the same
  synchronous block for one request, so the bus answer and the delivery cannot disagree for that
  request. L3 covers the case across several requests.
- **Authority gate.** It still runs before retire and finishing on the bus. On the sentinel path,
  routing is only used to name the target in the held record.
- **Tauri bridge.** `pendingReleases` returns `[]`, so nothing is ever released there.
- **Preload.** The optional call chain short-circuits cleanly if the method is missing.

## Recommendations for the coordinator

- H1 and H2 are for Code, before merge:
  - clear or ignore a release once the lane takes new work;
  - make the relaunch skip every live tab for the role, or refuse a tab that is released or busy,
    instead of reusing it.
- M1 and M3 are for Code: cap repeated `finishing` answers, and keep an approved `finishing`
  record actionable (keep it in Waiting and allow it to be approved again).
- M4 is the user's decision: should the lifecycle suspend a released lane at all? Until that is
  decided, RETIRE_NOTE overstates what happens.
- GUI verification of a retire, including a burst of two dispatches, is the user's or QA's.

---

## Round 2 — 5406dfd

Reviewed with `git show 5406dfd` and `git diff fe6029e..5406dfd`, not checked out. Line numbers
below are in 5406dfd.

Tests run from an extracted copy (`git archive 5406dfd`):
- all of `src/renderer/lib`: 96 files, 1428 tests pass;
- `electron/src/main/{transcript,worktree-done,chat-store}.test.ts`: 97 tests pass.

Nothing was run in the app.

**Verdict: not merge-ready.** One new high-severity defect, R2-1. I missed it in round 1: it is
present in 8cc53fd as well. H1 is only partly closed (R2-2).

### Round 1 findings, re-checked

| Finding | Status | Evidence |
|---|---|---|
| H1 retire kills a lane that took work | **Partly closed.** See R2-2 and R2-3 | Main cancels on a transcript prompt newer than the release, and the renderer cancels on `submitQueue.submit`. Every human and Operator submission path goes through `submitQueue` (the only direct `terminalWrite` is file-drop paths, which the transcript cancel covers). `settling` covers keystrokes (10 s), pending submissions and recent transcript activity (3 s). |
| H2 brief typed into a duplicate | Closed | `reusableLane` returns nothing when `replacing` is set (`dispatch.ts`; `DashboardView.tsx:3008`). |
| M1 `finishing` loop | Closed on the sentinel path; mitigated on the bus | Sentinel: repeats record the refusal and type nothing (`finishingDelivery`), so no new coordinator turn starts. Bus: a repeat is still answered at once and uncharged. It now says "Do not dispatch to it again before then", and polling inside one turn is up to the model. |
| M2 renderer overrides main's keep rule | Closed for automatic closes | `releasedClosePlan`: a released lane gets no renderer snapshot or removal. An automatic close finishes tasks before the kill. A user close still kills first, as the commit says. Within 4 s of `worktree_done` the cache still reads "not released", so a user close then takes the old snapshot-and-remove path. |
| M3 approved dispatch stranded | Closed, with one gap | The approval path returns before `record()`, so the card stays `pending-approval` and can be approved again. The watch's toast tells the user. Gap: see R2-7. |
| M4 lifecycle suspends released lanes | Closed for the lifecycle path | It now ends them (`DashboardView.tsx:3688-3703`). R2-3 describes a way the lane can stop counting as released first. |
| L1 IIFE errors | Closed | try/catch queues the task; joiners resolve to `undefined` and queue their own. |
| L2 phase snapshot | Closed as far as it can be | `settling`. |
| L3 stale `tabs` per tick | Closed | Read per request. |
| L4 approval ends a lane silently | Closed | Held toasts say approving ends the released lane. |
| L5 note size, retry clause | Closed, with a nit | The retry clause is reverted. Measured: coordinator 4008 (`proj`, guard 4200) and 4459 (`mantel` with bus note, guard 4600). The comments match those numbers. Nit: the new comment says the headroom is for longer project names, but both guards use fixed fixture names, so real names never reach them. |

### New findings, most severe first

#### R2-1 (High). A coordinator's bus `reply` to a released lane retires it and launches a fresh lane with the reply line as its task

`src/renderer/views/DashboardView.tsx:1836-1990` (bus tick); `src/renderer/lib/dispatch-bus.ts:171-203`;
`electron/src/main/mcp-serve.ts:295-310`.

`mcp__operator__reply` writes into the same `dispatch_requests` table as `dispatch`, with
`kind: 'reply'`. The tick passes each request to `resolveDispatch` without its kind. The only place
the kind is read is the `send` branch (`r.kind !== 'reply'`, `:1953`).

When the coordinator (the only role that passes the authority gate) sends a reply to a released
lane, what happens depends on the lane's phase:
- **Idle:** the route is `retire`. The verdict is `launching`, and `deliverDispatchRef` ends the
  lane and launches a new one whose opening brief is the reply text (for example "Merged, thanks").
  A running board task is filed for it.
- **Busy:** the route is `finishing`. The reply is refused with "Do not dispatch to it again", a
  watch opens, and the coordinator is later told "Code is idle now. Dispatch your task to it
  again".

A coordinator acknowledging a lane that has just reported done and released is exactly when this
happens. Before this branch, a reply to a live lane routed `send`.

A related pre-existing problem: a reply to a lane that isn't running already launches it, which
contradicts REPLY_PROTOCOL ("dropped if the lane isn't running").

Fix: pass `kind` into `resolveDispatch`. A reply should never produce `retire`, `finishing`,
`queue` or `create`. It should be `send` to the live lane, or `refused` when there is none.

#### R2-2 (Medium). Work queued before `worktree_done` and taken up after it does not cancel the release

`electron/src/main/transcript.ts:382-390` (`applyQueueOp`), `:393-396` (`notePrompt`);
`electron/src/main/chat-store.ts` (`cancelReleasesBefore`, `at < promptAt`).

A prompt typed into a lane mid-turn leaves only a `queue-operation: enqueue` record. The file's own
comment says it is never followed by a `user` record. Its timestamp is the enqueue time.

Failure scenario:
1. The coordinator sends task B to Code while Code is finishing task A. Code is not released yet,
   so the route is `send`, and the prompt is enqueued at T1.
2. In the same turn Code calls `worktree_done` for A at T2 > T1.
3. Code then works on B.
4. Main's cancel requires a prompt newer than T2, and there is none. The renderer's cancel ran at
   T1, when no release existed.

The release stays open. While working on B across turns, Code hits a `waiting` gap (for example a
plain-text question). The next coordinator dispatch then retires it and marks B done, which is
H1 again. If Code ends cleanly, main removes the worktree with B's commits on its branch, which is
survivable.

Fix options:
- stamp the prompt at the time the queued item is consumed (check with the installed CLI whether
  it writes a `dequeue` or `remove` operation);
- treat any queued item still unconsumed at release time as new work.

#### R2-3 (Medium). Any line typed into a released lane un-releases it, including Operator's own notices and replies

`src/renderer/views/DashboardView.tsx:1640-1647` (`onSubmission`); `electron/src/main/index.ts:301-306`;
`transcript.ts` `isInjectedTurn`.

The cancel does not look at what was submitted. Each of these ends the release:
- an OPERATOR-REPLY sentinel from the coordinator ("Merged, thanks"), which the reply path types
  with `tabs.find(... !t.ended)` (`:1724`);
- a `[Operator] Held for approval …` note sent to a released lane that dispatched;
- a bus `SendMessage` arriving as a user record (`<cross-session-message>` is not in
  `isInjectedTurn`).

Once the release is gone, the lane is an ordinary idle lane on its released, often merged branch:
- the next dispatch routes `send` into it, which is the problem this branch set out to fix;
- the lifecycle closes it with `suspend`, which brings M4 back;
- nothing removes the worktree at exit. The row is settled `cancelled`, so the directory is left
  to the renderer close path, which snapshots it and removes it.

The first bullet is the common sequence: Code releases, the coordinator merges and acknowledges.

Fix options:
- only cancel on a submission that carries work (a dispatch, a board Send, a Launch);
- exclude Operator's own `[Operator]` lines and replies from both cancels.

#### R2-4 (Medium). An abandoned retire leaves two live lanes on the role, and the coordinator was told the old one ended

`src/renderer/views/DashboardView.tsx:2119-2131` (close runs beside the launch), `:3417-3428`
(`still` re-check).

The fresh lane launches at once, while the old lane's close does the following:
1. `finish()` runs the diff capture and verification gate, which takes minutes when the lane had
   running tasks.
2. The close re-reads the release. If the release was cancelled meanwhile, it returns `false` and
   the old lane is left running.

The release gets cancelled by any submission to the old lane (R2-3). Human Send and replies do not
honour `retiringRef`, because they use `terminals.find`. An IPC error in the re-read also returns
`false`, and the toast then wrongly says "took new work".

After `retiringRef.delete`:
- both lanes are routable;
- `pickLaneTab` alternates between them by recency, which is the duplicate state the file calls
  damage;
- the coordinator's feedback already said the old session was ENDED (`:2152`), and only the user
  gets a toast.

Fix options:
- when the lane has no running tasks (the usual case, and `finish()` is then instant), re-check and
  kill before launching the fresh lane;
- only run the slow path beside the launch when checks must run, and on abandonment tell the
  coordinator.

#### R2-5 (Low). The lifecycle's close of a released lane is not registered in `retiringRef`

`src/renderer/views/DashboardView.tsx:3688-3703`.

- A dispatch that arrives while that close is in `finish()` routes `retire` and starts a second
  close, which kills immediately.
- The "Closed X — released its worktree" toast is pushed even when the close is abandoned.

The window is small, because the lifecycle only closes lanes with no running tasks.

#### R2-6 (Low). Renderer respawn in the middle of a retire

`retiringRef`, the pending close and `finishingRef` all live in renderer memory. After a respawn the
old released lane stays alive beside the fresh one until the lifecycle ends it (10 minutes). The
refusal text covers the lost watch ("If no message arrives within 30 minutes, dispatch again").

#### R2-7 (Low). Watch bookkeeping

`src/renderer/lib/retire-watch.ts:53-72`.

- **One key per role.** The book has one key per (project, role). A refusal against a different
  lane of the same role replaces the open watch, and the first watch's dispatchers never get their
  promised message.
- **Approval merged with the coordinator's watch.** When an approval (empty `notify`) merges into
  a coordinator's open watch, the message goes to the coordinator only. The user is never told the
  held dispatch can be approved again, because the toast fires only when no notify terminal is
  live (`DashboardView.tsx:1661-1663`).

### Checked in round 2 and clean

- **Timestamp ordering.** Both sides use `toISOString`/CLI ISO-Z strings, and `at < promptAt` is a
  sound string comparison. The prompt that started the releasing turn is older than the release,
  so it never cancels it. Each tailer tick emits a new prompt once (`emittedPromptAt`).
- **Tool results are not prompts.** `userPromptText` handles tool-result-only content before
  `notePrompt` is reached, so a lane's own `worktree_done` result does not cancel its release.
- **Injected turns** (`<system-reminder>`, `<task-notification>`, command records) are excluded.
- **The renderer's cancelled-row filter** (`liveReleases`) keeps a later `worktree_done`
  (`r.at > cancelledAt`).
- **The watch** fires once and is deleted before sending. The `unseen` timeout tells the
  coordinator to stop and involve the user. The 30-minute cap holds.
- **The keep-warm lifecycle** ends a released lane with no suspend, and skips a lane already being
  retired.
- **The retire** marks the lane in `retiringRef` before any await. Routing then reads it as ended,
  so a burst joins the in-flight launch.

### Recommendations for the coordinator

- **Code, before merge:**
  - R2-1: pass the request kind into `resolveDispatch`, so a reply never retires or launches;
  - R2-3: cancel a release only for work, not for notices and replies;
  - R2-2: handle a prompt queued before the release.
- **Code:** R2-4, kill before launching when no checks need to run.
- **The user or QA:** GUI-verify one retire, one `finishing` → idle message → re-dispatch, and one
  coordinator reply to a released lane.

---

## Round 3 — 8a9ca5a

Reviewed with `git show 8a9ca5a` and `git diff fe6029e..8a9ca5a`, not checked out. Line numbers are
in 8a9ca5a.

Tests and typecheck from an extracted copy:
- `src/renderer/lib` and `src/shared`: 103 files, 1557 tests pass;
- electron `transcript`, `worktree-done` and `chat-store`: 99 tests pass;
- root `tsc --noEmit` is clean.

Nothing was run in the app.

**Verdict: not merge-ready as it stands, because of R3-1, which is about a one-line fix.** With
R3-1 fixed, I consider the branch merge-ready. R3-2 to R3-6 can follow. It still needs one GUI
pass.

### Round 2 findings, re-checked

| Finding | Status | Evidence |
|---|---|---|
| R2-1 reply retires or launches | Closed | `kind` reaches `resolveDispatch` (`DashboardView.tsx:1884`). A reply goes to the live tab (`send`, `retire` or `finishing` all resolve to that tab), and with no live lane it is refused. It never reaches the launch, retire or watch branches (`dispatch-bus.ts:139-148`). |
| R2-2 queued-before-release work | Closed | The take-up time is now the `remove` record, or the `user` record for an idle lane. The `enqueue` no longer counts. I checked this against the local transcripts in `~/.claude/projects` (details below). |
| R2-3 replies and notices cancel a release | Closed, one gap | Both cancels use `isWorkPrompt`. The sentinel reply is now typed with `replyPrefix` (`:1787`). Bus messages are unwrapped from `<cross-session-message>`. Gap: R3-2. |
| R2-4 two lanes after an abandoned retire | Closed for the dispatch path | The close is awaited and the launch happens only on `closed` (`afterRetireClose`). `took-work` sends the task into the old lane and `unconfirmed` leaves it queued. Both correct the record and tell the dispatcher. What remains is R3-4 and R3-5. |
| R2-5 lifecycle close not registered | Closed | It is added to `retiringRef`, and the toast only shows on `closed` (`:3755-3766`). |
| R2-6 respawn mid-retire | Closed for the task; the record is wrong | The task is queued before the first await, so a respawn cannot lose it. The next launch of the role picks it up. The record still says `launched` ("delivered") until then (R3-6). |
| R2-7 watch bookkeeping | Closed | Watches are keyed per lane, and `toastUser` is sticky once an approval joins. |

**How I checked the `remove` timing.** I sampled 150 local transcripts that contain `remove`:
- 2343 non-injected `remove` records were found;
- 1215 were followed, within the next records, by a `queued_command` attachment with the same text;
- 107 were followed by an attachment for a different prompt, from back-to-back removes;
- the remaining 151 were removes in a run whose attachments came after my scan window stopped.

A prompt pulled back into the composer is written as `popAll` (1 instance), not `remove`. So
`remove` means "taken up by the running turn", and a popped prompt counts later as a `user`
record.

### New findings, most severe first

#### R3-1 (Medium). A bus reply from a caller with no known role now arrives labelled "reply from Operator"

`src/renderer/views/DashboardView.tsx:1882`; `src/renderer/lib/dispatch-bus.ts:139-148`, `:407-418`.

- `dispatchSender` returns `fromRoleId: 'unknown'` when neither the request nor the tab gives a
  role. That covers a session opened in a project outside the roster, and a lane whose role was
  removed from the roster.
- The tick labels the sender `roster.find(...)?.name ?? 'Operator'`.

Before this commit, such a caller's reply was held for approval, because
`dispatchNeedsApproval('unknown')` is true, so the default label never reached a lane. Now replies
skip the gate. The target reads `[Operator · reply from Operator] …`, which is the coordinator's
name and authority.

The sentinel reply path does not allow this: it requires `from` to be a roster role (`:1741`). So
the bus reply is now laxer than the sentinel it is meant to match.

Fix: refuse a reply whose sender has no roster role, or label it with the raw role id or "an
unlabelled session".

**Is dropping the approval hold safe otherwise?** Yes. Apart from the label, a bus reply now has
exactly the sentinel reply's power:
- it is scoped to the project;
- it goes to a live lane only;
- it is charged against the brakes (`sendTo` → `evaluateDelivery`);
- it creates no board task (`r.kind !== 'reply'`, `:1953`).

A non-coordinator can still ask another lane to do something through a reply. That was already
true through OPERATOR-REPLY and plain `SendMessage`, so nothing new is opened.

#### R3-2 (Medium). Work sent as a reply never cancels a release

`src/shared/prompt-kind.ts:32-35`.

`isWorkPrompt` decides by the prefix, not by what the message says. REPLY_PROTOCOL tells lanes to
reply when "the message changes what that lane should do next". So a coordinator reply such as
"Review found X — fix it on your branch" to a released Code lane:
- is delivered, as intended;
- starts a working turn;
- leaves the release open.

If that work spans turns, the next dispatch that lands in a `waiting` gap retires the lane in the
middle of the fix. This is H1 again, through the one route that is exempt. If the lane ends
cleanly, main removes the worktree at exit.

The reverse direction is sound: nothing Operator types as a notice or reply can be taken for
work, and a human or a dispatch is never taken for a notice unless the text starts `[Operator] `
or `[Operator · reply from `.

Fix options:
- tell the coordinator in RETIRE_NOTE that follow-up work for a released lane must be dispatched,
  not replied;
- have main count a reply as work when the lane's turn runs tools after it. That is harder.

#### R3-3 (Low). A `took-work` result can be a lane that died, and the task is then typed into a dead pty

`src/renderer/views/DashboardView.tsx:3471-3475`, `:2181-2188`.

The re-read after `finish()` treats "no open release" as `took-work`. A release row is also
settled when the pty exits. So if the user closes the lane, or it crashes, while `finish()` runs
its checks (minutes when it has running tasks), the retire:
- submits the task into the dead terminal;
- marks the task running on it;
- records `sent`;
- tells the coordinator the task "was sent into that lane".

Fix: check `tab.ended` or the session status before choosing `send-to-old-lane`. If the lane is
gone, launch instead.

#### R3-4 (Low). Dispatches that join a retire that ends without a launch are queued, while their record says `launched`

`src/renderer/views/DashboardView.tsx:2129-2136`.

A second dispatch during the retire's close routes `queue`, because the old lane reads as ended,
and joins the in-flight retire. On `took-work` or `leave-queued` the retire resolves to
`undefined`, and the joiner queues its task. But:
- the bus already answered `launching`, and the record says `launched`;
- no feedback reaches the joiner;
- the old lane is live, so nothing spawns the role to pick the queued task up.

The task is visible on the board, but it waits for a human. Fix: on `send-to-old-lane`, resolve
the in-flight promise with the old tab so joiners go into it too. On `leave-queued`, give joiners
the same correction the first dispatch gets.

#### R3-5 (Low). The lifecycle-close vs dispatch window for two lanes still exists

`src/renderer/views/DashboardView.tsx:3755-3766`.

The lifecycle's close adds the lane to `retiringRef` but not to `launchingLanesRef`. A dispatch
during that close routes `queue`, finds nothing in flight, and launches a fresh lane at once,
without waiting for the close. If the close then returns `took-work` or `unconfirmed`, two lanes
are live.

The window is short. The lifecycle only closes lanes with no running tasks, so `finish()` returns
quickly, and the window is two IPC round trips plus the kill. Fix: have the lifecycle's close
register a `launchingLanesRef` entry that resolves after the close, or let `queue` wait on a
pending close.

#### R3-6 (Low). Wrong labels on the retire's fallback records

- **The `queued` chip.** `leave-queued` and "no session" write outcome `queued`, which
  `chipForOutcome` shows as "not delivered · lane wasn't running". The lane *was* running.
  `setDispatchOutcome` takes no note, so nothing records why. `queued` is also not in
  `WAITING_OUTCOMES`, so the only sign of it is the task on the board. The comment on `queued` in
  `dispatch-outcome.ts` still says its only writer is the reply path. Fix: a separate outcome with
  its own label, for example "queued · lane could not be ended".
- **The record after a respawn.** After a respawn mid-retire (R2-6), the record stays `launched`
  ("delivered") while the task sits queued.

### Checked in round 3 and clean

- **Prefix separation.** `replyPrefix` and `deliveryPrefix` differ only in "reply"/"message".
  Nothing else in `src/` or `electron/src/` parses either prefix. The brakes and
  `reportUndelivered` match by the task suffix, so switching the sentinel reply to `replyPrefix`
  breaks no matcher.
- **The watch's own lines** start `[Operator] `, so a message to a released dispatcher cannot
  cancel its release.
- **Retire ordering.** The task is queued before the first await. The launch uses the `project`
  captured at dispatch time, which does not yet contain the queued task, so the fresh lane's brief
  does not carry it twice. `markTasksRunning` then claims it. The `catch` does not queue a second
  copy (`if (!queuedId)`).
- **User close.** It now reads the release fresh before deciding, which closes the 4 s-cache gap I
  noted in round 2 under M2.
- **Replies routed to released lanes** keep the lane released, because a reply is not work. While
  a reply is still pending in the submit queue, the lane reads as `settling`, so it is not retired
  under it.

### Recommendations for the coordinator

- **Code, before merge:** R3-1, one line in the tick or in `resolveDispatch`.
- **Code, after merge is fine:**
  - R3-2: a RETIRE_NOTE sentence saying follow-up work for a released lane is dispatched, not
    replied;
  - R3-3: check that the lane is alive before `send-to-old-lane`;
  - R3-4: hand joiners the retire's actual result;
  - R3-6: a distinct outcome for "queued because the lane could not be ended".
- **R3-5** is small enough to leave until something shows it happening.
- **The user or QA:** GUI-verify one retire, one `finishing` → idle message → re-dispatch, and one
  coordinator reply to a released lane, which must stay released.

---

## Round 4 — d4d07ec, merged to main at 5a390f0 (2026-09-28)

The branch was merged before this round. I reviewed d4d07ec with `git show`. Tests and typecheck
ran from an extracted copy of 5a390f0:
- root suite: 112 files, 1663 tests pass;
- `tsc --noEmit` is clean;
- electron suite: 44 of 45 files pass (790 tests). The one failure, `port-ranges.test.ts`, is an
  artifact of my extraction: it imports `scripts/renderer-port.mjs`, which I did not copy. In the
  real checkout it passes (12 tests).

Nothing was run in the app.

### Round 3 findings, re-checked

| Finding | Status | Evidence |
|---|---|---|
| R3-1 role-less reply labelled "Operator" | Closed | A reply whose `fromRoleId` is not on the roster is refused before routing (`dispatch-bus.ts:140-153`). |
| R3-2 work sent as a reply | Closed by guidance | RETIRE_NOTE now says follow-up work for a released lane is a dispatch, never a reply. A reply still does not cancel a release, so a coordinator that ignores the note can still get a lane retired mid-task. The size guards hold (4063 / 4514). |
| R3-3 dead lane read as took-work | Closed | `afterRetireClose(closed, alive)` launches when the old tab is gone or ended, or its session has ended. |
| R3-4 joiners kept a wrong record | Closed | The in-flight promise resolves to `{tab, via}`. Joiners follow the task into the fresh lane or the old lane, or queue it, and each gets its own record correction and feedback. |
| R3-5 lifecycle vs dispatch window | Accepted by Code, as I recommended | — |
| R3-6 wrong chips | Closed | New outcomes `retiring` ("queued · ending the released lane first", written before the close) and `not-retired` ("queued · lane could not be ended"). |

### Remaining, all Low

- **R4-1.** After a renderer respawn during a retire, the record stays `retiring` for good. A later
  launch of the role picks up the queued task, but it is a different dispatch, so the record is
  never corrected. The chip is still true when written, and it goes stale once the task runs.
- **R4-2.** The alive check reads `terminalsRef` and `sessionsRef`, which update on render and on
  the 1 s tailer. Main broadcasts the pty exit before the release settles, so the order is
  normally right. A render that has not flushed by the time the release re-read returns would
  still read a dead lane as alive. The window is a single frame.

### Verdict

Nothing blocking remains on main. H1 and H2 from round 1 were fixed in 5406dfd and 8a9ca5a, and
checked in rounds 2 and 3. There is nothing to send to Code. What is left is a GUI pass by the user
or QA: one retire, one busy lane → idle message → re-dispatch, and one coordinator reply to a
released lane, which must stay released.
