# Structured transcript — the build

The decision (2026-07-28): tool calls, file edits, subagent spawns and permission prompts become
**first-class blocks in the chat transcript**, alongside prose. This is the parser + render work
that the chat-baseline spec deliberately excluded.

**Deliverable: the build, plus `dev/structured-transcript-notes.md` for decisions taken.**

## Read first

- `dev/chat-view-critique.md` §A/§B — the block anatomy and collapse rules. Design already settled
  the shape; do not redesign it.
- `dev/research-chat-pipeline-audit.md` — the parser gap table: exactly what Claude Code emits vs
  what we capture.
- `feedback_fixtures_must_match_reality` — why this brief leads with measured data.

## What the data actually is (measured, not assumed)

| Block | Reality |
|---|---|
| `thinking` | **Always empty** (signature only). Nothing to render, ever. Do not build on it. |
| `tool_use` | **Fully populated** — `id`, `name`, `input`, and **`caller` on every one** (2028 sampled). |
| `tool_result` | Present but **large**: median 361 chars, **p90 ~35KB, max 620KB**. |

Three consequences, and they are the spine of this build:

1. **`caller` is the subagent mechanism.** It distinguishes a subagent's call from the lead's, and
   is currently never read. This is what makes a "delegated to Research" block possible without
   inventing attribution. Design left open whether subagent work nests inline or collapses to one
   block that opens its own transcript — start with the single block, per its recommendation.
2. **`tool_result` must be capped at parse time.** Do not persist 620KB blobs into `chat.db` — it is
   already ~5.8MB with a 4.1MB WAL. Cap on the way in, keep a length marker, and offer an escape
   hatch (open in full / reveal the file) rather than pasting the whole thing into a transcript.
   Decide the cap deliberately and write down the number and the reasoning.
3. **"Show the agent's reasoning" is the action stream**, not `thinking`. That is the honest
   carrier and it is fully populated.

## Build

1. **`transcript.rs`** — capture `tool_use` (with `caller`) and capped `tool_result` into the
   narration path, not only into `ActivityEntry`. Today `tool_result` reads `tool_use_id` and drops
   the content entirely.
2. **`NarrationEntry`** — new kinds for the block types. `shared/types.ts` and `chatstore.rs` both
   move; the `(session_id, seq)` durability contract must survive. Existing rows must still load.
3. **`CanvasConversation`** — render the blocks per the critique's three states. **At rest they read
   as punctuation between prose, subordinate to the answer — never a wall of cards.** Running is the
   only animated thing. **Needs-you/permission is the loudest thing in the document**: a persistent
   bar, keyboard-answerable, and it never collapses even historically. Failures never auto-collapse
   either.
4. **Coalescing** consecutive same-kind blocks ("Read 7 files") — Design names this as the lever
   that makes a 200-turn session survivable. It is not optional polish.

## Constraints

- **Additive.** Prose typography is good and is not being rebuilt.
- **Renderer-independent where possible.** The DOM-overlay decision (Research's approach (a)) is
  still open; do not couple block rendering to it. Where a block needs a click target, use the
  existing hit-test pattern and note it as a consumer of the pending pointer-events arbitration.
- **Fixtures from real data.** `MOCK_CHAT` must carry real `tool_use`/`tool_result` shapes,
  including a large result and a `caller`-attributed call. This brief exists partly because a
  fixture lied.
- Keep it commit-sized and separable — this is landing on a tree with five uncommitted work-streams.

## Open question to settle and record

Design flagged it and did not decide: **where the boundary sits between the transcript and the
Diff/Plan panels.** If an edit block expands to show its own diff, the panels' job changes. Settle
this before building the edit block, and write the answer down.
