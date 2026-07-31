# Brief — the prose cap is too tight. Let it grow.

User, on the shipped full-bleed layout: **"why can't the text be wider on the channel?"**

They're right, and the cap was my instruction, not your error. Widen it.

## Why 79 was the wrong number here

`PROSE = 470` (~79 chars) came from the 60–80 guideline. That guideline is calibrated for
**sustained** prose — long documents read for minutes, where the eye repeatedly hunts for the next
line's start. This feed is **scanned in bursts**: entries are a few lines, clamped to 4, and the
eye returns to a known left edge constantly. Different reading task, different measure.

Two more arguments against 79 that we both underweighted:

- **The reference apps don't do it.** The user named Slack and Mattermost. Neither caps a message
  near 79 characters; both let messages run much wider on a wide window.
- **This content is path-heavy.** `dev/briefs/channel-timestamps-utc-RESULT.md` is 43 characters
  by itself. At 470px, paths and code spans wrap constantly, and a wrapped path costs more
  legibility than a long line does. Your own `parseInline` chips make those spans visually
  atomic — so breaking them mid-token is doubly bad.

## What to do

**Let the body grow with the pane, up to a ceiling.** A `clamp()`, not the current hard cap.

- **Ceiling: ~900px (~150 chars at the body's measured ~5.95px/char).** Roughly a comfortable
  wide-window maximum in the apps the user is comparing against — wide enough that paths stop
  wrapping, bounded so the 1812px pane doesn't become a 300-character wall.
- **Floor:** whatever keeps the narrow pane (Plan/Diff open, `NARROW_AT`) sane — you already
  measured 33 chars at a 326px pane with the action rail present, so keep that path working.
- Measure the real chars/line rather than trusting my px-per-char arithmetic; you already caught
  one arithmetic-vs-measurement gap on this file (520px "looked right" and came out at 87).

`ROW_MAX` is derived from `PROSE`, so it follows automatically — but re-check the hover action
still sits near the last word at the new ceiling rather than orphaning again. That was the 880px
failure the first time round, and a wider prose column changes where the action lands.

**Keep everything else.** The shared 16px left edge, the full-bleed row, the 4-line clamp, the
composer's own 720 cap, the left-anchored day separator. This is one constant and its knock-ons.

## If you disagree, say so

If measuring at the ceiling shows something genuinely bad — the 4-line clamp now hiding far more
because lines got longer, say — report it rather than quietly splitting the difference. The clamp
interacts with the measure: wider lines mean 4 lines holds more, which should make the fold *less*
aggressive, but check rather than assume.

## Verify

- Chars/line at the same three pane widths as last time (712 / 1152 / 1812), before and after.
- The narrow-pane case still works.
- How much of a median (520-char) and p90 (1165-char) dispatch now fits in 4 lines, versus before.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `65175d1`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-prose-wider-RESULT.md`: the new clamp, measured chars/line at three widths,
what happened to the fold, and whether the hover action still sits right. Then one OPERATOR-REPLY line.
