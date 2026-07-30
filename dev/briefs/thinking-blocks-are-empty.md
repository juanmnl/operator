# The `thinking` feature shipped against data that is always empty

**Measured 2026-07-28 across 12 real transcripts in `~/.claude/projects/<slug>/`:
626 `thinking` blocks, 626 of them empty, 0 with text.** Claude Code emits thinking blocks
carrying a `signature` only — the reasoning text is redacted at source and never reaches the JSONL.

Research's pipeline audit called this correctly (`dev/research-chat-pipeline-audit.md`, closing
table: *"code path exists, but text is empty in 100% of observed data (signature-only)"*). I verified
it independently before writing this.

## What this breaks

The collapsible **Thought ▸ / Thought ▾** block built this morning
(`CanvasConversation.tsx:319-323`, `thoughtPreview`, `expandedThoughts`) renders a disclosure whose
body is always empty. Expanding it shows nothing. A user who clicks it learns only that the control
is broken.

Not affected: the **status line's "Thinking" label**, which comes from `chatSignal` and is derived
from `phase === 'running'` with no tool open. That one is honest and works — it is what the user
actually saw and liked. Do not touch it.

## Why nobody caught it

`dev/mock-bridge.ts`'s `MOCK_CHAT` fixture contains thinking entries **with prose text in them**.
Every harness run therefore showed a working, populated Thought block. The fixture described a
transcript shape Claude Code does not produce.

**The lesson is the durable part of this brief:** a mock that is more generous than reality will
validate a feature that cannot work. Fixtures must be derived from, or checked against, real
transcript data.

## What to do

1. **Do not render a disclosure that can never open.** Options, in the order I would consider them:
   drop the Thought block entirely; or keep the parse path but render nothing when the text is empty,
   so it lights up automatically if Claude Code ever starts emitting real thinking text. The second
   costs almost nothing and is the safer bet — but it must render *nothing*, not an empty control.
2. **Fix `MOCK_CHAT`** so its thinking entries are signature-only/empty, matching reality. Leave a
   comment saying why, or someone will "fix" it back.
3. **Re-check the rest of the fixture against real data** while you are in there. If thinking was
   wrong, other entries may be too — Research's table also flags `tool_result` content as dropped
   entirely and `tool_use.caller` as never read.
4. Add a test asserting an empty-text thinking entry produces no visible block.

## Wider consequence for the structured-transcript work

Design's chat critique ranked *"thinking is discarded, not collapsed"* as the #3 pain and specified a
third collapsed state for it. **That recommendation was made against the mock, and its premise does
not hold** — there is no reasoning to collapse. Design should know before speccing anything further
that depends on thinking content being available.

The honest version of "show the agent's reasoning" is the tool-call/action stream
(`tool_use` → `ActivityEntry`, already parsed but never shown in chat), not `thinking`. That is what
the structured-transcript build should carry.
