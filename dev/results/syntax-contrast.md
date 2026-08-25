# Syntax ink contrast — six palettes, one floor

**Branch:** `operator/a30080` · 2026-08-24 · Code lane
**Reported by:** QA (`dev/results/qa-2026-08-24.md` — not on disk in any worktree when this was
built; the measurements below are my own, and they reproduce QA's figure exactly).

## What was wrong

The code viewer's `HighlightStyle` borrowed the ANSI tokens (`--magenta`, `--green`, `--yellow`,
`--blue`, `--cyan`, `--fg-muted`) on a stated assumption:

> The ANSI vars are already tuned per palette against that palette's own background, which is why
> they are the right pegs.

True for a **terminal**. False for **11px syntax text on the light palettes** — and my own
`code-navigator-s1-s4.md` flagged it as the thing to check, so this is a predicted failure that
shipped anyway.

Measured against each palette's own `--bg-terminal` (the ground the Files panel and the main-view
overlay both paint behind a transparent CM6 editor):

| palette | ground | keyword | string | number | type | attr | comment |
|---|---|---:|---:|---:|---:|---:|---:|
| mission-control | `#0b0d10` | 7.99 | 11.65 | 11.03 | 8.55 | 11.10 | 6.32 |
| **mission-control-light** | `#F6F8F7` | 5.50 | **2.92** | **3.05** | 4.85 | 5.02 | 4.53 |
| mr-pink | `#22222A` | 5.47 | 11.10 | 11.13 | 5.23 | 8.93 | 7.03 |
| **mr-pink-light** | `#F8F6F8` | 5.61 | **2.67** | **3.03** | 4.81 | 4.98 | **4.16** |
| 1984 | `#0d0f31` | 5.66 | 14.08 | 15.08 | 8.84 | 11.78 | 5.44 |
| **1984-light** | `#e4e5f5` | **2.63** | **2.32** | **1.86** | **2.44** | **2.07** | **4.30** |

Three things worth stating beyond the brief:

1. **QA's 1.86:1 is `--syn-number` on 1984-light**, from `--yellow` = `#FF8D01`. Reproduced to
   two decimal places, which is how I know we are looking at the same defect.
2. **On 1984-light every single role failed**, not just yellow and green — keyword 2.63, type
   2.44, attr 2.07. The brief named two roles; it is six.
3. **Comments failed on all three light palettes too** (4.53 / 4.16 / 4.30), because they used
   `--fg-muted`, which is tuned for meta text at larger sizes, not for a code body.

Every dark palette already cleared the floor. Nothing there needed to move, and nothing did.

## The fix

Six new per-palette tokens — `--syn-keyword`, `--syn-string`, `--syn-number`, `--syn-type`,
`--syn-attr`, `--syn-comment` — defined in **all six** of `src/renderer/themes/*.ts`, and read by
`components/files/cm-theme.ts`.

- **Dark palettes keep the ANSI values unchanged.** They already passed; changing them would be
  churn against a measurement that was fine.
- **Light palettes hold hue and saturation and move only lightness** until the ratio clears the
  floor, so a palette still reads as itself. 1984-light's magenta goes `#F806FA` → `#b204b4`, its
  orange `#FF8D01` → `#975300`; Mission Control-light's green `#0ca678` → `#097e5b`.
- **Comments get their own token, not a dimmed `--fg-muted`.** The memory rule is explicit — the
  token *is* the recede, and stacking opacity on it is the documented way this ink has failed
  before. A test asserts `--syn-comment` contains neither `color-mix` nor `opacity`.
- Targets were generated at **≥4.7:1** rather than exactly 4.5, so a future tweak to a background
  has a little room before it trips the floor.

## The guard

`src/renderer/themes/index.test.ts` computes WCAG contrast for **every syntax token against its
own palette's `--bg-terminal`, across all six palettes**, and fails under 4.5:1. It also asserts
there are six palettes, because "verified by eye" has meant four in this repo's comments for a
while.

**Proved it bites** rather than assuming: putting `#FF8D01` back produced

```
FAIL  syntax ink clears 4.5:1 in every palette > 1984-light
  1984-light --syn-number = #FF8D01 on #e4e5f5 is 1.86:1, under 4.5
```

— QA's number, from the test, before restoring the fix.

## Checks

| | |
|---|---|
| `tsc --noEmit` (root) | **0** |
| `npm test` (root) | **910 passed / 33 failed** — the 33 unchanged, pre-existing jsdom-under-Node-26 |
| `verify:visual` | **passed** — `terminal.png` written |
| `vite build` | green |

**One note on `verify:visual`:** it failed first on `Port 1423 is already in use`. That port is
held by orphaned `mantel` / `mantel-landing` dev servers from a previous run — visible in the
`ps -E` sweep as `OPERATOR_TERMINAL_ID=t4`, i.e. exactly the leak the worktree reaper was built
for. I did **not** kill them (they are not mine to prove dead, which is the reaper's own rule) and
ran the harness on a free port instead: `node scripts/visual/capture.mjs --port 1699`. Worth
knowing that the default picks up `OPERATOR_DEV_PORT`, so any lane whose reserved port is squatted
hits this.

## Not verified

The ratios are computed, not looked at. What a number cannot settle is whether 1984-light's
darkened magenta still reads as *1984* rather than as generic purple — the palettes are an
identity, not only a contrast budget. Worth opening a TypeScript file in the Files view on each of
the three light palettes and saying whether the hues still feel like themselves.
