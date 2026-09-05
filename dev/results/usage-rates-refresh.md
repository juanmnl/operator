# Result — usage cost model brought up to date

Base `main` = `70da6a8`. Branch `operator/101200`, worktree `~/.operator/worktrees/operator-101200`.
All three defects addressed; fast mode **implemented**, because the signal turned out to be there.

## Verification — all four suites

| Suite | Baseline | After |
|---|---|---|
| `npx vitest run` (renderer) | 1042 pass / 33 fail | **1042 pass / 33 fail** — untouched (usage lives in electron) |
| `cd electron && npm test` | 415 pass / 0 fail | **426 pass / 0 fail** (+11; `usage.test.ts` 20 → 33) |
| `cargo test` (src-tauri) | 173 pass / 0 fail | **179 pass / 0 fail** (+6; usage module 10 → 16) |
| `electron: npm run typecheck` | clean | **clean** |
| `npx tsc --noEmit` | clean | **clean** |
| `npm run build` | clean | **clean** |

The 33 renderer failures are the known pre-existing jsdom/`localStorage` files; the renderer suite
does not exercise `usage.ts` at all, so the count is identical by construction.

## The final table

`rates(model, fast)` now returns a **triple** — `(input, output, cacheRead)` in $/1M tokens —
identically in `electron/src/main/usage.ts` and `src-tauri/src/usage.rs`, same order, same rules:

| Match (first hit wins) | input | output | cache-read |
|---|---|---|---|
| `fable-5-1` | 10 | 50 | **0.25** (flat) |
| `fable` \| `mythos` | 10 | 50 | 1.0 |
| `opus` + `fast` | **10** | **50** | 1.0 |
| `opus` | 5 | 25 | 0.5 |
| `sonnet-5` | **2** | **10** | 0.2 |
| `sonnet` | 3 | 15 | 0.3 |
| `haiku` | 1 | 5 | 0.1 |
| *anything else* | 5 | 25 | 0.5 |

Every rate was re-verified against the installed `claude-api` skill's model table, not from memory.

Two structural points. **Cache-read is derived, not hand-copied**: a `tier(input, output)` helper
computes `input × 0.1`, so the default can never drift from the input rate it is a tenth of; only
Fable 5.1 writes a literal. And **the flat multiplier is gone from `cost()`** — it reads `rcr` out
of the table like the other two rates, per the brief. Cache-**write** multipliers (1.25× / 2×) are
untouched.

## Defect 1 — Sonnet split by version

`sonnet-5` is matched before the bare `sonnet` fallback, so a dated id (`claude-sonnet-5-20260101`)
and a future point release (`claude-sonnet-5-1`) both inherit the 2/10 tier with no new table row.
Both cases are pinned by tests in both languages.

**The bare-alias ambiguity is resolved pessimistically**, as the brief directs and as the module's
existing unknown-model rule already implies: a version-less `sonnet` takes the **higher 3/15**, and
only a confident `sonnet-5` match takes 2/10. The reasoning is written into the comment at the
table, not just here: over-reporting is recoverable, a cost view that quietly under-reports is not.
`rates("sonnet")` → `(3, 15, 0.3)` has its own named test on both sides.

## Defect 2 — per-model cache-read rate

Scoped to `fable-5-1` specifically, as instructed. The scoping is not just caution — it is
**positively supported**: the current model documentation lists "cache reads at $0.25/MTok" among
the things Fable 5.1 *adds over* Claude Fable 5 (which is still served at the same per-token
price), and explicitly records that whether **Mythos 5.1 shares that rate is open at launch**. So
`claude-fable-5` and every `mythos` id keep the 0.1× default rather than take a discount nobody
has confirmed. Tests pin all three.

**Transcript evidence on the open question: none, and that itself is the finding.** Scanning all
7,248 `.jsonl` files (451,480 lines) turned up exactly seven distinct model ids, and
`claude-fable-5-1` is not among them — see the corpus table below. Transcripts carry no prices, so
they could not settle Fable 5 vs 5.1 either way; what they do show is that the distinction is
currently *unexercised* on this machine.

## Defect 3 — fast mode: the signal EXISTS, so it is implemented

This is the item the brief left conditional. The answer is **signal present**.

```
usage.speed on message.usage : 132,245 records
  'standard'                 : 132,223
  null                       :      22   (all of them <synthetic>, which the parser already skips)
  'fast'                     :       0
usage.speed on message       :       0   (not there)
speed at top level           :       0   (not there)
```

Claude Code persists the API's own `usage.speed` verbatim on every real assistant record — it sits
alongside `input_tokens`, `service_tier`, `inference_geo` and `iterations`. So the field is real,
typed, and universally present, which is exactly the condition the brief set for implementing.

It is honoured the narrow way: `fast: usage.speed === 'fast'` on the record, and a fast **Opus**
turn bills 10/50. **Nothing is inferred from timing or any proxy.** Two deliberate limits, both
commented at the table:

- **Opus only.** Fast mode is an Opus 5 / Opus 4.8 research preview, so no other family consults
  the flag — a test asserts `speed: 'fast'` on a Sonnet record changes nothing.
- **Opus 4.8's fast rate is not separately published.** It is priced with Opus 5's 10/50, which is
  the pessimistic reading and consistent with the rest of the module.

Worth stating plainly: **`'fast'` appears zero times in 451,480 lines**, so this changes no number
in the usage view today. It is correct the moment a fast turn lands, and it costs one field read.

## What this actually does to the real numbers

Replaying the whole corpus through the old and new tables (same de-duplication as `loadRecords`):

| model | old $ | new $ | delta |
|---|---:|---:|---:|
| `claude-opus-5` | 10,595.92 | 10,595.92 | — |
| `claude-fable-5` | 7,727.08 | 7,727.08 | — |
| `claude-sonnet-5` | 1,616.50 | 1,077.67 | **−538.83** |
| `claude-opus-4-8` | 217.98 | 217.98 | — |
| `claude-opus-4-7` | 0.27 | 0.27 | — |
| `claude-haiku-4-5-20251001` | 0.13 | 0.13 | — |
| **total** | **20,157.89** | **19,619.05** | **−538.83 (−2.67%)** |

## Where the brief was wrong, and where it was right in a way the data qualifies

**The brief calls the cache-read defect "the largest distortion in the usage view, bigger than the
Sonnet error." On this machine's actual data it is currently the smaller one — it moves $0.00.**
There is no `claude-fable-5-1` traffic on disk; all 30,663 Fable rows are `claude-fable-5`, which
correctly keeps the 0.1× rate. The one defect that moves money today is Sonnet: 26,417 rows, all of
them `claude-sonnet-5`, over-billed by 50% on input and output. (Relatedly: there are **zero**
`claude-sonnet-4-6` rows, so the 3/15 branch and the bare-alias rule are both, for now, purely
defensive.)

The brief's *magnitude* claim is nonetheless right, just forward-looking. `claude-fable-5` alone
carries **10.4 billion cache-read tokens**. If that traffic were on 5.1, the per-model rate would
correct roughly **$7,825** of over-report — an order of magnitude past the Sonnet fix, and
confirmation that cache reads really are what an agent session is made of. The fix is in place and
will apply the day a 5.1 id appears; it simply has nothing to bite on yet.

## Corpus surveyed

7,248 `.jsonl` files across 245 project directories, 451,480 lines. Model ids present, all-time:

| model id | rows | cache-read tokens |
|---|---:|---:|
| `claude-opus-5` | 79,682 | 24,817,890,429 |
| `claude-fable-5` | 30,663 | 10,433,883,204 |
| `claude-sonnet-5` | 26,417 | 6,195,786,949 |
| `claude-opus-4-8` | 1,348 | 736,009,255 |
| `claude-haiku-4-5-20251001` | 29 | 734,128 |
| `<synthetic>` | 22 | 0 (skipped by the parser) |
| `claude-opus-4-7` | 4 | 122,599 |

## Files changed

```
 M electron/src/main/usage.ts        M electron/src/main/usage.test.ts
 M src-tauri/src/usage.rs            (implementation + its inline #[cfg(test)] module)
```

Both carry the same table, the same ordering, the same cache-read rule and the same fast-mode rule;
`usage.rs` names the TS file in a comment so the pairing is discoverable from either side.
