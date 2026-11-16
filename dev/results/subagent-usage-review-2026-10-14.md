# Review: subagent spend in usage.ts — 2026-10-14

Branch `operator/c8ab80`, commit 8078b8a, compared with main a29c015. Reviewed: the `usage.ts`
diff (`keep`, `subagentFiles`, `load`, `parseTranscript`, `computeTuning`, `rates`,
`isApiRequestLine`), the type and test changes, and the callers (`ipc.ts`, `TuningView.tsx`,
`lib/tuning.ts`). No fixes made.

**Verdict: no correctness regressions. Mergeable.**
- Subagent spend is now counted: $1,116 on this machine.
- The dedupe is order-independent on all real data.
- Repeat scans drop from 23 s on main to 0.23 s.
- The cold scan blocks the event loop no worse than main does.

Two Low findings remain (byEffort turns and the effort-less cost gap). Neither affects anything
displayed today.

## How I checked

- **Real data, read-only:** I ran the branch's `computeTuning(0)` against this machine's
  `~/.claude/projects` (8.4k files, 4.7 GB) and measured time, retained heap and event-loop delay.
  I ran the same probe against main's `usage.ts` for comparison.
- **Python scans over every parent and subagent transcript:** record flags, key copies,
  parent/subagent overlaps, directory layout.
- **Tests:** branch tests from an exported copy of the tree: electron `npx vitest run`, 51 files,
  932 tests, all pass. Root `src/renderer/lib/tuning.test.ts`: 29/29. `npm run typecheck` is clean.

Real-data probe (cold = empty caches; warm = 31 s later, after the 30 s cache has expired):

| | main a29c015 | branch |
|---|---:|---:|
| cold scan | 13.9 s | 14.9 s (38 s once, on a loaded machine) |
| repeat scan after 30 s | 23.2 s (full re-parse) | 0.23 s (stat only) |
| event-loop max delay during the cold scan | 622 ms | 552 ms (2.7 s in the loaded run) |
| event-loop p99 | 150 ms | 102 ms |
| heap retained after the scan | 21 MB | 39 MB |
| total cost | $12,169 | $13,284 (+$1,116 subagent spend) |

The session-turn counts differed by 8 between the two runs: 82,959 on the branch against 82,967 on
main. Live lanes appended turns between the runs: a branch re-run 2 minutes later read 82,995. The
branch does not drop any turn.

## Findings by severity

### Low

**1. `byEffort` counts subagent records as turns under the lane's session, under the subagent's model.**
`usage.ts:464-468`.
- Real data: `byEffort` turns sum to 101,213, while `bySession` turns sum to 82,959. The 18,254
  extra are subagent records.
- A Sonnet subagent of an Opus lane produces a `(lane session, sonnet, effort)` row. That row
  describes the subagent, not the lane.
- The cost side is intended (rows sum to the cost), and the comment says so. The turn side breaks
  the rule `computeTuning` applies everywhere else, that a subagent record is not a lane turn.
- No impact today: `TuningView` passes `byEffort` to `joinLanes`, and `lib/tuning.ts` only
  declares it in the input type (`tuning.ts:59`); nothing reads it.
- Fix direction: add `turns` only for non-sidechain records, or add a `subagent` marker to the row,
  before anything renders it.

**2. `byEffort` no longer reconciles exactly with `totalCost`.** `usage.ts:464`.
Records without `effort` are left out of `byEffort`. 668 of the 39,148 subagent usage records have
no `effort`. On real data, `byEffort` cost is $13,280 against a `totalCost` of $13,284: $3.6 short
(0.03%). On main the two matched to the dollar. If reconciliation is a stated invariant, an `effort:
'unknown'` row, or a check in the test, would keep it. Cosmetic today, for the same reason as
finding 1.

**3. Concurrent cold loads are not shared.** `usage.ts:118` (`load`).
`cache` is set only when a load finishes, and the in-flight promise is not stored. A second
`getTuning` during a cold scan (changing the day window in `TuningView` while it loads) runs a
second full scan in parallel: double CPU and double event-loop stalls for about 15 s. The same
pattern exists on main, where it cost 14–23 s per extra call. Storing the in-flight promise would
fix it. `TuningView` is the only renderer caller: `getUsageStats` and `getUsageInsights` have no
renderer callers.

### Info

**4. `subagentPct` is now non-zero.** It is attributed per session (`computeInsights`): any session
that used a subagent counts all of its tokens. This is the existing definition; it measured 0 until
now because no sidechain record was ever read. Its value will jump, and the label should say "share
of tokens in sessions that used subagents".

## The six questions from the brief

**(1) The dedupe.**
- Real data, 101,521 keys:
  - 70,387 keys have more than one copy.
  - No key's copies differ in input, cache read or cache write. Only `output_tokens` varies.
  - No key has two max-output copies that differ in anything else.
- So max-output-wins picks the same numbers whatever the order, and it cannot take one message's
  usage for another's. The key is `message.id:requestId`, and `keep` copies only the usage fields;
  `model`, `session`, `sidechain`, `day` and `tsMs` stay from the first copy.
- No double counting: one index runs across all files, and the per-file dedupe in
  `parseTranscript` reduces each file to its max before the global merge.
- The 18 fork-replay keys: all 18 have equal usage on both sides, and all are in the same session
  and slug as their parent. Parents are queued before subagents within a slug, so the parent row
  (`sidechain: false`) is kept.
- Cross-file duplicates otherwise: 732 parent→parent across sessions (forks and resumes) and 395
  subagent→subagent across sessions, all within one slug. The first file in readdir order gets the
  credit. Main did the same, so nothing changes there.
- The change from first-wins to max-wins moved parent-file totals by less than $1. The $1,115
  increase is subagent spend.

**(2) Recursion.**
- At slug level, only entries named `*.jsonl` are taken as parents. Only `<entry>/subagents/` is
  walked, so tool-result folders, `memory/` and other files under a session directory are not
  read.
- Under `subagents/`, I found 327 `.jsonl` files (314 at depth 0, 13 at depth 2 under
  `workflows/<id>/`) and 326 `.json` meta files. The `.json` files are skipped.
- `readdir({ withFileTypes: true })` reports a symlinked directory as not a directory, so
  `subagentFiles` never follows one, and a symlink loop cannot be walked. There are no directory
  symlinks on disk.
- Every subagent record has `isSidechain: true` (39,148 of 39,148), so the `r.sidechain` test
  separates them correctly. Using `f.subagent` would not depend on that flag, but the flag holds
  today.

**(3) Tuning.**
- In `bySession`, sidechain records add only to `tokens`, `cost`, `subagentTokens` and
  `subagentCost`. `turns`, `highContextTurns`, `contexts` (median), `model` and `effort` come from
  the lane's own records.
- `modelTsMs` replaces the old comparison against `lastTsMs`. A subagent record with a later
  timestamp therefore cannot relabel the lane, and the old ordering defect is gone.
- Parent files have no sidechain records (82,985 of 82,985 are main-thread), so no parent turn is
  dropped.
- `byEffort`: see findings 1 and 2.

**(4) The parse cache keyed on (path, size, mtime).**
- **Same-second append:** any append changes `size`, and `mtimeMs` on APFS has sub-millisecond
  resolution, so a stale entry would need a same-length rewrite inside the same mtime tick. A file
  read mid-write leaves a partial last line, which fails `JSON.parse` and is skipped. The next
  append changes the size and forces a re-parse.
- **Memory:** 39 MB retained after a full scan, against 21 MB on main, which also kept its merged
  `cache` for the life of the app. The growth is bounded by the number of usage records, not by
  file bytes: no raw text is kept.
- **Deleted files:** evicted at the end of every full load (`live` set). A file whose `stat`
  succeeds but `readFile` fails is skipped for that load and retried next time.

**(5) Main-process blocking.**
- The cold scan does not block for 15 s at a stretch. Each file's read is async, and only that
  file's `split` and `JSON.parse` run synchronously.
- The worst stall is the largest file: `-Users-juanmnl-Developer-mantel/aa3329e9-…jsonl`, 330 MB.
  Its synchronous part takes 468 ms on the branch against 557 ms on main, because the new
  `"usage"` / `compact_boundary` pre-filter parses 6,682 lines instead of 33,327.
- The largest subagent file is 19 MB, 27 ms.
- During that stall, IPC replies, the 1 s transcript tick and pty forwarding to the renderer are
  delayed. The renderer itself is a separate process and keeps running; I found no `sendSync` in
  the codebase.
- So the cold scan is no worse than main. Repeat scans improve from a 23 s full re-parse to a
  0.23 s stat pass, which removes most of the main-process load the Tuning page caused.
- One loaded run reached 38 s and a 2.7 s stall. Under load the worst case is several times the
  idle numbers.

**(6) The fast-rate fallback and the api-request types.**
- `rates()` now matches `tNt()`: opus-5-5 fast 8/40/0.4; opus-5* and 4-8 fast 10/50; 4-6 and
  4-7 fast 30/150; every other Opus id, Opus 4.0 and 4.1 included, at its standard rate when fast.
  The comment is corrected.
- `claude-opus-4-0` still prices at 5/25 (Low finding 1 of the usage-prices review). It does not
  appear on disk.
- The three api-request prefixes include the closing quote (`{"type":"api-request"`,
  `…-shape"`, `…-blob"`), so the match is exact, and a future `api-request-*` type reaches the
  parser.

## Recommendations for the coordinator

- Merge.
- **Optional follow-ups for Code:**
  - Stop counting subagent turns in `byEffort` (finding 1).
  - Add an effort-less row or a reconcile check (finding 2).
  - Share the in-flight load (finding 3).
  - Correct the `subagentPct` label (finding 4).
