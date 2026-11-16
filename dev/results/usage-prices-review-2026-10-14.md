# Review: usage prices from 2.1.300, api-request skip — 2026-10-14

Branch `operator/f25fc0`, commit d45bc78, compared with main b8ae343. Binary:
`~/.local/share/claude/versions/2.1.300`. I reviewed the diff to `electron/src/main/usage.ts` and
`transcript.ts` (`poll`, `apply`), the test changes, and the lane's note. No fixes made.

**Verdict: no correctness regressions. Mergeable.** I re-derived every price from the binary, and
all of them match except two edge cases, both covered below (findings 1 and 2). Neither occurs in
the transcripts on this machine.

## How I checked

- I extracted the baked catalog (`schema_version:1,pricing_tiers:{…},models:[…]`) and the cost
  functions (`tNt`, `Qft`, `lI`, `iI`, `aI`, `Jft`, `_L`) with `strings`.
- I ported `rates()` to Python and ran it against every provider id in the catalog (72 ids:
  first_party, bedrock, vertex, foundry, mantle, gateway). Each result was compared with the
  catalog's `pricing` tier.
- I scanned every transcript, top-level files and `subagents/*.jsonl` (206,097 usage records), for
  model ids, `usage.speed`, `inference_geo` and cache-write splits. I also read all 705
  `api-request*` lines on disk.
- I ran the branch tests from an exported copy of the tree: `usage.test.ts` plus
  `src/main/transcript*`, 5 files, 136 tests, all passed.

## Prices re-derived from the binary

`pricing_tiers`, $/Mtok (input / output / cache_write_5m / cache_write_1h / cache_read):

| tier | values | branch |
|---|---|---|
| `haiku_55` | 0.1 / 0.5 / 0.125 / 0.2 / 0.01; `long_prompt` above 1e5: 0.5 / 2.5 / 0.625 / 1 / 0.05 | matches |
| `tier_4_20_cache_read_0_20` (opus-5-5) | 4 / 20 / 5 / 8 / 0.2 | matches |
| `tier_2_10_cache_read_0_10` (sonnet-5-5) | 2 / 10 / 2.5 / 4 / 0.1 | matches |
| `tier_10_50_cache_read_0_25` (fable-5-1, mythos-5-1) | 10 / 50 / 12.5 / 20 / 0.25 | matches |
| `tier_15_75` (opus-4-0, 4-1) | 15 / 75 / 18.75 / 30 / 1.5 | matches |
| `tier_5_25`, `tier_2_10`, `tier_3_15`, `tier_10_50`, `haiku_45` | standard 0.1× cache read | match |

Fast mode in `tNt()`, the billing path: `claude-opus-5-5` → `Uy` = 8 / 40, cache read 0.4.
`claude-opus-4-8` and `claude-opus-5` → `Sa` = 10 / 50, cache read 1. `claude-opus-4-6` and
`claude-opus-4-7` → `Ny` = 30 / 150, cache read 3. All match the branch.

Every tier writes the 5m cache at 1.25× input and the 1h cache at 2× input. That includes the
Haiku long tier and every fast table, so the fixed multipliers in `cost()` stay correct.

Of the 72 catalog provider ids, the branch's `rates()` agrees on 67. The 5 that disagree: the 4
Haiku 3.5 ids, which the lane documented (priced at 1 / 5 instead of 0.8 / 4, which over-reports),
and `claude-opus-4-0` (finding 1).

## Findings by severity

No High or Medium findings.

### Low

**1. `claude-opus-4-0` prices as Opus 5 (5 / 25), not 15 / 75.** `usage.ts:47`.
`/opus-4(?!-\d(?!\d))/` deliberately does not match `opus-4` followed by `-<one digit>`, and
`-0` is one digit, so the regex misses. No earlier `includes()` catches it either, and it falls to
the generic Opus row.
- Claude Code's `_L()` does not reach its own copy of this regex for that id. It resolves exact
  provider ids first (`Vme`), then the structured parser (`yc` / `CM` → `hL`), and only then the
  `includes()` chain.
- What the regex does with real ids, which is what the brief asked:
  - `claude-opus-4`, `claude-opus-4-20250514`, `claude-opus-4@20250514` and
    `us.anthropic.claude-opus-4-20250514-v1:0` → 15 / 75. Correct.
  - `claude-opus-4-5-20251101`, `claude-opus-4-6[1m]` and `claude-opus-4-8` do not match. Correct.
  - A hypothetical `claude-opus-4-10` would match and price as 4.0. Claude Code's regex does the
    same.
- Impact: `msg.model` in a transcript is the API's resolved id (`claude-opus-4-20250514`), and the
  ids on disk are only opus-5-5, opus-5, sonnet-5, sonnet-5-5, fable-5-1, opus-4-8, opus-4-7 and
  haiku-4-5-20251001. So this under-reports only if `claude-opus-4-0` ever appears as the recorded
  id. The fix is one extra `includes('opus-4-0')`.

**2. Fast mode on an Opus outside the fast list is priced at 30 / 150. Claude Code bills it at the
model's standard rate.** `usage.ts:47`, `usage.ts:49-52`; the comment at `usage.ts:35-37` and the
lane's note.
`Jft()`, which the lane cites, is the price string shown in the fast-mode picker
(`Vsn` / the fast-mode toggle message). The billing path is `tNt()`. When `speed==="fast"` and the
model is not opus-5-5, 4-8, 5, 4-6 or 4-7, it falls through to `gX[r]`, the catalog rate.
- So Opus 4.0 / 4.1 fast bills at 15 / 75 (the branch says 30 / 150), and Opus 4.5 fast bills at
  5 / 25 (the branch says 30 / 150).
- This over-reports, which is the direction the module says it prefers. It is not a "matches
  `/cost`" claim, though, so the comment should say "pessimistic" rather than "Claude Code
  prices it…".
- No record on disk has `speed: "fast"`: the values are `standard` (172,084) or null (34,013).

**3. The prefix test drops any record type that starts with `api-request`.** `usage.ts:63`.
The binary has exactly three such types (`api-request`, `api-request-shape`, `api-request-blob`),
and none carries usage, turn or tool state. A future `api-request-error` or similar would be
skipped silently. This is acceptable today. An exact type set (`"api-request"`,
`"api-request-shape"`, `"api-request-blob"` followed by `"`) would remove the risk at the same
cost.

### Info

**4. Some pricing inputs Claude Code has are invisible to Operator:**
- The `alder_ford` remote promo override (`Gy` / `jd`) can price model X as model Y until a date.
- `additionalModelCostsCache` holds gateway-supplied costs.
- Org or policy `modelPricing` can apply a multiplier.
- `aI()` applies 1.1× for `inference_geo === "us"`. On disk the values are `not_available`
  183,409, `global` 22,666, and never `us`.

Where any of these apply, the Usage page will differ from `/cost`. Worth one line on the page or
in the note, not a code change.

**5. Unknown model ids.** Claude Code bills an unknown id at the default main-loop model's rate
(`gX[qe(Dl())]`). `usage.ts` uses 5 / 25. This predates the branch and is documented as
deliberate.

## Questions from the brief

- **What the long-prompt tier counts as prompt tokens.** Claude Code's `lI()` counts
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens > abovePromptTokens`,
  strict `>`. When the tier applies it prices the whole turn at the long rates, output and cache
  writes included. The branch passes `r.context` = input + cacheRead + cache5m + cache1h. That
  equals the binary's sum whenever the 5m/1h split equals `cache_creation_input_tokens`; records
  without the split put the whole total in cache5m. On disk, 0 records have a split that differs
  from the total. Equivalent, and `cost()` applies the long tier to output and both cache writes
  through the same row. Correct.
- **`api-request` lines no longer bump `lastActivityAt`.** This is not a regression. In the
  files that have them, each `api-request` record follows the record that triggered it (`user`
  208, `attachment` 76, and so on), which already set `lastActivityAt`. The gap from that record
  to the `api-request` timestamp has a median of 0.044 s, a p95 of 0.5 s and a maximum of 16.1 s
  (322 samples). No file ends on an `api-request` record. `api-request-blob` has no timestamp at
  all.
  Consumers of `lastActivityAt`: relative times on the dashboard and in the session view, the quit
  guard's `liveLanes`, and `dispatch.ts:106`, which picks the most recently active lane. A lag of
  less than a second (16 s at worst) changes none of them in practice.
- **`api-request` lines no longer end an open sidechain.** This is not a regression. All 301
  `api-request` records have `querySource: "repl_main_thread"`, so none belongs to a subagent.
  None of the 400 most recently modified main transcripts contains an `isSidechain: true` record:
  current versions write subagents to `<session>/subagents/*.jsonl`, so `inSidechain` never
  becomes true in a 2.1.300 main file. In older files, any non-sidechain record (an attachment,
  `last-prompt`, …) already closed the sidechain, so taking away one more closer changes nothing
  that can be observed.
- **Can the prefix test miss a record?** On disk, all 705 `api-request*` lines start with
  `{"type":"api-request`. `type` is the first key, and Claude Code writes them with
  `JSON.stringify` and no whitespace. A miss, from reordered keys, whitespace or a BOM, would only
  mean the line goes through `JSON.parse` and the `default:` branch of `apply`, which is main's
  behaviour: slower, but no wrong state. `usage.ts` already ignored these lines, because they
  have no `message.usage`, so there the skip only saves time. There is no false positive from
  quoted text: every other record starts with `{"parentUuid"` or another key, and the branch has
  a test for a user turn that quotes the string.

## Checked and clean

- The order of the `includes()` checks: no earlier row catches an id meant for a later one. I
  checked all 72 catalog ids, plus dated and `[1m]` variants.
- `claude-sonnet-4-20250514` and bare `claude-sonnet-4` price at 3 / 15. Correct.
- `transcript.ts` importing from `usage.ts`: `usage.ts` imports only `node:*` and shared types,
  so there is no cycle.
- The test edits: moving the fixture default from `claude-opus-4` to `claude-opus-5` follows
  directly from Opus 4.0 now pricing at 15 / 75. The new cases cover the threshold at
  100,000 / 100,001, cache counting toward the threshold, and the api-request interleaving.

## Recommendations for the coordinator

- Merge.
- Optional one-line follow-ups for Code: `includes('opus-4-0')` (finding 1); correct the
  fast-mode comment, or price fast at the standard rate outside the list to match `tNt` (finding
  2); use an exact type set for the skip (finding 3).
- The lane's open item stands: subagent transcripts under `<slug>/<session>/subagents/` are not
  read by `usage.ts`. Haiku and most subagent spend are missing from the Usage page.
