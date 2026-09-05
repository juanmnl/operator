# Brief — bring the usage cost model up to date

Base: **`main` = `70da6a8`** (both prior branches merged; verified 1042 pass / 33 pre-existing).
This is the work that was fenced OFF in `effort-ladder-update.md`. It is now in scope.

Two files hold the same table and must stay in step:
`electron/src/main/usage.ts` (the shipped Electron path) and `src-tauri/src/usage.rs` (the Rust
port). Same function, same tests, both need the change.

## The current table, and what is wrong with it

```
fable|mythos → (10, 50)   opus → (5, 25)   sonnet → (3, 15)   haiku → (1, 5)   else → (5, 25)
```

Verified current rates, $/1M tokens (input, output):

| Model | Rate | Table says |
|---|---|---|
| Fable 5.1, Fable 5, Mythos 5.1 | 10 / 50 | ✅ correct |
| Opus 5, 4.8, 4.7, 4.6 | 5 / 25 | ✅ correct |
| **Sonnet 5** | **2 / 10** | ❌ bills 3 / 15 |
| Sonnet 4.6 | 3 / 15 | ✅ correct |
| Haiku 4.5 | 1 / 5 | ✅ correct |

### Defect 1 — Sonnet is no longer one rate

A substring match on `sonnet` cannot separate Sonnet 5 (2/10) from Sonnet 4.6 (3/15). Match the
version: `sonnet-5` before the bare `sonnet` fallback. Note `sonnet-5` also matches a future
`sonnet-5-1`, which is the behaviour we want — same tier, and the substring design exists precisely
so a point release needs no table entry.

**The ambiguous case needs a deliberate answer**: a bare alias `sonnet` with no version (rare —
transcripts carry full ids, but `<synthetic>` and hand-written fixtures exist). The file's existing
principle is pessimistic: an unknown model bills at the *Opus* rate "because a silent 0 reads as
'this cost nothing'". Stay pessimistic — bare `sonnet` takes the HIGHER 3/15, and only a confident
`sonnet-5` match takes 2/10. Under-reporting is the failure mode this module already refuses.

### Defect 2 — cache reads are not a flat 0.1× on every model

`cost()` hardcodes `cacheRead × input_rate × 0.1`. Correct for Opus / Sonnet / Haiku. **Wrong for
Fable 5.1, whose cache reads are $0.25/Mtok flat**, not 0.1 × $10 = $1.00. A 4× over-report on the
model the coordinator lane runs, on the traffic type agent sessions are mostly made of — this is
the largest distortion in the usage view, bigger than the Sonnet error.

- Make the cache-read rate a **third value returned alongside (input, output)**, defaulting to
  `input × 0.1`, overridden to `0.25` for Fable 5.1. Do not special-case it inside `cost()` with a
  model string test — the rate belongs with the other rates, in one lookup.
- **Scope it carefully and say what you did.** $0.25 is documented for Fable **5.1**. Whether Fable
  5 (`claude-fable-5`, still served) and Mythos 5.1 share it is *not* established. Match `fable-5-1`
  specifically rather than all `fable`, and write the uncertainty into the comment. If you find
  evidence either way in real transcripts, say so in the result file.
- Cache WRITE multipliers (1.25× for 5m, 2× for 1h) are unchanged and correct. Don't touch them.

### Defect 3 — fast mode, only if the data supports it

Opus 5 fast mode bills **10 / 50**, not 5 / 25. Before implementing anything: **check whether the
signal exists in the data**. Grep real transcripts under `~/.claude/projects/*/*.jsonl` for a
`speed` field on `message.usage` (the API returns `usage.speed`; whether Claude Code persists it is
unknown to me).

- **Signal present** → honour it: a fast-mode Opus turn bills 10/50.
- **Signal absent** → implement nothing. Add a comment naming the gap and report it. Do not infer
  fast mode from timing or any proxy — a guessed 2× on the cost view is worse than a known blind
  spot.

This is the one item where "no change" is a perfectly good outcome. Say which way it went.

## Definition of done

- Both `usage.ts` and `usage.rs` carry the same table and the same cache-read rule. They have
  drifted before; they must not drift here.
- Tests updated in **both**: `electron/src/main/usage.test.ts` (see the existing
  `['claude-fable-5', 10], ['claude-opus-4-8', 5], …` parameterised row — extend it) and
  `src-tauri/src/usage.rs`'s `rates_match_model_family`. New cases at minimum:
  `claude-sonnet-5` → 2/10, `claude-sonnet-4-6` → 3/15, bare `sonnet` → 3/15,
  `claude-fable-5-1` cache-read → 0.25/Mtok, `claude-opus-5` cache-read → 0.5/Mtok (0.1 × 5),
  and the existing unknown-model → Opus-rate guarantee still holding.
- `npx vitest run` no new failures against the **1042 pass / 33 fail** baseline on `main` (I
  measured that myself; the 33 are pre-existing jsdom/localStorage files).
- `cd electron && npm test` (415 pass / 0 fail baseline) and `npm run typecheck` clean.
- `cargo test` green for the Rust side.
- `npx tsc --noEmit` and `npm run build` clean.

## Output

Write your result to the ABSOLUTE path
`/Users/juanmnl/Developer/operator/dev/results/usage-rates-refresh.md`
(absolute — a relative `dev/` path is invisible from your worktree). Cover: the final table, how
the bare-alias ambiguity is resolved, what you found about fast mode in real transcript data, and
test counts for all four suites. Then call `mcp__operator__report`.
