# Agent comms — reconnected

**Branch:** `operator/a30080` · commits `d97f6f9`, `297b670`, `0036dc9`, `3a039c5` · 2026-08-24
**From:** `dev/results/agent-comms-audit.md`, plus Design's `inbox-outbox-design.md` and
`inbox-outbox-reconcile.md` (both copied onto this branch).

---

## Commit 1 — the client half, and a second bug it exposed (`d97f6f9`)

`launch-args.ts` never emitted `--mcp-config`, so `operator__report` was in **no lane's tool
list** for the entire life of the Electron shell. The audit measured it three ways: 0 of 13 live
lanes carrying the flag, 0 `tool_use` calls across the day's transcripts, and an `artifacts.db`
whose last write is the day the launch path changed hands. The server half was complete the whole
time; nothing pointed a lane at it.

`mcpConfigArg(execPath, appPath?)` builds the flag; `terminals.ts` passes it on every lane.
**Packaged vs dev is the subtlety**: `process.execPath` is the Operator binary when packaged and
the `electron` binary in dev, and the latter opens an empty shell unless handed the app directory
as `argv[1]`. `app.isPackaged` decides, at the call site, so the pure builder stays pure.

### Verified against the packaged binary — and it found a second bug

```
$ echo "list every tool starting with operator__" | claude -p --mcp-config '{"mcpServers":…}'
mcp__operator__operator__report
mcp__operator__operator__task_status
```

Claude Code namespaces MCP tools `mcp__<server>__<tool>`. With the tools named `operator__report`
inside a server named `operator`, **the exposed name doubled** — and matched nothing any prompt
tells a lane to call. A lane would have searched its tool list, found nothing, and gone quiet:
the audit's symptom reproduced one layer further in, and the flag alone would not have fixed it.

Tools renamed to `report` / `task_status`, so the real names are `mcp__operator__report` and
`mcp__operator__task_status`. `roster.ts`'s charters say exactly that, and a test pins the
namespaced form and rejects both wrong shapes.

`operator__report`'s return text claimed *"you do not need to relay it"* — an assertion that
someone would read it, which nobody could. It now claims only the insert.

## Commit 2 — the consumer (`297b670`)

`reports` gains `to_role`, `delivered_at`, `acked_at`: **written → delivered → acked**, so a row
means something more specific than "exists in a table". Added by `ALTER` per column, each
tolerated if present — SQLite has no `IF NOT EXISTS` for columns and this database holds 298 rows
of real history a drop-and-recreate would throw away. Rows predating `to_role` read as addressed
to the coordinator, which is what they implicitly meant.

**Delivery-on-idle**, not pty-typing. A report landing for the coordinator gets one short line on
its next idle: `[Operator] report #42 from research: … — full text in Inbox`. Deliberately *not*
the report — reports exist because pasting a long result into a live TUI races its composer, and
an announcement carrying the text would reintroduce the failure the channel was built to avoid.
Only between turns, never mid-`running`. `delivered_at` is marked **before** the write: a crash
then loses one announcement but leaves the report in the Inbox, where the text lives anyway.

## Commit 3 — the traceless drop and per-thread hops (`0036dc9`)

**The drop.** `onOrchestratorDispatch` and its approval twin both had a bare `if (!project)
return` — no log row, no toast, no trace. That is "2/9 dispatches vanished traceless" in the
standing handoff, and grepping the lane jsonls finds nothing because the drop happens in the
*renderer*, on the sending lane's own mis-tracked tab state, before the target is ever consulted.
Both sites now toast and write an `unassigned` row.

**Hop accounting.** `inheritedHop` was one scalar per lane — "the hop of the last message
delivered into it, whoever sent it" — so unrelated senders shared a counter, and because
exhaustion marked both *lanes*, one dead conversation silenced a hub for everybody. `chainHop` is
now keyed `"from>to"` and inherits from the **reverse** pair; `exhausted` is keyed per thread.

**The property that had to be replaced, not dropped.** Per-lane hops caught runaway shapes that
are not a pair: a ring `a→b→c→…→a` has a distinct pair at every step, so per-thread accounting
sees a fresh hop-1 conversation each time and never stops it. `LANE_SEND_LIMIT` (24) catches that
instead — how much *one lane* has said with no human in the loop, which cannot cascade because it
is not shared, and is generous enough that a coordinator fanning out to five lanes is nowhere
near it.

The trade is asserted, not hidden. The ring test runs twice: **fast**, where the pair brake stops
it (the old test's premise that it *couldn't* help was untrue at that timing), and **slow** enough
that no pair repeats inside a window, where only the lane budget can see it — and it still
terminates.

## The reconciliation with Design (`3a039c5`)

Design read the build and sent five items. Two adopted from the build (ack-on-open beats an Ack
button; one chronological list beats two segments — both were in the first build and I had
briefly regressed the second chasing the design's first draft). Three defects, all against rules
already written down in this repo:

- **A second outcome vocabulary that contradicted the first.** `BLOCK_REASON` put `undelivered`
  in the blocked set, so a row read *"Not delivered — the bytes went out…"*, contradicting itself
  in one sentence; and inked `rejected`/`unassigned` as warnings, so a declined dispatch shouted
  as loudly as a hop limit. Deleted. `chipForOutcome` is imported, and the `ⓘ` line is now
  `evaluateDelivery`'s **own** note, persisted at block time — sentences that have existed since
  the brakes shipped and were rendered nowhere.
- **`var(--yellow)` at 9–11px** fails contrast on three of six palettes. Swapped for the WARN_INK
  mix `RosterPanel` and `DispatchLog` already use, for exactly that reason.
- **The unread count was invisible until you opened the tab that showed it.** The fetch is hoisted
  into `DashboardView`; `unreadByRole` derives every lane's count from one poll; the INBOX tab
  carries the badge.

## Design's four open questions, answered

1. **Who writes `delivered_at`?** The coordinator's idle announcement, not the panel's render.
   That is the stronger claim — "the coordinator was told" rather than "a tab happened to be
   open" — and the label matches it: a row is `delivered` only once a line went to the pty.
2. **Does a report carry `to_role`?** Yes, as of `297b670`. A non-coordinator lane's Received list
   is no longer empty by construction.
3. **Does `Send anyway` on `hop-limit` reset the budget?** It should reset the thread, and with
   §4's rework that is now cheap and correct: a human approving *is* the human in the chain, and
   `resetChainFor` clears every thread the lane is in. The button itself is not built yet.
4. **Countdown source.** `suspendedUntil` still lives in an unpersisted `useRef`, so the
   pair-brake row shows the brake's sentence with **no timer** — a countdown reading a value that
   silently resets to zero would look like the brake cleared itself early.

## Not built, and named

The **rail-orb marker** and the **coordinator's toolbar chip** — the count's other two consumers.
`unreadByRole` feeds them the moment they exist. The placement rule is recorded so it is not
re-litigated: a **marker beside the orb, never a change to the orb** (`StatusWave`'s house rule,
with the CIELAB measurements behind the 0.17.2 mute). Also unbuilt: `Send anyway` and `Nudge`,
which must route through `DispatchLog`'s existing approve path rather than adding a second one.

## Checks

| | |
|---|---|
| `tsc --noEmit` (root) | **0** |
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `vitest run` (electron) | **367 passed, 0 failed** |
| `npm test` (root) | **884 passed / 33 failed** — the 33 unchanged, pre-existing jsdom-under-Node-26 |

## Not verified

No lane has been launched from the app with the new flag. The flag itself is proven against the
packaged binary (above), and the tool names are pinned by a test, but the **wiring in
`terminals.ts`** — particularly the dev branch, where `app.getAppPath()` has to be right — has not
been exercised. Worth doing first: launch a lane, run `claude mcp list` inside it, confirm
`operator` appears, then have it call `mcp__operator__report` and watch the Inbox badge.
