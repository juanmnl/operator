# Result — can a lane talk back? (project-level chat feasibility)

Read-only audit of `dev/briefs/research-project-chat-return-path.md`. All "what exists" claims in
that brief were verified against current code and are accurate — cited below with corrections/
additions where I found more precision than the brief assumed. No code changed.

## 1. The tailer's reach

Assistant text is parsed at `transcript.rs:394-424` (`apply_assistant`, iterating `message.content`
blocks; `btype == "text"` or `"thinking"`). The dispatch sentinel is matched **inside that same
loop**, only on `"text"` blocks (`:401-414`, delegating to `parse_dispatches` at `:697-726`) — so a
second sentinel (`OPERATOR-REPLY [to] text`) slots into the exact same spot with the same tolerant
markdown-decoration stripping (`strip_directive_decoration`, `:655-689`) the brief's stripper
(`roster.ts:221`) already mirrors for dispatch. Trivial to add symmetrically.

**Latency**: the tailer polls every 1s (`start_tailer`, `:825` `sleep(Duration::from_secs(1))`),
folding new JSONL lines and emitting `operator:dispatch` per pending event (`:848-853`). A reply
sentinel would ride the same loop — same ~1s worst-case latency, not per-keystroke.

**Dedupe**: `dispatch_id` (`:729-737`) is a content hash — FNV-1a over `session_id|role|task`, not a
sequence number — so a re-read of the same transcript line reproduces the same id and the
frontend's `localStorage` seen-set (`DashboardView.tsx:773-778`, capped at 500) silently skips it.
A reply would need the identical scheme (`session_id|to|text` hashed) for the same guarantee.

## 2. Is a sentinel necessary, or can the last message per turn be posted automatically?

**Sentinel is the right call — implicit-last-message has a real flooding problem, not just an edge
case.** The JSONL has no turn-boundary marker usable in real time: `stop_reason` is tracked
(`last_stop_reason`, `:364`) but knowing a text block was the *last* one for a turn requires either
buffering until the next user/tool line arrives (adds a full turn of latency, defeating the point)
or reacting retroactively. Worse: a coordinator lane's own transcript is full of prose that is
process narration, not a message meant for the channel — "let me check X," planning text,
mid-dispatch commentary — and a lane that speaks many times per turn (subagent loops, multi-tool
turns) would post most of that verbatim into a shared chat if "final text block" were the rule.
Sizes aren't the blocker (code's own measurement at `transcript.rs:764-774`: median tool_result 365
chars, p90 10k, max 3.5MB, already capped at parse time before persistence) — content selection is.
An explicit sentinel keeps the channel to what a lane *deliberately* addressed to it, mirrors the
already-proven dispatch precedent, and costs only what dispatch already costs (a model that must
remember to emit a line — already mitigated by the tolerant parser).

## 3. Delivery in the other direction — can a chat message reach a lane reliably?

Traced to `src/renderer/lib/submit-queue.ts`, called from the dispatch handler at
`DashboardView.tsx:815` (`submitQueue.submit(tab.id, d.task)`). This file **is** the record of both
defects the brief names, and both already have shipped mitigations, not just findings:

- **MERGE** (three fast dispatches collapse into one composer draft) — fixed by serializing writes
  per-terminal with a 350ms floor (`SUBMIT_GAP_MS`, `:23-27`) plus a promise-chain queue per
  terminal id (`:94, 101-129`).
- **SPLIT** (prefix submits, tail strands in the composer) — mitigated by a length-scaled watchdog
  CR: `nudgeDelayFor` (`:39-67`) adds 1.5ms per character on top of an 800ms floor, capped at 6000ms
  (`SUBMIT_NUDGE_MAX_MS`). Transport itself is not the bottleneck — the code comment cites a
  measured `write_all` of ≤0.3ms at every size from 200–8000 chars; the risk is entirely the TUI's
  commit/redraw time, which scales with message length.

**But the cap is explicitly a heuristic stand-in, not a guarantee**, and the code says so itself
(`:59-62`): past ~3.5k chars "is better served by the closed-loop delivery confirmation this
constant is a stand-in for." There is no delivery acknowledgment anywhere in this path — success is
inferred from timing, never confirmed. Dispatch tasks are constrained by their own protocol to "one
line," so they've never stressed this past a few hundred chars in practice. **A Slack-style chat
message is exactly the payload this was never tuned against** — multi-paragraph, pasted logs, code
blocks. Bracketed paste itself handles embedded newlines fine (that's its purpose), so multi-line
per se isn't the risk; unbounded *length* is. Verdict: reliable for short-to-medium messages,
unconfirmed and increasingly risky past a few KB, with no hard cap enforced anywhere in the write
path today.

## 4. Storage

Confirmed both halves of the brief's framing, with the write-path detail it didn't have:

- `chat.db`'s `messages` table (`chatstore.rs:38-47`) is keyed `(session_id, seq)`, no project
  column, and has an established additive-migration pattern already in production use — two
  `ALTER TABLE ADD COLUMN` calls, harmless if the column exists (`:51,54`) — so a `project_id`
  column is cheap precedent, not a new mechanism. **The only writer is the tailer thread**
  (`transcript.rs:845`, `ChatStore::append` inside `start_tailer`'s 1s loop); the only frontend
  surface is the read-only `chat_history` command (`lib.rs:1567`, registered `:1982`). There is
  **no command today that lets the frontend write into chat.db directly** — every row it holds was
  derived by re-parsing a transcript line. A reply-sentinel design fits this model exactly (write to
  pty → CLI logs it → tailer re-parses → persisted); anything that wants to originate a message
  *without* going through a lane's own transcript (e.g. the human's own chat-box messages, if not
  also typed into a specific lane) would need a genuinely new write path.
- `Project` (`projects.json`) is `serde_json::Value` end-to-end (`lib.rs:1220-1240`) — zero Rust
  schema, zero migration cost for new TS fields. `Project.dispatches` already proves the
  capped-tail-log pattern works at this layer.

**Recommendation**: project-scoped messages belong in `chat.db` (it's already the durable,
queryable log with the right idempotency contract), extended with a `project_id` column, not
`Project.dispatches` (that's a routing log with a fixed outcome enum, not a growing conversation)
and not a second ad hoc table (no reason to duplicate the schema `messages` already has).

## 5. Identity

- **A lane**: `Role { id, name, accent }` on `Project.roster`; a session/terminal carries `roleId`.
  Solid, already the whole roster model.
- **Operator (coordinator)**: not architecturally distinct — it's `Role.id === 'operator'` (or
  legacy `'orchestrator'`), a peer roster entry like any other lane, distinguished only by its
  charter text (`roster.ts:91-95, 184-199`). No special-cased "system" identity exists.
- **The user (human)**: **not represented at all.** Dispatch delivery *types the task into the
  target's pty* exactly as a human would (`submitQueue.submit`, no distinguishing prefix on the
  task text itself — only the separate `[Operator] …` status-note feedback carries a marker, and
  that's a note back to the *dispatcher*, not a tag on the delivered task). From the target lane's
  own transcript, a dispatched task and a human typing directly are the **same shape**: an
  indistinguishable `"user"` turn. Provenance for a dispatch exists only in the separate
  `DispatchRecord` log (`fromRoleId`), not in the receiving lane's transcript — so reconstructing
  "who actually sent this" for a chat view requires cross-referencing two different stores, not just
  reading one lane's history.
- **A subagent**: `isSidechain: true` on JSONL lines is well-plumbed — it synthesizes "Subagent
  started/finished" activity markers (`transcript.rs:239-248`) and gates the model-tracking update
  (`:369-376`). `ToolBlock.caller` (`core.rs:44-48`) names the specific subagent on **tool_use**
  blocks, measured present on 100% of real calls (30,699/30,699). **But `NarrationEntry` — the
  "text"/"thinking" prose that a chat view would actually display — carries no caller/subagent field
  at all** (`core.rs:71-84`); the push at `transcript.rs:415-422` is not gated by `is_side` and
  writes subagent prose into the exact same stream as the parent lane's own text, with nothing to
  tell them apart. You can tell "a subagent did something" and "which subagent called this tool,"
  but not "which subagent said this sentence." That's a real gap for a Slack-style view where every
  message needs a named author.

## 6. The elephant — can a lane be asked a question, or only given a task?

**Given a task, reliably. Asked a question with a reliable, timely, addressable answer — no, not
without new plumbing, and the constraint is structural, not a missing feature.**

The lane itself is a full conversational Claude Code session — it can absolutely produce a
free-form answer, that's not in question. What's missing is entirely on Operator's side:

- **One queue, not a channel.** `submitQueue` is a single FIFO per terminal. A chat question sent to
  a lane mid-task doesn't interrupt or get prioritized — it queues behind whatever the lane is
  already doing, arriving as just the next prompt whenever that finishes. There is no "pause and
  answer this" primitive; Operator does not control the model loop (it hosts Claude Code's own CLI
  over a pty, not the Agent SDK), so it has no channel to inject an out-of-band question at all.
- **No addressability.** Nothing ties a lane's eventual reply back to which incoming message
  prompted it — no message ids, no threading, nothing beyond "the lane spoke next." A reply sentinel
  (Q1/Q2) gives *content* a channel; it does not give a *specific question* a specific *answer*.
- **What already exists and is reusable**: the phase/status derivation (`derive_phase`,
  `transcript.rs:~559`) already knows running/waiting/idle per session — a real building block for
  "is this lane free to ask" or a typing-style indicator, not something to build from scratch.

Bottom line for the brief's framing: this is achievable as a **fire-and-forget message board per
project** (lanes post; humans post by typing into a specific lane, which is itself indistinguishable
from a dispatch) without changing how lanes are hosted. It is **not** achievable as a real
back-and-forth "ask and get an answer to this exact question" conversation without either (a)
accepting queued, unaddressed, eventually-consistent replies as "good enough" for v1, or (b) taking
on real design work Operator has deliberately avoided: message threading, an interrupt/priority
channel into a busy lane, and per-message authorship for subagents. Don't soften this: the
Slack-style framing in the brief implies real-time addressable conversation, and what's actually
buildable cheaply is closer to a shared activity log with reply capability — useful, but a narrower
thing than "chat with your agents."

## What's reusable vs. must be built

**Reusable as-is**: dispatch sentinel parser/stripper pattern (symmetric reply parser is a small
addition); tailer poll loop + content-hash dedupe; `chat.db`'s schema, idempotency contract, and
additive-migration precedent; `submitQueue`'s anti-merge/anti-split delivery (for short-to-medium
messages); phase derivation for a "lane is busy" signal; `DispatchLog.tsx` as a visual precedent for
a project-scoped feed.

**Must be built**: the reply sentinel + its Rust parser/emitter; a `project_id` column and a
frontend write path into `chat.db` (today strictly tailer-write/frontend-read); a resolution for
subagent-prose authorship (currently unattributable); a decision on how a human's direct chat-box
message is delivered and attributed distinctly from a dispatch (today identical on the wire); and,
if any addressable "ask → answer" behavior is promised, threading/message-ids plus a story for
messages arriving while a lane is mid-task.

## Most expensive-looking-cheap risk

The temptation is to treat this as "just add a sentinel, done" because the dispatch precedent makes
the happy path look solved. The actual cost center is the **long-message delivery gap in §3**
(unconfirmed past ~3.5k chars, no hard cap, no ack) landing exactly where a chat UI stresses it
hardest, plus the **subagent-authorship gap in §5** — both are silent failure modes (a garbled
message, a misattributed line) that won't show up until real usage, not in any harness.
