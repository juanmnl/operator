# Brief — the composer's proportions (follow-up to channel-composer)

User, on the merged build: **"what about this?"** — screenshot of the new composer at a wide pane.

The structure is right. The proportions are not, and it's the same defect the feed pass fixed,
reappearing one level in.

## What the screenshot shows

1. **The container stops well short of the pane's right edge**, leaving a wide empty band beside
   it. The feed above now bleeds edge to edge; the thing you type into looks narrow and adrift
   next to it. Whatever `COMPOSER_MAX` is doing at this width, the result reads as unfinished.
2. **Send is stranded at the container's far right**, roughly the container's whole width away
   from `to everyone` and from where the text begins. This is *exactly* the orphaned-action defect
   you already diagnosed twice in the feed — a round `880` left the hover action 360px past the
   last word, and the 900 ceiling made it 877px. The fix there was `fit-content`, so the action
   follows the **text** rather than the **limit**. The same reasoning applies here and hasn't been.
3. **A lot of empty space inside the box.** One placeholder line, then the action row, and
   noticeable dead height between and around them. At rest the composer should read as compact.

## What I want

Decide the composer's width **in relation to the feed**, and state the rule. It currently relates
to neither the pane nor the rows. Candidates, argue one:

- **Match `ROW_MAX`** — the composer lines up with the messages above it, so the pane reads as one
  column. My lean, because the shared left edge already commits to that and this finishes it.
- **Fill the pane** (minus the inset) — maximally uses the width, but then the composer is wider
  than every message above it, which may read as odd.
- **Keep a separate wider cap** — defensible (writing ≠ reading, which is why `COMPOSER_MAX` is
  720), but then it must not look accidental at 1800px.

Then fix the internal layout so it doesn't have the same problem inside: **Send should sit near
the content, not at a far edge**, by the same `fit-content` reasoning you applied to the row
action. If Send genuinely belongs at the container's right edge, then the container is too wide —
those are the same problem stated two ways.

And tighten the resting height. `rows={1}` auto-grow was right; the surrounding padding is what
reads as slack.

## Constraints

- Keep everything from the composer pass: one container, one target control, chord stated once,
  count inside, inset box-shadow focus ring, the 160px grow ceiling, the feed's bottom mask.
- Keep the shared **left** edge — that is measured and deliberate.
- Narrow pane (Plan/Diff open) must still work; you measured 43 chars there.
- No colour-changing border on a radiused element.

## Verify

- Report the composer's width, the feed row's `ROW_MAX`, and the pane width **at the same three
  widths as the layout pass** (712 / 1152 / 1812). The three numbers side by side are the
  deliverable — the complaint is a relationship, not an absolute.
- Distance from the end of the target control to Send, before and after.
- Resting height of the whole composer, before and after.
- `npm test`, `npm run build` clean; `node dev/drive-theme-pass.mjs` if any ink moves.

## Where to work

`main` is at `2269209`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/composer-proportions-RESULT.md`: the width rule you chose and what you rejected, the
three-width table, the Send distance, the height change. Then one OPERATOR-REPLY line.
