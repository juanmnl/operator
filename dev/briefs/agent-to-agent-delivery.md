# Brief — close the loop: deliver replies, with guardrails against runaway chatter

Goal: **agents keep talking between them.** Today they can't, for one specific reason.

Read `dev/briefs/research-project-chat-return-path-RESULT.md` first — it is the feasibility audit
and every claim below is sourced from it. Do not re-derive.

## What already works

- **Lane → lane dispatch.** Any lane can emit `OPERATOR-DISPATCH [role] task`; the tailer parses it
  (`transcript.rs:401-414`), `DispatchRecord.fromRoleId` records the sender, and
  `submitQueue.submit` types it into the target's pty (`DashboardView.tsx:815`). Agent-to-agent
  *initiation* is already real.
- **The reply sentinel.** `OPERATOR-REPLY [to] text` parses, persists project-scoped in `chat.db`,
  and emits `operator:reply`. Already built (`dev/briefs/reply-sentinel-impl-RESULT.md`).

## The one missing piece

**A reply is persisted but never delivered.** Nothing types it into the addressee's pty, so the
recipient never learns it arrived. Close that: route a reply through the *same* delivery path a
dispatch uses (`submitQueue`), addressed by `to` → `roleId` → live terminal.

That is the whole feature. Everything else below is the safety work that must ship with it.

## MANDATORY guardrails — do not ship delivery without these

Two agents that can each answer the other will ping-pong indefinitely at ~1s per tailer poll,
burning tokens with nobody watching. This is the default behaviour of two cooperative agents, not
an edge case.

1. **Hop budget per chain.** Every delivered message carries a `hop` count. A reply generated in
   response to a delivered message inherits `hop + 1`. **At `hop >= 6`, stop delivering** — persist
   the message, mark it `hop-limit`, and surface it to the human instead. Thread the counter through
   the `DispatchRecord`/reply id chain; if a chain can't be reconstructed cheaply, key the budget on
   `(fromRoleId, toRoleId)` within a rolling window instead — a cruder bound is acceptable, an
   unbounded one is not.
2. **Cycle brake.** If the same ordered pair `(from, to)` delivers more than **4 messages in 60s**,
   suspend that pair for 5 minutes and post one notice into the project log. Suspension is per-pair,
   never global — an unrelated lane must stay reachable.
3. **Hard length cap.** Research §3: delivery is unconfirmed past ~3.5k chars, there is no ack
   anywhere in the write path, and `nudgeDelayFor` is explicitly a heuristic stand-in
   (`submit-queue.ts:59-62`). **Enforce a hard cap of 2000 chars on any delivered message.** Over
   that: deliver a truncated form plus a pointer, persist the full text, and never silently send
   4KB into a path that cannot confirm it landed. The old SPLIT bug (prefix submits, tail strands in
   the composer) is exactly what this prevents.
4. **A kill switch the human can reach.** One control that halts all agent→agent delivery
   immediately, leaving human→lane dispatch working. Persist it. If chatter is burning tokens at
   2am, this is the thing that saves the bill.
5. **Never deliver to a lane that isn't live.** No auto-launching a lane to receive a reply — that
   turns a message into an unbounded spawn. Queue it or drop it with a logged reason.

## Do NOT build

- **No threading, no message ids, no ask→answer addressing.** Research §6 is explicit that
  addressable Q&A needs an interrupt channel Operator does not have. Fire-and-forget only.
- **No interrupt/priority injection** into a busy lane. A message queues behind current work; that
  is the accepted semantics.
- **No subagent authorship.** `NarrationEntry` (`core.rs:71-84`) carries no caller field, so
  subagent prose is unattributable today (§5). Don't fake an author.
- **No new frontend write path into `chat.db`.** Today it is strictly tailer-write / frontend-read
  (`lib.rs:1567`); keep that invariant.

## Also fix

`stripDispatchLines` (`roster.ts:217-228`) already strips both sentinels from displayed prose —
verify a *delivered* reply doesn't re-emit a sentinel line that gets re-parsed on the recipient's
side, creating a duplicate. That's a self-amplifying bug: prefix delivered text so it cannot itself
match `DIRECTIVE_LINE`.

## Verify

- `npm test` + `cargo test` + `npm run build` green.
- **Unit-test every guardrail**, they are the point: hop budget stops at 6; the pair brake trips at
  5 messages in 60s and releases after 5 min; a 3000-char message is truncated not sent whole; a
  dead target queues rather than launches; the kill switch blocks agent→agent while leaving
  human→lane working.
- **A loop test**: two mock lanes each configured to reply to the other; assert delivery stops and
  the chain is marked `hop-limit` rather than running forever. If this test can hang, it is wrong.
- Confirm existing per-session `chat_history` reads still work with the `project_id`/`reply_to`
  columns present.

## Write your result to

`dev/briefs/agent-to-agent-delivery-RESULT.md` — what landed, each guardrail's actual threshold,
and anything you think is still unbounded.
