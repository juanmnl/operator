# Research — can a lane talk back? (feasibility for project-level chat)

**Read-only. Change no code.** Output → `dev/briefs/research-project-chat-return-path-RESULT.md`.

## Why

New direction: chat becomes **project-level** — a Slack-style space where the user talks to the
project and its agents, with Operator (the coordinator lane) as hub. Before designing any UI, one
question decides whether this is cheap or expensive:

> **How does a lane emit a message that lands in a project-level conversation?**

Today there is no return path. Operator dispatches via the `OPERATOR-DISPATCH [role] task`
sentinel, which the transcript tailer routes; a lane's reply exists only in its own transcript and
is invisible to everyone else. Coordination currently runs on lanes writing `dev/briefs/*-RESULT.md`
files purely as a workaround.

## What exists (verified — confirm and correct, don't re-derive)

- `src/shared/types.ts:233` `DispatchRecord { id, at, fromRoleId?, toRoleId?, task, outcome }`,
  persisted on `Project.dispatches` (capped tail). Already an addressed, timestamped,
  project-scoped message envelope — but one-directional and reply-less.
- `src/renderer/components/session/DispatchLog.tsx` — renders that feed at project level already.
- `src/renderer/lib/roster.ts:194-223` — the sentinel's prompt text, plus `DISPATCH_LINE` regex and
  the stripper that removes directive lines from displayed prose.
- `src/operator-bridge.ts:154` — the `operator:dispatch` event the tailer raises.
- `~/.operator/chat.db` — single `messages` table keyed `(session_id, seq)`. **No project column.**
- `src-tauri/src/transcript.rs` — the tailer reading `~/.claude/projects/<slug>/<uuid>.jsonl`.

## Answer these

1. **The tailer's reach.** Walk `transcript.rs`: exactly where is an assistant line parsed, and
   where is the dispatch sentinel matched? Could a second sentinel (`OPERATOR-REPLY [to] text`)
   be matched at the same point? What is the latency and the dedupe story (`DispatchRecord.id` is
   "stable across transcript re-reads" — how is it derived, and would a reply need the same)?
2. **Is a sentinel even necessary?** The tailer already sees every assistant message. Could a
   lane's *final* assistant message per turn be posted automatically, with no new protocol? Assess
   honestly against: multi-turn lanes that speak many times, prose that isn't meant as a report,
   and the ~35KB p90 / 620KB max `tool_result` sizes recorded in `feedback_fixtures_must_match_reality`.
   Which is better — explicit sentinel or implicit last-message — and why?
3. **Delivery in the other direction.** Dispatch reaches a live lane by typing into its pty
   (bracketed paste). Two known defects are on record: long lines SPLIT (prefix submits, tail
   strands in the composer) and an older paste+CR MERGE bug. Find where that is implemented and
   report whether a chat-style message (arbitrary length, multi-line, possibly with an @mention
   prefix) can be delivered reliably, or whether the pty path caps message length in practice.
4. **Storage.** What would project-scoped messages need — a `project_id` column on `messages`, a
   second table, or extending `Project.dispatches`? Note that `Project` is persisted as opaque JSON
   (`src-tauri/src/lib.rs:1211-1240`, zero Rust changes for new fields) while `chat.db` is real
   SQLite with a migration cost. Which is the right home for a growing message log, and what does
   the existing chat.db write path look like (who writes, when, is there a migration mechanism)?
5. **Identity.** For a Slack-style view every message needs an author. Lanes have `Role`
   (`id, name, accent`). What identifies (a) the user, (b) Operator, (c) a lane, (d) a subagent
   spawned inside a lane? Is there anything today that distinguishes a subagent's output from its
   parent lane's in the transcript?
6. **The elephant.** State plainly whether "chat with your agents" is achievable **without**
   changing how lanes are hosted. Operator is a transcript OBSERVER hosting Claude Code's own CLI
   — it does not control the model loop. Where does that constrain a conversational UI (e.g. can a
   lane be *asked a question* and reliably answer, or only *given a task*)? This is the answer that
   decides the shape of the whole feature; do not soften it.

## Deliver

A ≤2-page report: what's reusable, what must be built, the recommended reply mechanism with its
failure modes, and an honest verdict on the constraint in (6). Flag anything that makes this more
expensive than it looks. No code, no UI proposals — this is the feasibility gate.
