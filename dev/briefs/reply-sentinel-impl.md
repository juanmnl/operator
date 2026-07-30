# Brief — implement the OPERATOR-REPLY sentinel (return path for project chat)

Full context: `dev/briefs/research-project-chat-return-path-RESULT.md` (read it first — this
brief only restates the parts needed to build). That research established there is currently NO
return path from a lane to a project-level channel — only the one-directional `OPERATOR-DISPATCH`
sentinel exists. This ships the reply half, mirroring dispatch exactly.

**Scope**: the sentinel mechanism + storage only. NOT the chat UI, NOT threading/addressability,
NOT the subagent-authorship gap — those are known follow-on gaps, documented in the research
result, out of scope here.

## What to build

### 1. Rust: parse + emit (`src-tauri/src/transcript.rs`)

Mirror the dispatch pipeline exactly:
- A `parse_replies(text: &str) -> Vec<(String, String)>` sibling to `parse_dispatches` (`:697-726`),
  matching `OPERATOR-REPLY [<to>] <text>` — reuse `strip_directive_decoration` (`:655-689`) as-is.
- Call it from `apply_assistant` at the same point dispatch is parsed (`:401-414`), on `"text"`
  blocks only (not `"thinking"`).
- A `reply_id` sibling to `dispatch_id` (`:729-737`) — same FNV-1a content hash, over
  `session_id|to|text`, for the same re-read dedupe guarantee.
- Emit `operator:reply` (mirrors `operator:dispatch`, emitted from the tailer loop at `:848-853`)
  with `{ id, session_id, terminal_id, to, text }`.

### 2. Frontend: route + dedupe (`src/renderer/views/DashboardView.tsx`)

Mirror the `onOrchestratorDispatch` subscription (`:772-778` for the pattern; the dedupe uses a
capped `localStorage` seen-set the same way — reuse that pattern, a second key).
`src/operator-bridge.ts:154-158` needs the matching `onOrchestratorReply` bridge method.

Unlike dispatch, a reply's job is simpler: it doesn't route into any pty (nothing to type
anywhere) — it just needs to be **persisted and attributed**. Resolve `to` (a lane id or
`'project'`/broadcast — decide which; dispatch's `role` matching in `lib/dispatch.ts`'s
`routeDispatch` is the precedent for resolving a role token against the live roster if `to` names
a lane) and the sender's `fromRoleId` from the emitting terminal's `roleId`, same as
`DashboardView.tsx:781-782` does for dispatch.

### 3. Storage: `chat.db`, not `Project.dispatches`

Per the research result's Q4: extend the existing `messages` table
(`src-tauri/src/chatstore.rs:38-47`), not `DispatchRecord`. `Project.dispatches` is a fixed-outcome
routing log; a reply is conversation, and `chat.db` already has the right idempotency contract
`(session_id, seq)` plus a proven additive-migration pattern (two prior `ALTER TABLE ADD COLUMN`
calls at `:51,54` — harmless if the column exists).

Add a `project_id TEXT` column the same way. **Today `chat.db` is written ONLY by the tailer thread**
(`ChatStore::append`, called from `transcript.rs:845` inside the 1s poll loop) — there is no
frontend-invokable write command (`chat_history` at `lib.rs:1567` is read-only). A reply fits this
model naturally (pty → CLI logs the sentinel in its own transcript → tailer re-parses → persisted
with `project_id` stamped from the terminal's project) — do not add a new frontend-write command
for this; that's a bigger fork the research result flags as a separate, NOT-yet-decided question
(how a human's own direct chat message gets attributed) and is out of scope here.

## Guardrails (from the research)

- Keep the sentinel line format strict and tolerant of markdown decoration, exactly like dispatch —
  reuse the shared stripper rather than writing a second regex from scratch (`roster.ts:221` mirrors
  `transcript.rs`'s parser today; keep both in sync the same way for replies).
- Do not attempt to solve real-time addressability (matching a reply to a specific incoming
  question) — the research verdict was explicit that this needs message-ids/threading as separate,
  bigger work. This is a fire-and-forget post to a project-scoped log.
- Do not touch `submitQueue`/delivery-into-pty code — replies are OUTPUT only, nothing is typed
  anywhere for this feature.

## Verify

- Unit test `parse_replies`/`reply_id` alongside the existing dispatch tests in `transcript.rs`
  (see the `#[cfg(test)]` block, e.g. `:945-1037` for the existing pattern).
- Confirm the additive migration is a no-op on a `chat.db` that already has the column (matches the
  existing `images`/`tool` migration behavior).
- `npm run typecheck` / `cargo test`.

## Write your result to

`dev/briefs/reply-sentinel-impl-RESULT.md` — what you built, what you deliberately left out, and
anything from the guardrails above you had to deviate from and why.
