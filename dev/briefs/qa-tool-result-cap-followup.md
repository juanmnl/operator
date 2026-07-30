# Follow-up: verify the tool_result cap against real data

**Source:** `dev/qa-chat-regression.md` (gap flagged, not a bug). **Deliverable:**
`dev/qa-tool-result-cap.md`.

## Why this is blocked right now

`NarrationEntry.kind: 'tool'` (the "chat = full structured transcript" feature,
`project_chat_structured_transcript.md`) writes a `ToolBlock` with `output` capped at
2000 chars (`TOOL_RESULT_CAP` in `src-tauri/src/transcript.rs`; real p99 172KB / max
3.5MB per `shared/types.ts`'s own comment). As of this writing:

- `git status src-tauri/src/transcript.rs` still shows it **uncommitted** (`M`, not in
  any release — last shipped tag is v0.9.1, which predates this).
- `~/.operator/chat.db` has **zero** rows of kind `'tool'` — no build that writes them
  has ever run against a real session.

So there is currently no real persisted data to test the cap against. This is a
**precondition check, not a poll** — don't dispatch this again until it's true:

## Preconditions (check before running)

1. `git log -1 --format=%H -- src-tauri/src/transcript.rs` no longer matches the
   current uncommitted diff — i.e. the `kind: "tool"` push has been committed and
   released (check `git tag` for a version after this).
2. The app has been **restarted** on that build (a rebuilt binary that was never
   relaunched won't have written anything).
3. At least one real session has run a tool call large enough to matter —
   `sqlite3 ~/.operator/chat.db "SELECT count(*) FROM messages WHERE kind='tool';"`
   returns > 0, ideally with `tool` JSON blobs whose `outputChars` exceeds 2000.

## What to test once unblocked

Same methodology as `dev/qa-chat-regression.md`'s cap/freeze section (real-data bridge,
not the mock — `dev/qa-extract-real.mjs` + `dev/qa-real-bridge.ts` are still on disk,
untracked; the extractor will need a `kind='tool'` query added since it currently only
pulls `text`/`user`):

1. Find the real tool row(s) with the largest `outputChars` in chat.db.
2. Confirm the rendered `ToolBlock.output` is truncated at exactly 2000 chars and
   `truncated: true` / `outputChars` reports the real original length — not silently
   full, not silently empty.
3. Confirm a large real tool result doesn't reproduce any version of the
   `project_chat_markdown_freeze.md` freeze (rAF round-trip probe, same as the cap/freeze
   section did for text messages).
4. Confirm `caller` (subagent attribution) renders correctly on a real delegated
   (`Task`/`Agent`) tool call, if one exists in the sampled data — this field was noted
   in `shared/types.ts` as "present on 100% of real tool_use blocks" but has, like
   everything else here, never been checked against real *persisted* (chat.db) data.
