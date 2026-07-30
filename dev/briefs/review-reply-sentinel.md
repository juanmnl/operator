# Brief — adversarial review: the unapproved OPERATOR-REPLY sentinel

**Review only. Do not fix anything unless it is a one-line safety issue you flag explicitly.**
Output → `dev/briefs/review-reply-sentinel-RESULT.md`.

## Context you need

348 uncommitted lines across `src-tauri/src/{transcript,chatstore,lib}.rs`, plus renderer plumbing
in `src/operator-bridge.ts:164-178` and `src/renderer/env.d.ts:14-20`. It was **never reviewed and
never approved** — a lane (`research`) dispatched a lane (`code`) to build it. It is sitting on
branch `release/v0.10.1` and includes a live migration against the user's durable chat store:

```sql
ALTER TABLE messages ADD COLUMN project_id TEXT
ALTER TABLE messages ADD COLUMN reply_to TEXT
```

Author's own write-up: `dev/briefs/reply-sentinel-impl-RESULT.md`. Treat it as a claim, not evidence.

## Audit these specifically

1. **The `ALTER TABLE` idempotency.** The code is `let _ = conn.execute("ALTER TABLE …", [])`. That
   swallows **every** error, not just "duplicate column name". A genuine failure — locked db,
   corruption, disk-full — is indistinguishable from the benign case and passes silently, after
   which every subsequent write against the new columns fails in a way nobody sees. Is that
   acceptable, and what is the correct narrower handling?
2. **Does existing per-session chat still read correctly?** `chat_history` (`lib.rs:1567`) predates
   these columns. Verify rows written before the migration, and rows written by the *old* code path,
   still load — and that `kind = 'reply'` rows do **not** leak into a per-session transcript view
   where they were never expected.
3. **The dedupe hash.** `reply_id = FNV-1a(session_id | to | text)`. Content-hashed, no sequence.
   So a lane that legitimately sends the *same* text to the *same* target twice — "done", "ack",
   "tests green" — produces an identical id and the second is silently dropped. Is that correct
   behaviour or data loss? Compare against how `dispatch_id` behaves for repeated identical tasks.
4. **Unbounded query.** `replies(project_id)` does `ORDER BY ts ASC, seq ASC` with no `LIMIT`. What
   happens at 10k replies? Compare with the capped-tail pattern `Project.dispatches` uses.
5. **The `project_id` empty-string case.** The code maps empty → `NULL`. Trace what writes an empty
   project id, and whether a reply from a session with no resolved project silently vanishes from
   every project view.
6. **PROMPT-INJECTION SURFACE — treat as the highest-value finding.** The sentinel is matched against
   **any** `"text"` block in a lane's transcript. A lane that reads a file, web page, or tool output
   containing a line like `OPERATOR-REPLY [code] <anything>` and echoes it into its own prose will
   have that parsed and persisted as a genuine message. Today replies are only *stored*, so the blast
   radius is a junk row. But `dev/briefs/agent-to-agent-delivery.md` is queued and would **type
   delivered replies into a target lane's pty**. At that point, untrusted text a lane merely read
   becomes an instruction delivered to another agent. Assess:
   - Can the parser distinguish a sentinel the model *authored* from one it *quoted*? (Consider
     fenced code blocks, quoted lines, tool output echoed verbatim.)
   - What is the minimum mitigation before delivery ships — e.g. refusing sentinels inside fenced
     blocks, requiring the line be the first non-empty line of a text block, or requiring an
     out-of-band nonce?
   - Same question for the **existing** `OPERATOR-DISPATCH` parser, which already delivers to a pty
     today. If that has the same hole, it is a live defect, not a future one. **Say so plainly.**
7. **Behaviour when the sentinel is malformed** — unknown role, empty text, absurd length, embedded
   newlines, control characters. Does anything panic, block the 1s tailer loop, or write a row that
   breaks a later read?

## Do not

- Do not extend the feature, add delivery, or touch the guardrails brief.
- Do not reformat or refactor. This is an audit.

## Deliver

Findings ranked most-severe first, each with a concrete failure scenario (inputs → wrong result).
Separate **CONFIRMED** (you traced it) from **PLAUSIBLE** (you suspect it). End with one line: is
this safe to keep in the tree while `agent-to-agent-delivery.md` is still unbuilt — yes or no.
