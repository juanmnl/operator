# Inter-agent comms audit — why today's reports and prior dispatches went missing

**Scope:** research only, nothing changed. Traced `electron/src/main/directives.ts`,
`mcp-serve.ts`, `chat-store.ts`, `src/renderer/lib/{dispatch,agent-delivery,launch-args,roster}.ts`,
and the relevant sections of `DashboardView.tsx`. Cross-checked against live state: `claude mcp
list` inside this very session, `ps` output for all 13 currently-live lanes on this machine,
`~/.operator/artifacts.db` (sqlite3), and today's actual lane transcripts under
`~/.claude/projects/`. Where a claim is "verified," it's backed by one of those; where it's
inference, it's marked as such.

## Headline finding, stated first because it explains most of today's incident by itself

**There are two entirely separate comms channels — `OPERATOR-DISPATCH`/`OPERATOR-REPLY` (sentinel
text, typed into a pty) and `operator__report`/`operator__task_status` (an MCP tool call into a
SQLite store) — and the second one is structurally disconnected end to end in the current
Electron build: the launch path never wires `--mcp-config`, so no lane spawned by this shell has
ever had `operator__report` as an available tool, and even the historical calls that DID land
(back when Tauri launched lanes) have no code path reading them back out to any UI.** This isn't a
delivery race or a hop-limit — it's two missing wires, one on each end, both structural rather
than probabilistic.

## Verified directly, first-person, in this very session

This session (`OPERATOR_TERMINAL_ID=t6`) is itself one of today's dispatched lanes. `claude mcp
list` run inside it lists exactly: `claude.ai Framer`, `claude.ai Google Drive`, `claude.ai
Gmail`, `claude.ai Google Calendar`, `claude.ai Figma`, `plugin:fakechat`, `paper`, `obsidian`.
**No `operator` MCP server at all** — `operator__report`/`operator__task_status` were never in this
session's tool list this entire conversation (confirmed repeatedly via `ToolSearch`, which found
nothing matching, across four separate tasks earlier today).

This isn't unique to this lane. `ps -axo pid,command | grep "claude --settings"` lists **13
currently-live lane processes** system-wide right now; grepping all 13 argv strings for
`--mcp-config` or any `--mcp*` flag returns **zero matches, across all of them**. Every currently
running lane on this machine — not just this one — was launched with no MCP wiring at all.

## Root cause, traced to source

`src/renderer/lib/launch-args.ts` is the single function (`buildArgs`, 18 lines) that builds the
CLI argument vector for every spawned lane. It handles `--resume`/`--session-id`,
`--permission-mode`/`--dangerously-skip-permissions`, `--model`, `--allowedTools`, and the initial
prompt. **It has no `--mcp-config` branch, and nothing else in the launch path
(`electron/src/main/terminals.ts`, `ipc.ts`) adds one either** — confirmed by grepping the whole
of `launch-args.ts`, `terminals.ts`, and `ipc.ts` for `mcp-config`/`mcpConfig`/`mcp_config`: no
hits anywhere.

`terminals.ts:114-117` carries a comment that reads, in isolation, like this was handled:

> "the artifact plane (`--mcp-config` pointing at Operator's own `--mcp-serve`) is deliberately
> NOT wired here… It is wired now — see `mcp-serve.ts` and the `--mcp-serve` branch in `index.ts`."

That comment is correct about the **server** half — `mcp-serve.ts` (§ below) is a complete,
correct MCP server, and `index.ts` really does have a `--mcp-serve` branch that lets the packaged
Electron binary answer MCP requests headlessly. What it does *not* describe, and what does not
exist anywhere in the Electron port, is the **client** half: something that tells a spawned
`claude` lane to actually launch and talk to that server via `--mcp-config
'{"operator":{"command":"<execPath>","args":["--mcp-serve"]}}'`. That flag is simply never
constructed. The comment describes the intent accurately but overstates what was actually shipped
— the server exists; nothing points a lane at it.

**This matches the artifact store's own history exactly.** `~/.operator/artifacts.db`'s `reports`
table has 298 rows of real historical data, most recent **`2026-08-21T14:20:25Z`** — and the file's
own mtime is **Aug 21, 09:20**, meaning nothing has written to it since. `task_status` is even
staler: last row `2026-08-11T00:38:11Z`, and even that row is a `probe-t1`/`probe-task-1` test
entry, not real usage. `SELECT count(*) FROM reports WHERE at LIKE '2026-08-24%'` — today — **is
zero.** Project memory dates the Electron shell going live at 2026-08-20/21 (`ELECTRON SHIPPED
2026-08-21`). The MCP client wiring stopped working at exactly the point the launch path moved
from Tauri's `terminal_spawn` (which evidently *did* pass `--mcp-config` — that's the only way the
pre-08-21 rows could exist) to Electron's `buildArgs`, which never picked it up in the port.

## What actually happened in today's 5 lanes, verified against their real transcripts

Sampled three of today's dispatched lanes directly —
`operator-worktrees-operator-a30080/dc6cb30d…jsonl` (the "Code" lane, matching a process I could
also see live in `ps`), `el-encanto-ee7540`, `mantel-a9f080` — and searched every `tool_use` block
in each for a call named `operator__report`. **Zero.** Every match for the string
"operator__report" in today's transcripts is incidental — it's inside `tool_result` payloads from
the lane reading its own codebase (`roster.ts`, `mcp-serve.ts`, comments containing the literal
string), not an actual attempted call. **The model never once tried to call the tool in the
samples checked** — consistent with the tool never appearing in its tool list at all (Claude Code
doesn't offer a `tool_use` block for a name that isn't registered), rather than the call being
attempted and lost. Whatever led to "every lane did the work and called `operator__report`" in the
coordinator's account is very likely each lane's own narrative belief, or reporting through some
other channel it treated as equivalent (a committed file, a final assistant message) — not a real
MCP call. This is worth surfacing to the user directly: **the premise "they called it" doesn't
hold up against the transcripts** — they couldn't have, the tool wasn't there.

## Second, independent loss point: even a landed report has nowhere to go

Assume the MCP wiring is fixed and `operator__report` calls do land in `artifacts.db` again (as
they did through 2026-08-21). **There is still no consumer.** `chat-store.ts` defines
`ArtifactStore.listReports(limit)` (queries the `reports` table); `ipc.ts:94` exposes it as
`artifactReports`; `env.d.ts:50` types it on `window.operator`. **Grepping the entire renderer
(`src/renderer/**`) for `artifactReports` finds exactly those two definition sites and zero call
sites.** Nothing in `DashboardView.tsx` or anywhere else ever invokes
`window.operator.artifactReports(...)`. The read side is fully wired at the IPC layer and
completely absent at the UI layer — a report that successfully reaches the database is, today,
as unreachable to a human or the coordinator as one that was never sent. The coordinator's own
system-prompt text (`roster.ts`'s `REPORT_INBOX`: *"Silence means no report, not a result you
missed"*) is actively wrong under this condition — silence in the coordinator's transcript
currently proves nothing about whether a report exists, because nothing would ever surface it
even if the MCP wiring worked.

## The other channel: `OPERATOR-DISPATCH` / `OPERATOR-REPLY` (sentinel text, typed into a pty)

This is a structurally different mechanism from `operator__report` — text, not an MCP call,
parsed out of a lane's own transcript by `directives.ts`'s `parseDirectives` (shared logic behind
both `OPERATOR-DISPATCH [role] task` and `OPERATOR-REPLY [to] text`), then delivered by writing
into the target's pty. It has its own guards, deliberately tuned against a different failure mode
(models decorating/quoting protocol lines) — fence-tracking, list/emphasis-wrapper stripping,
blockquote exemption — all in `directives.ts`, all well-tested by its own test file and unrelated
to the report-loss mechanism above.

**Delivery is asymmetric by design.** `dispatch.ts`'s `COORDINATOR_ROLE_IDS = ['operator',
'orchestrator']` and `dispatchNeedsApproval()`: a `DISPATCH` from the coordinator delivers
directly (`routeDispatch` → `send`/`queue`/`create`); a `DISPATCH` from any other lane is held as
`pending-approval` and never auto-delivered. `REPLY` traffic (any lane to any lane, including
back to the coordinator) goes through `agent-delivery.ts`'s `evaluateDelivery`, which is where the
memory-documented hop-limit brake lives — confirmed in code, not just from the prior finding:

```
inheritedHop: Record<string, number>   // roleId → hop count. ONE SCALAR PER LANE.
```

`agent-delivery.ts:54-61`'s own comment is explicit that this is a heuristic reconstruction of a
chain "without message ids" — a reply from lane X inherits whatever hop was last delivered *into*
X, regardless of which sender or which conversation that was. Two unrelated senders both talking
to the same lane share one counter. This is exactly the mechanism the existing memory note
(`project_delivery_brakes_stall.md`) describes: **ordinary hub-and-spoke traffic — a coordinator
fanning out to several lanes that each reply back — can trip `HOP_LIMIT` (6) purely from unrelated
volume through a shared lane, not from a runaway pair**, and once a lane is marked `exhausted` in
`state.exhausted`, it "cannot send either, not just receive" until a human message resets it
(`resetChainFor`). Confirmed additionally: `deliveryStateRef` (`DashboardView.tsx:229`) is a plain
`useRef` — **this entire brake state lives only in renderer JS memory, with no persistence**, so
the documented hourly renderer respawn silently wipes it back to `emptyDeliveryState()`. That
happens to *heal* a stuck chain (accidentally), but it also means any diagnosis of "why is this
lane not replying" done after a respawn is working from reset state that doesn't reflect what
actually happened.

**A separate, traceless drop point exists for `DISPATCH` itself**, independent of the hop-limit
(memory already confirms `DISPATCH is unbraked` — this doesn't contradict that; it's a different
bug in the same handler). `DashboardView.tsx`'s `onOrchestratorDispatch` handler
(`deliverDispatchRef`, ~line 1502, and its approval-gate twin at ~line 1599):

```ts
const srcTab = tabs.find((t) => t.id === terminalId)
const project = projs.find((p) => p.id === projectId)
if (!project) return   // <-- nothing logged, no toast, no dispatch-log row, no trace anywhere
```

If the tab that *emitted* the dispatch can't be found in current renderer state, or — the
documented case from `dispatch.ts`'s own comment on `orphanTabs` ("Six el-encanto lanes sat in
[the alive-but-unroutable] state and the only signal was the user noticing they had gone quiet")
— if that tab exists but is missing `projectId`, the handler returns **before any logging call**.
Nothing writes to the dispatch log, nothing toasts, nothing lands in the Team screen. This
produces exactly the symptom described in the standing handoff note: *"2/9 dispatches vanished
traceless — grep lane jsonls after dispatching"* — because grepping the lane jsonls is the right
instinct and still finds nothing, since the drop happens in the **renderer**, on the **sending**
lane's own (mis-tracked) tab state, before the sentinel's target is ever consulted.

**Liveness checks, traced:** `evaluateDelivery`'s `targetLive` input and `dispatch.ts`'s
`routeDispatch`/`pickLaneTab` both require a tab to carry **both** `projectId` and `roleId` to be
routable at all — a live pty missing either field is invisible to routing and reads as "not
running," producing a `queue`/`launch` decision instead of `send` even though a perfectly live
process exists. This is the same orphan-tab class as the dispatch-drop above, just surfacing on
the *receiving* side instead of the sending side.

## Routing diagram, as it actually is today

```
COORDINATOR LANE                                    WORKER LANE
(role: operator/orchestrator)                        (role: code/research/qa/design/…)
      |                                                     |
      | writes "OPERATOR-DISPATCH [role] task"              |
      | into its OWN transcript (assistant turn)             |
      v                                                     |
  transcript tailer (Electron main, transcript.ts)           |
  parses via directives.ts -> parseDispatches                |
      |                                                     |
      v                                                     |
  onOrchestratorDispatch event -> renderer                   |
      |                                                     |
      +-- srcTab not found / no projectId --> SILENTLY DROPPED. no log, no toast, no trace.
      |                                                     |
      +-- sender is coordinator --> routeDispatch:           |
      |     'send'   -> submitQueue.submit(targetTab, task) -+--> TYPED INTO target's pty
      |     'queue'/'create' -> launchRole(...) then submit  |     (only reaches here if the
      |     'unassigned' -> Waiting column, nothing delivered|      TARGET tab has both
      |                                                     |      projectId AND roleId set)
      +-- sender is NOT coordinator --> held 'pending-approval',
            never auto-delivered, sits until a human approves it explicitly


WORKER LANE                                          ANY OTHER LANE incl. COORDINATOR
      |                                                     |
      | writes "OPERATOR-REPLY [to] text"                   |
      v                                                     |
  same tailer + directives.ts -> parseReplies                |
      |                                                     |
      v                                                     |
  onOrchestratorReply -> evaluateDelivery (agent-delivery.ts)|
      |  order: paused? -> !targetLive? -> hop>=6 OR         |
      |  sender already exhausted? -> pair-brake (4/60s)?    |
      |                                                     |
      +-- blocked --> a DispatchRecord row (Team screen only)|
      |     hop-limit is a SINGLE SCALAR PER LANE, not per   |
      |     conversation -- unrelated fan-out traffic through|
      |     one lane can exhaust it for everyone talking to  |
      |     that lane. Brake state lives ONLY in a renderer  |
      |     useRef -- wiped on every renderer respawn.       |
      |                                                     |
      +-- delivered --> submitQueue.submit(target, prefixed) -+--> TYPED INTO target's pty


WORKER LANE                                          Meant to reach: COORDINATOR (or a human)
      |                                                     |
      | calls MCP tool `operator__report` / `task_status`   |
      v                                                     |
  *** NEVER HAPPENS in the current build ***
  launch-args.ts builds this lane's argv with NO --mcp-config.
  The tool is not in the lane's tool list. It cannot be called.
  (Confirmed: 0/13 live lanes on this machine have --mcp-config
   in argv; 0 operator__report tool_use calls found in today's
   sampled transcripts.)
      |
      | IF it were wired (as it was before ~2026-08-21):
      v
  mcp-serve.ts (a correct, tested MCP server) -> ArtifactStore.insertReport()
      |                                                     |
      v                                                     |
  ~/.operator/artifacts.db `reports` table                   |
      |                                                     |
      X  <-- no code anywhere calls window.operator.artifactReports() -->  UI / coordinator
         ipc.ts exposes it, env.d.ts types it, DashboardView.tsx never calls it.
         A landed report is exactly as invisible as a lost one.
```

## Loss mechanisms, ranked

1. **[Critical, total, currently active] `operator__report`/`task_status` unreachable from every
   lane** — `launch-args.ts` never emits `--mcp-config`. Not a race, not a rate: **100% of calls
   are impossible**, because the tool doesn't exist in any lane's tool list. Explains the entirety
   of today's 0/5 by itself; verified first-person (`claude mcp list` in this session) and
   fleet-wide (0/13 live lanes have the flag) and by transcript (0 actual tool_use attempts found).
2. **[Critical, total, independent of #1] No UI consumer of stored reports** — even a successful
   `insertReport` (as happened routinely through 2026-08-21) has no reader. `artifactReports` is
   fully wired at the IPC layer and called from nowhere in the renderer. Fixing #1 alone would not
   fix today's symptom; both must be fixed.
3. **[High] Dispatches vanish traceless when the sending tab is stale/orphaned** —
   `onOrchestratorDispatch`'s `if (!project) return` produces zero log/toast/trace, matching the
   exact "traceless" symptom in the standing handoff note and sharing root cause with the
   documented `orphanTabs` bug (a live tab missing `projectId`/`roleId`).
4. **[High, already in project memory, now code-confirmed] Reply hop-limit is a per-lane scalar,
   not per-conversation** — `agent-delivery.ts`'s `inheritedHop` is keyed by roleId alone, so
   ordinary multi-sender traffic through one lane can exhaust its budget for everyone, and
   `exhausted` then blocks that lane from sending too, in both directions, until a human message
   resets it.
5. **[Medium] Delivery-brake state is unpersisted, renderer-only** — `deliveryStateRef` lives in
   a `useRef`; the documented hourly renderer respawn silently zeroes hop counts, pair windows,
   and exhaustion marks. Accidentally self-healing, but makes any post-hoc diagnosis (including
   this kind of audit, done shortly after an incident) unable to reconstruct exactly what state
   the brake was in at the time.
6. **[Medium] Liveness/routing both require a tab to carry both `projectId` and `roleId`** — a
   live process missing either is invisible to `routeDispatch`/`pickLaneTab`/`evaluateDelivery`'s
   `targetLive`, so a genuinely-running lane can be treated as not-running, silently changing a
   `send` into a `queue` (dispatch) or a `queued`-block (reply) rather than reaching the pty.

## Recommended design

The report-side design that's *already partially built* — a durable store the sender writes to
and a reader reads from independently, no pty typing, no timing race — is the right shape; it
just needs both broken wires reconnected and extended with the properties the brief asks for.
The dispatch/reply side needs its accounting fixed to match what it's actually trying to measure.

**1. Durable inbox/outbox per lane, keep SQLite (it's already there and already correct-shaped).**
`artifacts.db`'s `reports`/`task_status` tables are fine as a schema — the fix is almost entirely
"actually use them," not "replace them." Extend `reports` with a `to_lane`/`to_role` column (today
it implicitly means "to the coordinator" only) and a `delivered_at`/`acked_at` pair so a report
row has a real lifecycle: `written` → `delivered` (read by the UI) → `acked` (a human or the
coordinator lane has actually seen it), rather than "exists in a table" standing in for "reached
someone."

**2. Delivery-on-idle, not pty-typing, specifically for reports — keep this property, it's
correct.** The `operator__report` design already avoids the exact failure class that plagues
`OPERATOR-REPLY` (racing a paste against the TUI's own composer, needing a truncation cap because
there's no ack). Don't change this shape for reports; fix its two broken wires (§ above) instead.
`OPERATOR-REPLY`, by contrast, genuinely does need to land inside a lane's live conversation (it's
meant to be read and acted on mid-turn) — that one has to stay pty-typed, but should gain the ack
this section describes for the same reason reports need it.

**3. Explicit ack.** Neither channel has one today. `mcp-serve.ts`'s `operator__report` returns a
confident `"Reported to Operator (#${id})… you do not need to relay it"` — true only about the
insert, not about anyone having read it; that message should not claim more than the insert. Add:
(a) for reports, a `has_unacked_reports` signal the coordinator's own next turn is primed with
(so the coordinator *asks* rather than assumes silence means nothing happened); (b) for replies,
`agent-delivery.ts`'s `truncateForDelivery` comment already names the gap directly — "There is no
delivery acknowledgment anywhere in the write path" — close it with a lightweight confirmation
written back to the sender's own inbox once the target's pty write actually completes (not merely
queued), so `nudgeDelayFor`'s timing heuristic can retire.

**4. Per-conversation hop accounting, not per-lane.** Replace `inheritedHop: Record<string,
number>` (keyed by `roleId`) with a key on the **ordered ancestry chain**, or at minimum on
`(fromRoleId, toRoleId)` pairs threaded through a real conversation/thread id rather than
inferred from "whatever was last delivered into this lane." The existing `pairHistory`/
`suspendedUntil` maps already key on `"from>to"` for the burst-rate brake — the same key shape
extended to carry hop depth (a per-pair or per-thread counter instead of a per-recipient one)
would stop unrelated hub-and-spoke fan-out from sharing a budget, while keeping the actual
runaway-ping-pong protection this brake exists for. This directly fixes the memory-documented
cascade-exhaustion.

**5. Visible per-lane inbox/outbox in the UI.** Nothing today shows: what a lane has sent, what's
pending approval, what's blocked and why, or what reports have landed and gone unread. Build the
missing consumer for `artifactReports` (§ Loss #2) as this surface, not as a one-off "toast on
insert" — a durable list per lane (sent dispatches + their outcome, received reports + ack state,
blocked replies + the specific brake that stopped them) is what turns "silence means no report"
from a claim the system can't back up into one it actually can.
