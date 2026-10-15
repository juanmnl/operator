# Subagent spend in usage.ts (2026-10-14)

Branch `operator/c8ab80`, based on main a29c015 (the 2.1.300 price fix). This implements
`subagent-usage-gap-2026-10-14.md` § "How to count" and fixes findings 2 and 3 from
`usage-prices-review-2026-10-14.md`.

## Result on this machine

| | base a29c015 | this branch |
|---|---|---|
| Subagent spend, 30 days | $0 | **$949.17** |
| Subagent spend, all time | $0 | **$1,115.84** |
| All-time total | $12,162.9 | $13,280.65 |
| Full scan, cold (first scan of the app run) | 11.7–12.6 s | 14.6–15.3 s |
| Full scan, after the 30 s cache expires | 13.4–13.5 s | **0.15–0.17 s** |
| RSS after the third scan (peak during the runs) | 1.3–1.6 GB (2.6 GB) | 0.28–0.35 GB (0.35 GB) |

The subagent figures equal the research note's catalog numbers ($949.17 and $1,115.84) to the
cent.

Parent files were not changed by the new reader. For sessions whose last record is before
2026-10-14, the lanes' own cost is $11,548.8141 on both base and branch. The `"usage"` line
prefilter and the larger-output dedupe dropped nothing. The $1.89 difference in the all-time row
comes from live sessions that wrote between the two runs.

Timings come from a script that calls `computeUsage(0)` + `computeTuning(30)` against the real
`~/.claude/projects` (8,090 parent files, 327 subagent files, 710 MB of subagent data), twice per
build. It then moves `Date.now` forward 31 s to expire the aggregate cache. The cold scan is about
2.5 s slower because it reads the 710 MB more. Every later scan reads only files whose size or
mtime changed.

## What changed

`electron/src/main/usage.ts`

- **Reads subagent transcripts.** `load()` lists each slug's `.jsonl` files, then walks
  `<slug>/<session>/subagents/` recursively, so `workflows/<id>/agent-*.jsonl` is included.
  Every record is attributed to the parent session (the directory name). No other directory in a
  session folder is walked, so `tool-results/` and similar are skipped.
- **One de-dupe index across parent and subagent files; the larger `output_tokens` wins.**
  `keep()` replaces the stored record's token fields when a repeat has more output. It keeps the
  stored record's session, timestamp and sidechain flag. Parent files are read before subagent
  files, so a fork's replay of a parent turn (same usage, `isSidechain: true`) stays the parent's
  turn. The same rule de-dupes within a file first.
- **`sidechain` comes from the record** (`isSidechain === true`), as before. It is now true for
  real data, so `computeInsights`' `subagentPct` is no longer always 0.
- **Per-file parse cache.** `parsed: Map<path, {size, mtimeMs, recs, compactions}>` lasts for the
  app run. A file is re-read only when its size or mtime changes. Entries for deleted files are
  dropped on the next scan. The 30 s aggregate cache is still in place on top of it.
  `resetUsageCache()` clears both.
- **Line prefilter.** A line is skipped before `JSON.parse` unless it contains `"usage"` or
  `compact_boundary`.
- **Subagent compaction boundaries are not counted** toward the lane's compactions. None exist in
  the 327 subagent files on disk.
- **`computeTuning`:** a sidechain record adds to the session's `tokens` and `cost`, to the new
  `subagentTokens` and `subagentCost`, and to `totalCost`, `byModel` and `byProject`. It does not
  change `turns`, `highContextTurns`, `medianContext`, `model` or `effort`. "Latest wins" for model
  and effort now uses its own timestamp (`modelTsMs`), so a later subagent record cannot move it.
  `firstTsMs` and `lastTsMs` still include subagent activity. In `byEffort`, a subagent record
  counts at its own (session, model, effort) triple, so the `byEffort` costs still sum to
  `totalCost`. A session whose only records in the window are subagent records gets a row with
  `model: ''` and `turns: 0`, the same shape as a compaction-only row.
- **Review finding 2 (fast mode).** On an Opus id outside the fast list (opus-5-5, 5, 4-8, 4-6,
  4-7), fast mode is now billed at the model's standard rate. Opus 4.0 and 4.1 fast is 15/75, and
  Opus 4.5 fast is 5/25. I checked this against `tNt()` in the installed 2.1.300 binary: after
  those five exact ids it falls through to `gX[r]`, the catalog rate. The doc comment now names
  `tNt` as the billing path and calls the picker's 30/150 a display string.
- **Review finding 3 (api-request skip).** `isApiRequestLine` matches exactly `api-request`,
  `api-request-shape` and `api-request-blob` (each followed by the closing quote). A future
  `api-request-*` type reaches the parser.

`src/shared/types.ts`: `SessionUsage` gains `subagentTokens` and `subagentCost`. Both are
included in `tokens` and `cost`. `src/renderer/lib/tuning.test.ts`: the fixture gets the two
fields.

## Tests

New in `electron/src/main/usage.test.ts`, written with the existing `turn()` helper:

- a subagent turn is counted and attributed to the parent session
- a nested `subagents/workflows/wf_abc/agent-w.jsonl`
- a `.jsonl` under `<session>/tool-results/` is not read
- growing `output_tokens` (5, 300, 4000, 4000): counts 4000, once
- a fork replay of a parent turn: counted once, as the parent's turn (`turns` 1, subagent tokens
  are only the fork's own turn)
- `subagentPct` is 100 for a session that used a subagent
- Tuning: subagent spend in session `cost`/`tokens` and in `subagentCost`/`subagentTokens`;
  `turns`, `highContextTurns`, `medianContext`, `model` and `effort` are identical with and without
  a later Sonnet/low subagent; `byModel`, `byProject` and `byEffort` include it at its own effort;
  `byEffort` sums to `totalCost`; a subagent-only session has `model: ''`
- per-file cache: a rewritten file with the same size and mtime keeps the cached parse; an
  appended file is re-read
- fast mode on Opus 4.5, 4.1 and 4.0 bills at the standard rate
- `api-request-error` and `api-requests` are not skipped

Run against the base `usage.ts`, 11 of these fail. On the branch:

```
electron$ npm run typecheck        # tsc main + renderer: no errors
electron$ npx vitest run           # Test Files 51 passed (51), Tests 932 passed (932)
repo root$ npx vitest run          # Test Files 117 passed (117), Tests 1778 passed (1778)
```

## Left out

- **No UI change.** The Tuning lane table now shows a lane's cost including its subagents, and
  `subagentCost`/`subagentTokens` are in the payload, but nothing renders "lane $X + subagents $Y"
  yet. That is a renderer change (`src/renderer/lib/tuning.ts` `joinLanes`, `TuningView.tsx`). It
  should go to Design for the presentation, then Code.
- **Review finding 1** (`claude-opus-4-0` priced as Opus 5): not in the brief, not done. It is
  one `includes('opus-4-0')`, and that id does not appear in any transcript on disk.
- **The cold scan still parses on the main process.** It yields between files, so the event loop
  is held for one file's split and parse at a time (the largest subagent file is 18.9 MB), but the
  scan takes about 15 s once per app run (on base, 12–13 s every 30 s cache miss). A worker thread
  would move that work off the main process. I did not do that here.
- **Concurrent cold scans** are not de-duplicated (no in-flight promise). Only the Tuning page
  calls in, one request at a time (`ipc.ts:447`). `getUsageStats` and `getUsageInsights` have no
  renderer caller.
- The live tailer (`transcript.ts`) still ignores subagent files. The research note says this is
  correct for lane state.
- Not GUI-verified.
