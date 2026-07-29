# Structured transcript — decisions

**2026-07-28.** What landed, and the calls taken. Build brief:
`dev/briefs/structured-transcript-build.md`.

## Measured first (300 real transcripts, `~/.claude/projects`)

| | measured | brief said |
|---|---|---|
| `tool_use` | 30,699 | 2,028 sampled |
| `caller` present | **30,699 / 30,699 (100%)** | "on every one" ✓ |
| `tool_result` size | median 365 · p75 1.6k · p90 10k · p95 71k · p99 172k · **max 3.5MB** | median 361 · p90 35k · max 620KB |
| total result text | **314 MB** | — |

The tail is ~5.6× worse than the brief reported. Everything below follows from that number.

## Decision 1 — the cap is **2000 characters**, at parse time

`TOOL_RESULT_CAP` in `transcript.rs`, applied before anything is persisted.

| cap | bytes kept | results truncated |
|---|---|---|
| 500 | 3.2% | 45% |
| **2000** | **7.5%** | **23%** |
| 4000 | 11.0% | 15% |

2000 is the knee for the job the text actually does. The block is punctuation at rest; expanding
it answers "what did that command print / what did that error say". 2000 chars is ~25 lines — a
screenful — and leaves **77% of results whole**. 500 would truncate nearly half of them; 4000
buys 8 more points of coverage for 47% more bytes. Worst case per result drops from 3.5MB to 2KB.

`outputChars` keeps the **original** length so the UI can say "the first 2,000 of 71,194" and
offer the file, rather than pretending the cap is the whole thing. `truncated` is the flag.

chat.db was ~5.8MB with a 4.1MB WAL before this; without a cap the same history would have
carried 314MB of tool output.

## Decision 2 — `caller` is the subagent mechanism, and it gates coalescing

It is on 100% of real calls and was never read. It now rides on every `ToolBlock`, and
`coalesceTools` folds a run **only when the tool name AND the caller agree** — a subagent's
reads must never merge into the lead's, or the transcript misattributes work. Verified in
`tool-blocks.test.ts` and in the harness (a subagent's `Grep` stays its own run beside the
lead's three `Read`s).

Per Design's recommendation this starts as a **single block**, not nested inline transcripts.

## Decision 3 — at rest, a tool run is one line

`⟩ Read 3 files` · `⟩ Searched useEffect` · `⟩ Ran a command npm test`. No card, no header, no
box, 19px, muted, and a half-gap rather than a turn-gap — it is punctuation *between* prose,
subordinate to the answer. Coalescing is what makes a 200-turn session survivable, so it is in
the first commit, not deferred as polish. Asserted mechanically: every run's laid-out height is
≤24px.

## Decision 4 (the open question) — the transcript is the EVENT, the panels are the STATE

Design flagged this and left it open: where does the transcript end and Diff/Plan begin?

**An edit block names what changed, when, and links to the Diff panel. It does not host a diff.**

- The transcript is append-only history. An inline diff would render a view that is already
  stale the moment a later edit touches the same file — history showing present state.
- The Diff panel is the *accumulated working tree*, and it is where review actions live
  (commit / merge / discard). Those belong to a state surface, not to a log entry.
- Rendering diffs in two places doubles the surface doing one job, and the transcript's job is
  the narrative.

This also keeps the 2000-char cap coherent: the transcript never needs the whole result, because
the escape hatch is the panel or the file — not a bigger paste.

## Durability

`ToolBlock` is an optional field on `NarrationEntry`; `chat.db` gains a nullable `tool` column
via the same `ALTER TABLE` migration used for `images`. Rows written before it deserialize
unchanged — asserted by `rows_written_before_the_tool_column_still_load`, which builds the
pre-migration schema, writes a row, migrates, and reads it back. The `(session_id, seq)` primary
key is untouched, so `INSERT OR IGNORE` re-persistence stays idempotent.

## What is NOT built yet

- **Permission / needs-you blocks.** The brief wants these loudest and never-collapsing. They
  are not in the JSONL — permission prompts are TUI state, not transcript events — so they need
  a source before they need a renderer. Nothing was faked.
- **Expand-a-run.** The capped `output` is stored and shipped to the renderer, and runs are
  hit-tested like every other turn, but clicking one does not yet open its results.
- **Edit blocks as a distinct kind.** `Edit`/`Write` currently render as ordinary tool runs
  ("Edited 2 files"). Per decision 4 they should also carry a link into the Diff panel.
- **Failure state.** `tool_result.is_error` is not read yet; failures must never auto-collapse.

## Fixtures

`MOCK_CHAT` now carries real shapes: a caller-attributed call, a three-call run to coalesce, a
subagent call that must not fold, and an oversized result stored **already capped at 2000** with
`outputChars: 71194`. Per `feedback_fixtures_must_match_reality`, a fixture more generous than
the pipeline is how the empty-`thinking` feature shipped; this one is deliberately not.
