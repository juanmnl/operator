# Channel prose — a ceiling, not a cap

Answers `dev/briefs/channel-prose-wider.md`. `PROSE` 470 → **900**, plus the two knock-ons that
turned out to matter more than the constant.

---

## The new measure

`PROSE = 900` as a **ceiling the body grows into** — `max-width` plus the row's flex is the clamp;
there is no lower bound to enforce beyond what the pane gives, and the narrow path already has its
own behaviour.

Your reasoning holds and I'd underweighted it: 60–80 is calibrated for **sustained** prose, where
the eye repeatedly hunts for the next line's start. This feed is scanned in bursts against a
constant left edge, four lines at a time. Different reading task, different measure.

## Chars per line, three widths

```
pane (content)        before        after
 712px (706)       470px / 79    574px / 96     ← grows with the pane
1152px (1146)      470px / 79    900px / 151    ← at the ceiling
1812px (1806)      470px / 79    900px / 151    ← at the ceiling
 326px (narrow)    258px / 43    258px / 43     ← unchanged, action rail still drops
```

Measured, not derived from px-per-char — your ~150 estimate came out at **151**.

## What happened to the fold — it got *less* aggressive

Your hypothesis, checked rather than assumed. Same two bodies, same 4-line clamp, 1812px pane:

```
                        before (470)              after (900)
median  535 chars   7 lines → 4 shown, 57%    4 lines → NOT FOLDED, 100%
p90    1298 chars  17 lines → 4 shown, 24%    9 lines → 4 shown, 44%
```

**A median dispatch no longer folds at all.** The p90 nearly doubles what's visible before the
fold. So the wider measure didn't trade readability for hiding — it improved both, which is the
part I'd have got wrong by reasoning about line length alone.

## The hover action orphaned again, worse — and the fix

You were right to flag it. At the 900 ceiling the action sat at `ROW_MAX` regardless of how much
was said, so a five-character **"Done." left it 877px from its own last word** — twice as bad as
the 880 failure, because the ceiling doubled.

`ROW_MAX` following `PROSE` was necessary but not sufficient: the row's content wrapper was
`width: 100%`, so it always claimed the ceiling. It is `width: fit-content` now (capped at
`ROW_MAX`), so the wrapper hugs its widest child and the action follows the *text* rather than the
*limit*:

```
message                    last word → action
"Done." (5 chars)          877px  →  168px   (now bounded by its own meta line, which is wider)
134 chars                  145px  →   10px   (exactly one gap)
559 chars, wrapped         391px  →  391px   (unchanged, and correct — see below)
```

The 559-char case is a wrapped paragraph whose *final* line happens to be short; the action sits
10px past the paragraph's right edge in every case (`bodyRightToAction: 10` throughout). That is
inherent to right-hand furniture beside wrapped text, not a defect.

A second benefit of `fit-content`: a line now wraps only when it genuinely exceeds the ceiling,
rather than being folded into a column narrower than it needed.

## Path chips — the eager break is gone

You noted that breaking an atomic `parseInline` chip mid-token is doubly bad. Two settings were
doing exactly that, and both were mine:

- the body's `overflow-wrap: **anywhere**` — breaks *eagerly*, splitting a token to tighten the
  current line even when the whole token would fit on the next. Now `break-word`, which breaks
  only a token too long for a line of its own. (`anywhere` was added for a narrow-pane overflow
  that turned out to be the paused banner, fixed at its source — so the eager break was buying
  nothing.)
- the code chip's `word-break: **break-all**` — same problem, one level in. Removed.

**Honest limitation:** chips can still break at a **hyphen**, which is a legitimate CSS break
opportunity that `overflow-wrap` does not govern —
`dev/briefs/prune-seeded-idle-`/`lanes-RESULT.md` in `/tmp/operator-shots/prose-wide.png`. Making
chips atomic needs `white-space: nowrap`, which is safe at 900px (the longest realistic path is
~360px) but would overflow the 258px narrow pane. I left it: the chip's background runs across the
break so it still reads as one token, and the alternative trades a cosmetic wrap for a real
overflow. Worth revisiting if it grates.

## Kept, unchanged

The shared 16px left edge (measured 16/16/16 at all three widths), the full-bleed row, the 4-line
clamp, the composer's own 720 cap, the left-anchored day separator, author-run grouping (12 labels
→ 5), `parseInline` (0 literal backticks, 8 chips), the copy action's focus state, the paused
notice, sticky day separators.

## Verified

- `npm run build` clean. `npm test` **533/533**.
- Narrow pane (326px content) still works: 43 chars, no horizontal overflow, action rail still
  drops rather than the avatar.
- Scroll drift on a 1400→900 reflow is **−1px** (was 0). The 1px is `fit-content` re-resolving the
  wrapper width during the re-measure; it is a rounding artifact, not the 16px drift the anchoring
  exists to prevent.
- **No theme pass** — this pass changed widths and wrap modes only. No colour, token or ink.
- Updated the driver's own 4b message, which still asserted the old "want 60–80" target. A
  verification that keeps stating a goal you've deliberately moved off is worse than none.
