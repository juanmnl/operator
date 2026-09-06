# Result — dispatch and reply over Claude Code's session bus (Code lane), 2026-09-06

Brief: `dev/briefs/dispatch-over-bus.md`. Spike: `dev/results/session-bus-spike.md`.
Branch `operator/dispatch-bus` from `main` at `df7bc46`.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1089 pass / 0 fail** |
| `cd electron && npm test` | **508 pass / 0 fail** |
| `cargo test` | **188 pass / 0 fail** |
| root + electron `tsc` and `build` | clean |

---

## Two corrections to the brief, both verified

**The tool names are bare.** The brief specifies `operator__dispatch` / `operator__reply`.
`mcp-serve.ts`'s own recorded experiment says otherwise: Claude Code namespaces every MCP tool as
`mcp__<server>__<tool>`, so with the server named `operator` those become
`mcp__operator__operator__dispatch` — doubled, matching nothing any prompt names. The existing
tools are `report` and `task_status` for exactly this reason. The new ones are `dispatch` and
`reply`, exposed as `mcp__operator__dispatch` / `mcp__operator__reply`.

**Addressing is by session uuid, not by pid.** The brief takes the address as computable from the
pid of the `claude` Operator spawned. That is true and it is the weaker key — Operator's pty pid
is the login shell, which may or may not have exec'd into `claude` depending on the shell's own
optimisation, so it is right by coincidence. The descriptor carries `sessionId`, and that **is**
the uuid Operator assigns with `--session-id`: verified against a live lane, pid 19287 ↔
`479123b8-…`, matching the `--settings` path Operator itself wrote. `session-bus.ts` matches on it
and takes `messagingSocketPath` from the descriptor rather than assembling one.

---

## The shape, and why the decision is not in the MCP server

The brief says the server applies the brakes. **It cannot.** `--mcp-serve` is a separate
short-lived process per tool call; the delivery brakes are a pure function over state that lives
in the app's memory (`deliveryStateRef`), and the roster, the tasks and the board are the app's
data. A server process could re-derive the durable half from disk but never the brake state — so
it would apply three of the four rules and silently drop the one that exists to stop a runaway.

**So the server asks and the app answers**, through the same store the report path already uses: a
`dispatch_requests` row written by the server and updated by the app, one UPDATE so a verdict is
never half-visible. The server polls it synchronously (`Atomics.wait`, because `callTool` and
`handle` are both sync and threading async through them for one tool would change the shape of
every other) and gives up at 15s with a message saying plainly that nothing was sent.

Operator stays the router; the bus is the transport; **the lane does the send**. Operator never
speaks the socket protocol — the wire framing and the peer token's role are unconfirmed, and the
blast radius of guessing is every live lane on the machine.

---

## The four items

**1. The tools.** `dispatch(lane, task)` and `reply(lane, line)` return
`{outcome: 'send' | 'launching' | 'refused', to?, text?, reason?}` as JSON, because the caller has
to *act* on it and a sentence would have the model reconstructing an address by eye. The app
applies exactly what the sentinel applies — role resolution through the same `routeDispatch`, the
same brakes, the same task and board entry — and for `launching` it calls
`deliverDispatchRef.current`, which **is** the sentinel's own delivery path rather than a second
near-identical one.

**One ordering rule the tests forced, and it is a real one.** `evaluateDelivery` blocks any
message to a lane that is not live — "a message NEVER launches one" is its own stated rule — so
the route has to be decided *before* the brakes are consulted, or every launch is refused as a
brake failure. A launch is not a message: nothing is delivered to a peer, and the hop budget that
exists to stop lanes talking in circles has nothing to count.

**2. Delivery confirmation.** `readDeliveryResult` maps a `SendMessage` tool result to
`delivered` / `failed`, keeping the CLI's own message id or its own error sentence, unparaphrased.
Anything unrecognised is **failed**, never delivered — a dispatch wrongly marked delivered is the
exact failure this change exists to end, so the ambiguous cases fall to the safe side.

**3. Both paths, and which was used.** The sentinel is unchanged and still works; the coordinator's
prompt names the tool first and the sentinel as the fallback the tool's own timeout points at. A
bus dispatch logs `[dispatch] bus → <lane> (request N)`, so it is answerable whether anything
actually moved.

**4. Scope.** `routeDispatch` takes the project id and only matches lanes inside it, so a lane
cannot reach another project's fleet *through Operator*. A lane can still call `SendMessage` with
a free-form name and reach anything on the bus; that is outside Operator's hands and is noted
rather than pretended away, exactly as the brief directs.

---

## Tests — 27 new

- **Tool outcomes (12)**: `send` for a running lane with the bus address and the wrapped text,
  resolved by id *or* name; `launching` for a dormant lane and for a preset the roster has not got
  yet, with the caller sending nothing; `refused` for a token matching no lane and no preset, for
  a lane running but not yet on the bus (rather than guessing an address that would look valid and
  refuse to connect), and for a lane in another project.
- **Brake refusals (4)**: paused chatter; an exhausted hop chain; the advanced state returned on a
  send so the next call sees it; and the state left **untouched** when the lane does not exist —
  nothing was attempted, so nothing is counted against the sender.
- **tool_result → outcome (5)**, with the shapes the CLI actually returns.
- **The registry (10)**: the field set transcribed from a real descriptor, the socket path taken
  from it rather than assembled, refusal of a descriptor missing any of the three things an
  address needs, a torn half-written file returning null rather than throwing, and one bad
  descriptor not costing Operator every address it has.

---

## The prompt budget, and what it cost

`roster.test.ts` guards the note at under 3100 chars, and its own comment records that the first
draft to breach it was **trimmed rather than the ceiling raised**. Mine breached it at 3523. It
took four passes to fit: the two-step is load-bearing text — a model that reads `dispatch` as
delivering would report work as handed off that never left — so what came out was prose, not
meaning. The last 20 characters came from the charter's now-redundant `OPERATOR-DISPATCH` mention,
since the protocol block below it names the sentinel anyway.

## Not done

- Nothing merged.
- **Nothing has run end to end.** Every piece is unit-tested and the whole thing compiles and
  builds, but no lane has actually called `mcp__operator__dispatch` against a live app: that needs
  a packaged build with two lanes open. What is proven is the decision, the registry read and the
  result mapping; what is not is the round trip through SQLite and the lane's own `SendMessage`.
- **The 500ms poll is a guess at the right cadence.** It is cheap — one indexed read of a table
  that is almost always empty — and it sits well inside the server's 15s timeout, but nobody has
  measured what the round trip actually feels like from a lane.
- `pruneDispatches` exists and nothing calls it yet; the table is a mailbox, and the record that
  matters is the task in `projects.json`.

---

## QA #653 — the wire said `address`, the prompt said `to`

QA round-tripped a real `dispatch` call through the real `handle()` against a real temp SQLite and
found the one thing neither side's unit tests could see.

**The bug.** `mcp-serve.ts` answered with `JSON.stringify(verdict)`, where `verdict` came straight
out of `ArtifactStore.dispatchVerdict()` — the stored row, whose column is `address`. The tool's own
description, and `DISPATCH_PROTOCOL` in `roster.ts` that every lane reads at launch, both tell the
model to send to the `to` field. So every real `send` outcome handed the calling lane a payload with
no `to` in it: the one outcome the whole feature exists to produce was the one that could not be
acted on. `launching` and `refused` were unaffected, which is why nothing looked broken — they carry
no address.

**Why both suites passed.** `dispatch-bus.test.ts` asserts `verdict.to` and is right;
`chat-store.test.ts` asserts the row's `address` and is right; `DashboardView` maps `to` → `address`
on the way in and is right. Three correct halves and no test on the join. The types could not catch
it either: `awaitVerdict` returned `Record<string, unknown>`, so the compiler had no shape to check
the property access against.

**The fix**, at `mcp-serve.ts`. The wire object is now built field by field rather than stringified
from the row, so the mapping back is written down where the contract is:

```ts
return textResult(JSON.stringify({
  outcome: verdict.outcome,
  to: verdict.address,
  text: verdict.text,
  taskId: verdict.taskId,
  reason: verdict.reason,
}))
```

I took the rename over amending the description. The `to`/`address` split is deliberate — `address`
is a column name and `to` is a protocol field, and they should be free to diverge — but a rename
that only exists implicitly is the same bug waiting for the next column rename. Naming the wire
fields at the boundary is what stops a schema change becoming a protocol change. `awaitVerdict`'s
return type also tightened from `Record<string, unknown>` to
`NonNullable<ReturnType<ArtifactStore['dispatchVerdict']>>`, so a future divergence is a tsc error.

**The missing test, added**: `electron/src/main/mcp-serve.test.ts`, 7 tests. It asserts on the exact
JSON text a lane receives, not on either side's internals — a test asserting "the outcome is `send`"
would have passed throughout the bug. Confirmed as a guard: reverted to `JSON.stringify(verdict)`, 2
of the 7 fail; restored, 7 pass. One of them needs no round trip at all — it reads the tool's own
description out of `tools/list` and asserts the payload carries the field that text promises.

**What the test taught.** It hung on the first run. `awaitVerdict` blocks its own thread on
`Atomics.wait`, so a `setTimeout` answerer on the test's thread can never fire while the tool is
waiting — the call sits there for its full 15s timeout. That is not an awkward test, it is the shape
of the thing: in production the answerer *is* a separate process. So the answerer became one —
`electron/src/main/__fixtures__/dispatch-answerer.cjs`, spawned before the blocking call and polling
`dispatch_requests` the way `DashboardView` does. The test arrangement now matches production
because no other arrangement was possible.

**This closes one item from Not done above.** The round trip through SQLite — MCP request → open row
→ another process answers → verdict on the wire — is now covered. What remains unproven is only the
last hop: a real lane calling `SendMessage` with the address it was handed, which still needs a
packaged build with two lanes open.

---

## Review findings — the two HIGHs, and the guard that made them cheap to hit

Review (`dev/results/review-plan-bar-and-bus.md`) found eight issues on this branch. Findings 1, 2
and 3 are fixed below; 5 was the same `to`/`address` bug QA filed and is already fixed above.

### 1 (HIGH) — the bus path bypassed the authority gate

`dispatchNeedsApproval` had exactly one call site in the repo: the sentinel subscription at
`DashboardView.tsx`. `mcp__operator__dispatch` is offered to every lane regardless of
`OPERATOR_ROLE_ID`, so any lane could commission work — launch a lane, create a board task — with
no `pending-approval` record, no toast, and nothing in the dispatch log. The brakes the account
boasted about are a different rule: they cap how much traffic flows, not who may commission it.

**The prompt already promised this guardrail.** `orchestrationNote` tells a non-coordinator lane its
dispatch is "HELD for the user to approve", and `roster.test.ts` pins that sentence. The text was
right and the new path did not implement it, which is the worst version of this bug: every lane was
told a rule that was not being enforced.

Fixed in `resolveDispatch`, not in the view, so it is pure and tested. The gate sits **before the
launch branch** — the sentinel's own comment says why: filing work into a project is commissioning
it, so every route is held, and a launch is the most consequential of them. The verdict carries a
new `held` field for the caller to write the `pending-approval` record from; it never reaches the
wire, which the explicit field mapping in `mcp-serve.ts` now guarantees. The wire outcome is
`refused`, which from the calling lane's side is the whole truth: nothing was sent, and do not
retry.

`DashboardView` writes the same `logDispatch(... 'pending-approval')` record and the same toast the
sentinel writes, so a bus dispatch and a sentinel dispatch land in the same place and the same
Approve button delivers either — approval runs `deliverDispatchRef`, which does not care which
transport asked.

One deliberate difference from the sentinel: an **unassigned** lane token is refused outright rather
than held. The sentinel holds it because its unassigned path files a backlog task; this path files
nothing, so there is nothing to approve, and naming the roster is the more useful answer to what is
almost always a typo.

Seven tests, including that a held dispatch charges the hop budget nothing (nothing was delivered)
and that an unknown sender is held too.

### 2 (HIGH) — the delivery-confirmation half did not exist

`readDeliveryResult` had no caller. Neither tailer was touched. `taskId` was documented on the
verdict and never set. So `addRunningTask` marked a task running, the lane could then fail to send —
the stale-socket case the spike measured verbatim — and nothing observed it. A bus dispatch had
*less* delivery confirmation than the pty path it replaces, which is the reverse of the point.

Now wired end to end, in both shells:

- **Both tailers** record a `SendMessage` tool_use's `to`, and emit a delivery event when its
  result arrives. Attribution is a pure helper on each side (`sendMessageAddress` /
  `send_message_address`) so the rule is tested on its own: only `SendMessage` counts, because a
  result wrongly attributed would confirm a delivery that never happened — worse than none.
- An **empty result still emits**. The renderer treats anything unrecognised as a failure, so
  swallowing the empty case would turn the one outcome that must not be lost into silence.
- `addRunningTask` now returns the task id it mints. The verdict's `taskId` is filled by the caller
  after the board entry exists, since `resolveDispatch` decides before the task is created.
- `DashboardView` parks each unconfirmed send by the address the lane was handed — the only key
  both ends share — and consumes it once, so a transcript re-read replays results that find nothing
  to re-judge. A failure marks the task `abandoned` (its own type means "the run ended without the
  work being seen to finish", which is exactly true) and toasts the CLI's own sentence unparaphrased.

Four Rust tests drive the tracker directly, including the failed and empty cases.

### 3 (MEDIUM-HIGH) — the 500ms poll had no in-flight guard

`tick` awaits an IPC round trip and, on a launch, a worktree create and a spawn — seconds. A second
tick could start mid-flight and run every side effect twice: the hop budget charged twice for one
dispatch, a duplicate board row, a second `[Operator] …` note in the caller's pty. `answerDispatch`'s
`WHERE answered_at IS NULL` makes only the *write* idempotent, so the lane still got one correct
answer while the board and the brakes carried the second pass's damage — the worst shape a bug can
have. A `busy` flag around `tick` closes it.

### 6 (MEDIUM) — partly

`DISPATCH_PROTOCOL` said "On `refused` nothing was sent", which reads the same for a typo (retry)
and a brake or a hold (stop). It now says to read `reason` and retry only for a bad lane name, and
the gate's own reason ends "Do not retry — recommend it in your report". The 3100-char guard was hit
at 3150; per its own comment the note was trimmed rather than the ceiling raised, and the phrase
`roster.test.ts` pins was kept intact.

### Still open

Findings **4** (unanswered requests never expire, so app downtime replays as a burst of launches),
**7** (no liveness check on the bus registry; a duplicate `sessionId` resolves nondeterministically)
and **8** (the board entry is re-derived from the address and silently skipped on a miss) are not
fixed. 4 is now less dangerous — a replayed dispatch from a non-coordinator lane is held rather than
launched — but it is still a real burst for the coordinator's own.

Gates after all of it: renderer 1096, electron 519, cargo 192 passed / 3 ignored, tsc clean in both
projects, both builds clean.

### Review residual — one entry per address collapsed two dispatches

Review verified `2054ce7` against source and found a defect in the new code: `pendingSendsRef` was
`Map<address, entry>`, one slot per address. Two failures fall out of that, and both are real:

- **Two dispatches to the same lane collapsed.** The second write overwrote the first, so the first
  task never got a verdict at all — it sat marked running forever, which is the exact state the
  confirmation half exists to prevent.
- **Any lane's send to that address claimed the entry.** The tool result carries only a tool_use id
  and the `to` it was called with, so a `SendMessage` made for a lane's own reasons could consume a
  dispatch's entry — and, if that unrelated send failed, mark a delivered dispatch `abandoned`.

Replaced with a small book in `dispatch-bus.ts` (`SendBook`, `trackSend`, `takeSend`), keyed by
**sender terminal and address**, holding a **queue** per key and claimed **oldest first**. Entries
expire after `SEND_CONFIRM_TTL_MS` (10 minutes): the lane is blocked at most 15s on the verdict and
sends within its turn, so the real window is seconds, and expiry is what stops a send made hours
later from claiming a stale entry. A stale entry is dropped in passing rather than left at the head,
so it cannot shield a live one behind it.

What this does not fix, and cannot from the transcript: a lane that was told to send to a peer and
also messages that peer on its own account produces two indistinguishable results. Matching the
sender, ordering by age and expiring the stale is as close as the available data allows. The
remaining ambiguity fails toward **never judged** — the task keeps whatever status it has — rather
than judged wrong, which is the right direction for a mechanism whose entire purpose is to stop the
board asserting things that did not happen.

Seven tests, one per named failure. Gates: renderer 1103, electron 519, cargo 192 passed / 3
ignored, tsc clean in both projects, both builds clean.
