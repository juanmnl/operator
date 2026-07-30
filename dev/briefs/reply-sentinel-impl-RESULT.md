# RESULT — the OPERATOR-REPLY sentinel

Built. A lane emits `OPERATOR-REPLY [<to>] <text>`; the tailer parses it, persists it
project-scoped in `chat.db`, and emits `operator:reply`. Nothing is typed into any pty.

---

## 1. Rust — parse + emit (`transcript.rs`)

- **`parse_replies`** matching `OPERATOR-REPLY [<to>] <text>`. Rather than a second copy of the
  parser body, both sentinels now delegate to one **`parse_directives(text, keyword)`** —
  `parse_dispatches` is a one-line wrapper over it. The decoration tolerance is the part that
  took real evidence to get right, so it now cannot drift between the two halves.
- **`reply_id(session_id, to, text)`** — same FNV-1a, factored into a shared `directive_id`
  alongside `dispatch_id`. Same re-read dedupe guarantee.
- Called from `apply_assistant` at the same point as dispatch, **`"text"` blocks only**
  (a reply a lane merely considered in `thinking` was never addressed to anyone).
- **`ReplyEvent`** → `operator:reply` with `{ id, sessionId, terminalId, projectId, to, text }`,
  emitted from the tailer loop beside the dispatch drain.

**Ordering note:** replies are **persisted before emitted**. A reply routes nowhere, so the
store write *is* the feature and the event is only the live notification — persisting first
means a listener that reacts by reading the store can't race ahead of it.

## 2. Storage — a `replies` table in `chat.db` (`chatstore.rs`)

**Revised after review**: the first cut extended `messages` per the brief; on your call it is
now its own table. The two accommodations that forced are gone.

```sql
CREATE TABLE IF NOT EXISTS replies (
  id         TEXT PRIMARY KEY,   -- the tailer's content hash of session_id|to|text
  project_id TEXT,               -- NULL for an ad-hoc session
  session_id TEXT NOT NULL,      -- the SENDER
  to_target  TEXT NOT NULL,      -- addressee token ('project' = broadcast); `to` is reserved
  text       TEXT NOT NULL,
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_by_project ON replies (project_id, ts);
```

- **`append_reply(id, session_id, project_id, to, text, ts)`** — `INSERT OR IGNORE` on the
  content-hash primary key. Idempotency is now *simpler* than for messages rather than
  borrowed from it: a re-read reproduces the id, and the same id can only mean the same
  content, so a repeat is a genuine no-op with no upsert needed.
- **No seq.** `narration_seq` is untouched, so a reply cannot shift the sequence `messages` is
  keyed on — pinned by `replies_do_not_disturb_the_message_seq_space`.
- **`load()` is back to its original query.** Nothing is filtered out, because nothing foreign
  was ever put in.
- **`replies(project_id) -> Vec<ProjectReply>`** and the read-only **`project_replies` command**
  + `window.operator.projectReplies` bridge method. There is deliberately **no write
  command** — replies are written by the tailer alone, per the brief.
- Empty project id stores **NULL**, not `''`, so "posted to a project" is a plain `NOT NULL`
  predicate and an ad-hoc session's reply never appears in anyone's channel.
- **One-time sweep**: `DELETE FROM messages WHERE kind = 'reply'` on open. The intermediate
  build could have written such rows, and with `load()`'s filter gone they'd surface in the
  reading panel as an unknown kind. Its two now-unused columns stay (SQLite keeps them; all
  NULL, inert). No-op for anyone who never ran that build.

## 3. `project_id` had to be plumbed — the one thing the brief assumed was already there

The brief says the tailer stamps `project_id` "from the terminal's project". **It couldn't** —
`terminal_spawn` receives `cwd`, never a project id, and project ids are the *frontend's*
canonical-repo-root scheme (`lib/resolve-project`). Re-deriving them in Rust would be a second
implementation free to drift from the first.

So it rides along at spawn instead: `terminal_spawn(project_id: Option<String>)` →
`NewTrack.project_id` → `Track.project_id`. Set on both spawn paths (`handleLaunchRole` and
`handleRestoreSession`), `None` for an ad-hoc session. Additive and optional, so an older
frontend calling without it still compiles and runs.

## 4. Frontend — route + dedupe (`DashboardView.tsx`)

`onOrchestratorReply` subscription mirroring the dispatch one: a capped 500-entry
`localStorage['operator.reply.seen']` set for re-read dedupe, then it resolves the two
identities the backend can't — **who sent it** (the emitting terminal's `roleId`) and **who
it's for** (`project` = broadcast, otherwise matched against the live roster; an unmatched
token is kept verbatim rather than dropped, since the parser is liberal on purpose). Surfaces
as a toast.

It is deliberately ~15 lines against dispatch's ~90: there's no pty to write to and nothing to
store, because both already happened.

## 5. Guardrail: the frontend mirror stayed in sync

`roster.ts`'s `stripDispatchLines` (which keeps protocol lines out of the chat panel) now
strips `OPERATOR-REPLY` too, via **one regex over an alternation** rather than a second pass —
same reasoning as sharing `parse_directives`.

---

## What I deliberately left out

- **No chat UI, no threading, no addressability.** Per scope. `project_replies` returns the
  channel; nothing renders it yet.
- **No write command.** A human's own message still has no attribution story — the research
  result flags that as a separate, undecided fork.
- **The subagent-authorship gap is untouched.** A reply is attributed to the *session*, so a
  reply emitted by a subagent reads as the parent lane. Known, out of scope.

## The one deviation from the brief — resolved

The brief said extend `messages` and **"not a second ad hoc table (no reason to duplicate the
schema `messages` already has)"**. I built that first, flagged that the fit cost two
accommodations — a `reply_to` column `messages` had no business carrying, and a borrowed seq
slot that then had to be filtered back out of `load()` — and you called for the separate
table. Done; both accommodations are gone and the diff is smaller than the version they were
in. The brief's stated reason didn't hold in the end: a reply shares no useful structure with a
message (different key, different scope, an addressee), so nothing was duplicated by giving it
its own table.

## Verification

- **`cargo test` — 100 passed**, including 6 new parser/id tests:
  `parse_replies_extracts_target_and_text`, `parse_replies_ignores_malformed`,
  `parse_replies_tolerates_markdown_decoration` (all 8 decoration forms),
  **`the_two_sentinels_do_not_cross_match`** (a dispatch must not post to the channel and a
  reply must not be typed into a pty), `reply_id_is_stable_and_distinct`,
  `assistant_text_yields_a_project_stamped_reply` (thinking excluded, project stamped, and the
  narration seq space left alone).
- Store tests (6): `replies_are_project_scoped_and_separate_from_messages`,
  `re_persisting_a_reply_is_a_no_op`, `replies_do_not_disturb_the_message_seq_space`,
  `a_reply_with_no_project_is_stored_unscoped`,
  **`opening_a_db_that_already_has_the_replies_table_keeps_its_rows`** (the upgrade path —
  `CREATE TABLE IF NOT EXISTS` against a real on-disk db with rows in it), and
  **`a_stray_reply_row_left_in_messages_is_swept`** (the intermediate-build cleanup).
- `npm test` — 269 passed (one new `stripDispatchLines` case for the reply form).
- `npm run build` (tsc + vite) — clean.

## Not verified

**No end-to-end run.** The path only closes when a real Claude Code session writes the sentinel
into its own transcript, and the mock bridge has no tailer. Everything up to that boundary is
unit-tested; the join between them — a live lane emitting `OPERATOR-REPLY` and the row landing
in `~/.operator/chat.db` — is unexercised. The cheapest live check: launch a lane, ask it to
emit `OPERATOR-REPLY [operator] hello`, then
`sqlite3 ~/.operator/chat.db "select project_id, to_target, text from replies"`.
