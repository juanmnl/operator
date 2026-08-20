# Brief — Electron S1: the transcript tailer, session model and chat store, in Node

**Implement on your branch. Output: `dev/briefs/2026-08-20-electron-s1-transcript-tailer-RESULT.md`.**
Precondition: S0 is committed on your branch as `electron/` (the spike's shell, promoted — see the
dispatch that accompanies this brief). Nothing under `src/renderer`, `src/shared` or `src-tauri/`
changes in S1 except where the RESULT explicitly lists it (expected: none).

## What S1 is (from `dev/briefs/2026-08-20-electron-migration-plan-RESULT.md` §S1)

The orchestration product is made of this stage. Port, behaviour-for-behaviour:
- `src-tauri/src/transcript.rs` (1638 LOC): the tailer `start_tailer` (L1029) — 1 s poll loop
  over `~/.claude/projects/<slug>/<uuid>.jsonl` by stored byte offset; `Track::poll` (L251);
  `push_narration` (L218) with `NARRATION_CAP = 80` (L28) bounding the live tail only; emits
  `session:update` (L1153, payload = `sessions.get_active()`), `operator:dispatch` (L1061),
  `operator:reply` (L1072). Read the whole module before writing a line — the phase machine
  (`idle|running|compacting|waiting`, `src/shared/types.ts:21`), subagent tagging, dispatch
  sentinel matching and the queue-operation/enqueue handling
  (`project_queued_prompts_no_user_turn` — a prompt into a mid-turn lane leaves only
  `queue-operation: enqueue`, never a `user` turn) are the subtle parts.
- `src-tauri/src/core.rs` (458 LOC) — **it says "Ported from the Electron main process:
  sessions.ts and tool-summary.ts"**; structs already camelCase-tagged to `shared/types.ts`.
  Revert it, don't re-derive it. The pre-Rust originals are at `git show 94cb187^:src/main/…`.
- `src-tauri/src/chatstore.rs` (545 LOC) — `~/.operator/chat.db`, tables `messages(session_id,
  seq, kind, text, ts, PK(session_id,seq))` + `replies` (+ index `replies_by_project`), WAL,
  `INSERT OR IGNORE` idempotency, `PRAGMA user_version` migration (L245-254). Port to
  `better-sqlite3`. **Byte-compatible**: the Electron build must open an existing `chat.db`
  unmodified; prove it with a round-trip test against a copy of the real file (never the live one).
- Commands to promote in the shell's `SPEC`: `chat_history`, `project_replies`, `load_sessions`/
  `save_sessions` if S1 needs them for the session model (else S2), plus the three events above.
  The mock keeps answering everything else.

## Acceptance

- A real Claude Code lane spawned by the S0 terminal shows up in the real renderer's Chat view
  with the same blocks/phases as the Tauri build for the same session (compare against the Tauri
  app reading the same jsonl — the file is the ground truth, both can read it).
- A dispatch sentinel typed in that lane (`OPERATOR-DISPATCH [qa] …`) reaches the renderer as
  `operator:dispatch`; a reply sentinel as `operator:reply`.
- `chat_history(id)` returns the durable rows for a session the Tauri build wrote.
- Tests: port the Rust tests' *scenarios* for transcript phase transitions, narration cap and
  chatstore idempotency to vitest under `electron/` (count them; the plan asks for equivalent-
  scenario coverage, prioritised transcript → chatstore). `npm test` green, `tsc` clean.
- RESULT lists: every Rust behaviour you could NOT reproduce, and why.
