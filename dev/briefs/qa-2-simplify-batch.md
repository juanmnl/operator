# Brief: QA pass 2 on `operator/e78fc0` at `bca3c7d` (QA lane) — 2026-09-06

Your pass 1 (report 639) pinned 402b8e1. Since then: `f42e5e5` Tuning capture + page,
`bca3c7d` review fixes. Verify the new work; do not repeat pass 1 except the suite counts.
1. Suites + harnesses with exact counts at `bca3c7d`.
2. Tuning page through the dev/qa-real bridge: mock `getTuning` with fixtures covering (a) a top
   lane above 25% with a step available, (b) top lane below 25%, (c) top lane already on the
   cheapest model at low effort, (d) plan reading absent; assert the card copy per case, the Not
   attributed row, the compaction column populated, and the three entry points (plan meter
   footer link, ⌘K "Tuning", rail foot) navigate to the page.
3. Tailer capture against a synthetic jsonl (write your own; NEVER copy a real transcript into
   the repo): assistant records with `effort`, a `compact_boundary` with pre/post tokens, the
   `/compact`-at-turn-end shape; assert effort, compaction count, tokens re-read, and that the
   phase clears.
4. Toolbar chips: disabled while phase is running/waiting, enabled when idle, write goes through
   submitQueue in typed mode (no bracketed paste), custom model commits on Enter only.
5. Port allocation shared path with a fixture ps table: stranger on the shared port → fresh port;
   sibling with lease + deep non-shell process → shared.
Commit your drivers/fixtures with EXPLICIT paths only (the Code lane shares this worktree and a
`git add -A` swept your files once). `dev/results/qa-2-simplify-batch.md`; call `mcp__operator__report`.
