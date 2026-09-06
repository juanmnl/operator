# Brief: build the Tuning page + the capture it needs (Code lane) — 2026-09-05

Design is settled: `dev/results/usage-view-design.md` + mock `dev/usage-preview.html` (Design lane).
Data inventory: `dev/results/simplify-audit.md` part 5. Read both before writing code. Electron
is the shipping shell; mirror Rust only where the tailer change is symmetric (it is, for effort
and compaction — keep the two tailers in lockstep as they are today).

Part A — capture (both tailers + usage engine)
1. Effort per assistant record: the transcript carries top-level `"effort"`; keep the latest on
   the session (`AgentSession.effort`, distinct from the launch pin) and count tokens per
   (session, model, effort) in the usage engine.
2. Compaction: count `compact_boundary` records per session (the phase work already parses them),
   with `preTokens`/`postTokens` summed as "tokens re-read".
3. Per-session context stats from the per-record `context` the engine already computes:
   median, share of turns > 150k. Stop discarding them into a single global `high_context_pct`.
4. Tool output p50/p90 of `ToolBlock.output_chars` per session and the top tool by chars, from
   chat.db (already persisted).
5. Attribution: join transcripts to saved sessions by claudeSessionId → role/project; unmatched
   transcripts become the "Not attributed" row. Expose one IPC `getTuning(range)` returning the
   shapes the page needs; keep `getUsageStats` if cheaper to extend it.

Part B — the page, exactly as designed
- One PageShell page named "Tuning", `measure="grid"`, range Today · 7 days · 30 days, all
  projects. Sections in the design's order: biggest single change card (with its firing rules:
  >25% and a step available, else the honest sentence; never forecast a saving), Spend by lane
  (two-line rows, Roster button, Not attributed row), Project share of the week (plan meter
  reading quoted via `usePlanLimits`, stacked local bar below, the paragraph keeping them apart;
  do NOT multiply them), Context pressure (compaction column live now that Part A exists), Tool
  output (p50 and p90, Edit charter button).
- Entry points: plan meter popover footer link "What's driving this", ⌘K "Tuning", rail foot.
- Tokens are the headline; cost once per row, muted, 11px. Style rules: transparent badges, CSS
  vars only, no solid accent fills, no focus rings, never stack opacity on --fg-muted, no stray
  word after a full stop.

Done: tests for the capture (fixtures from real jsonl shapes, incl. compact_boundary) and for
the card's firing rules; tsc + both builds + all suites green; `dev/results/tuning-page.md`;
call `mcp__operator__report`. Commit on your branch (continue on operator/e78fc0 is fine); do
not merge.
