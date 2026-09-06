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
