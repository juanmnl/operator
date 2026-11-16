# Subagent usage gap in usage.ts (2026-10-14)

Question from Operator: `electron/src/main/usage.ts` does not read `~/.claude/projects/<slug>/<session>/subagents/**/*.jsonl`. Is that spend missing, would adding it double-count, and how should it be counted? Research only; no code changed. All numbers were computed by scripts over the transcripts on this machine (scratch scripts are in the session scratchpad, not in the repo).

## Short answer

- The spend is missing. Subagent turns are **not** recorded in the parent transcript, so adding them does not double-count (18 of 18,276 keys overlap, explained below).
- Missing: **$1,116 all time at 2.1.300 catalog prices** (about 9% on top of $12,158 for the parent files), **$949 in the last 30 days**, $5.40 in the last 7 days. At the rates `usage.ts` applies today the same tokens price at $1,849 all time and $1,682 in 30 days, so the price-table fixes in `claude-code-updates-audit-2026-10-14.md` should land before or with this change.
- Count them, but with **last-record-wins per `(message.id, requestId)`**, not the first-wins dedupe `usage.ts` uses now. In subagent files the first emission carries a partial `output_tokens`; first-wins would undercount their output by 87%.
- Tuning's per-lane columns (turns, median context, model, effort) must not absorb subagent records unflagged. Details in "How to count".

## What is on disk

| | files | bytes | records with usage | unique `(id, requestId)` |
|---|---|---|---|---|
| parent `<slug>/<session>.jsonl` | 8,090 | not measured | 167,570 | 82,820 |
| subagent `<slug>/<session>/subagents/**/*.jsonl` | 327 | 710 MB | 38,480 (314 flat files) | 18,276 (flat files) |

- 314 files are at `subagents/agent-<id>.jsonl`; 13 more are at `subagents/workflows/<wf_id>/agent-<id>.jsonl` (workflow agents). A non-recursive glob misses the 13. They add $3.40 all time.
- Each `agent-<id>.jsonl` has a sibling `agent-<id>.meta.json`: `agentType` (seen: `fork`), `isFork`, `description`, `toolUseId`, `spawnDepth`, `model`.
- In all 9,874 sampled subagent usage records: `isSidechain: true`, `agentId`, `requestId`, `effort` and `timestamp` are present. `attributionSkill` was not seen.
- `usage.ts:79-97` lists `projects/<slug>/` and keeps entries whose `extname` is `.jsonl`. A session directory has no extension, so it is skipped and nothing under it is read. This is the whole gap; there is no filter on `isSidechain`.

## Are subagent turns also in the parent transcript?

No, on three independent tests:

1. **Sidechain records in parent files:** 167,570 parent usage records, **0** with `isSidechain: true`. Every one of the 18,276 subagent records is `isSidechain: true`. So the `sidechain` flag in `UsageRecord` (`usage.ts:49, 143`) is never true for data `usage.ts` reads, and `computeInsights`' `subagentPct` (`usage.ts:268`) is always 0. That is an existing defect, not a rendering choice.
2. **Id overlap:** of 18,276 unique subagent keys, **18** also exist in a parent file (all in one session, `e1e104d0…`, same slug). The overlapping rows are identical usage tuples, e.g. `claude-sonnet-5 (2, 8, 0, 6013, 145624)`. The cause is forked subagents (`agentType: fork`): the fork's file begins with a replay of the parent's earlier messages, so a few already-logged turns appear in both. The `(id, requestId)` dedupe `usage.ts` already has removes them if parent and subagent files go through the same `seen` set. It is 0.1% of keys.
3. **Rollup in the Task/Agent tool result:** 3 agent `toolUseResult` records were found in a 150-file sample, none with `usage` or `totalTokens` (keys: `isAsync, status, agentId, description, resolvedModel, prompt, outputFile, canReadOutputFile, canContinueAgent`). A scan of every parent file for `toolUseResult` with `totalTokens` and `agentId` found **0**. Nothing in the parent carries the subagent's token totals, so the parent's own turns are the only usage in parent files.

All 18,276 keys have a `message.id` and a `requestId`, so the key does not collapse to `(null, null)`.

## Message ids across files

- Within the parent files, repeated `(id, requestId)` records have identical usage (first, last and max-output pricing all give $12,158.17).
- Within the subagent files they do **not**. The same key is written several times as the turn streams, and output grows: first-seen total output is 560,294 tokens, last-seen is 4,167,441. Priced at the catalog: $1,037.46 first-wins, $1,115.02 last-wins, $1,115.24 max-output-wins. `usage.ts:94-100` keeps the first and discards the rest. Do not reuse that rule for these files.
- Across parent and subagent files the overlap is the 18 keys above.

## Missing spend

Last-record-wins, keys already present in a parent file excluded. Catalog prices are the ones in the 2.1.300 binary (see the audit file); "Operator rates" is `usage.ts:rates()` as it is today.

| window | catalog $ | Operator rates $ | records |
|---|---|---|---|
| 7 days | 5.40 | 10.40 | 156 |
| 30 days | 949.17 | 1,682.22 | 17,428 |
| 90 days / all | 1,115.84 | 1,848.88 | 18,578 |

By model (flat files, catalog): Opus 5.5 $581, Opus 5 $218, Sonnet 5.5 $158, Sonnet 5 $66, Opus 4.8 $10, Fable 5.1 $1. Tokens: input 68K, output 505K (first-wins figure; 4.17M last-wins), cache write 5m 77.9M, cache write 1h 0, cache read 3.49B. Cache reads are the cost, as in the parent files.

By day the spend is bursty: 2026-09-24 $35, 09-26 $50, 09-27 $220, 09-28 $225, 10-05 $171, everything else under $50 a day. The 30-day window is dominated by those days. The largest parent sessions by subagent spend: `6d8f8fa3` $245, `39815704` $193, `f83b0525` $158, `f030dc50` $82, `e43097c3` $72 (41 sessions in total with subagent usage).

The spend in the 7-day window is small because heavy subagent use was a late-September and early-October pattern. It will matter again whenever a lane runs forks or workflows.

## Who else reads these files

- `usage.ts` is the only reader of `~/.claude/projects` for cost. `computeUsage`, `computeInsights` and `computeTuning` all call the same `load()`, so one change covers the Usage page, the insights strip and Tuning (`ipc.ts:447-451`).
- `transcript.ts:74` resolves one file per registered session, `<slug>/<uuid>.jsonl`, for the live tailer. It never reads `subagents/`. Live lane phase, context bar and per-lane token totals therefore also exclude subagent turns, and it already ignores sidechain records in the parent for model, effort and context on purpose (`transcript.ts:361, 461, 530, 548, 573`). That is correct for state and need not change.
- Nothing else in `src/` or `electron/src/` reads `~/.claude/projects`. The renderer's `activity-tree.ts` builds subagent groups from `SubagentStart` records in the tailed parent transcript, not from these files.
- Spend shown anywhere else (tray, plan limits via `plan-limits.ts`) was not traced to these functions; I did not read `plan-limits.ts`. Check before claiming the plan-limit meter is affected.

## How to count them without double-counting

1. **Read the nested files.** Recurse under `<slug>/<session>/subagents/` (including `workflows/<id>/`). Keep the top-level `.jsonl` filter at the slug level so unrelated session subdirectories (for example tool-result folders) are not walked. Attribute every record to the parent session id (the directory name), and keep `slug`.
2. **One `seen` map across parent and subagent files, keyed `${id}:${requestId}`, with the larger `output_tokens` winning.** The current `Set` becomes a `Map` from key to the index of the stored record; on a repeat, replace the stored record's usage if the new `output_tokens` is larger (or if the new record is later in the file). This is also safe for parent files (first, last and max are equal there) and removes the order dependence of `readdir`. It handles the 18 fork-replay overlaps.
3. **Set `sidechain: true` from the record (already read at `usage.ts:143`).** It then becomes true for the first time, which also fixes `subagentPct`.
4. **Do not let sidechain records change per-session lane descriptors in `computeTuning`.** They should add to `cost`, `tokens` and the `byModel` and `byProject` totals, but not to `turns`, `highContextTurns`, `contexts` (median context), or the "latest wins" `model` and `effort` at `usage.ts:340-341`. A subagent's 15k-token context would drag a lane's median down, and a Sonnet subagent would relabel an Opus lane, the same defects `transcript.ts:571` and `:546` already guard against. Cleanest: add a `subagentCost` and `subagentTokens` field to the session row, or key subagent records to their own row flagged as subagent, so the UI can show "lane $X + subagents $Y" and the lane's own numbers do not move.
5. **`byEffort`** (`usage.ts:347-352`): subagent records carry their own `effort`; keep them in the table (they ran at that effort), or exclude them. Either is defensible; decide before the change so the total reconciles with `totalCost`.
6. **Cost of reading.** 710 MB more to `readFile(..., 'utf8')` and `split('\n')` every 30 s cache miss, on top of the parent files, which are already about half `api-request*` records from 2.1.300 on. The largest subagent file is 18.9 MB, so memory per file is bounded. Before reading: skip lines that do not contain `"usage"` before `JSON.parse` (the parent loop already pays a full parse on every line), and skip `api-request` lines. Consider caching per file by `(path, size, mtime)` so completed subagent files, which never change, are parsed once per app run, not once per 30 s.
7. **Tests.** Add fixtures for: a subagent file whose first emission has a smaller `output_tokens` than its last; a fork replay that repeats a parent record; a nested `workflows/<id>/agent-*.jsonl`. Reuse the `turn()` helper in `usage.test.ts`.

## Not verified

- The exact bytes of the parent files (not summed).
- Whether `plan-limits.ts` or the tray read cost from these functions.
- Whether subagent files from sessions older than the cleanup period are removed independently of the parent transcript (all 327 files seen have a parent transcript on disk).
- Fast-mode subagent turns: `usage.speed` was not checked in the subagent files; the cost above assumes standard rates.
