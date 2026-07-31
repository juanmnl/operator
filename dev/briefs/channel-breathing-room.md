# Brief — the channel is cramped. Give the whole pane air, starting with the composer.

User: **"the message box is also badly placed, that whole page needs a bit of air."**
Screenshot: the last feed row sits almost on top of the composer, and the composer's bottom is
flush against the pane's edge.

## The measured cause of the composer half

`ProjectChannel.tsx:885` — the composer's wrapper:

```ts
padding: `8px ${INSET}px 10px`
```

**8px above the container and 10px below**, for a surface that sits between a scrolling wall of
text and the window edge. Compare the feed's own `padding: '14px 0 24px'` (`:424`) — the feed gives
itself more room at its bottom than the composer gets on either side. The composer reads as jammed
in because it is.

## What I want

**A spacing pass over the whole channel pane, not just the composer.** The user's phrasing is
"that whole page", and they are right that this is systemic rather than one bad number — every
pass today has tuned a measure or an alignment, and none has looked at vertical rhythm.

Go through it as one system and report the before/after for each:

- **Around the composer** — above (against the feed) and below (against the pane edge). This is
  the reported symptom and the worst offender.
- **Between feed rows**, and between a row and its continuation. A run that collapses identity
  should still breathe.
- **Around the day separator** — it now anchors left; does it have room to read as a break?
- **Under the header**, and at the top of the feed.
- **Inside the composer** — the gap between the textarea and its action row.

Establish a **rhythm** rather than nudging six numbers independently: pick a base step and express
the spacing in multiples of it, so the next change has something to be consistent with. Say what
the step is.

## The constraint that makes this non-trivial

**Air costs messages on screen.** The feed already lost density to the 4-line clamp and to
author-run grouping, and this channel carries 118 entries in a day. If the pass costs more than
about one entry per screen at the default pane height, say so with the number and argue why it's
worth it — I'd rather have that trade stated than discover it.

The clamp is your lever if you need one: at the 900px measure a median dispatch now fits in 4 lines
without folding, so there may be room to trade a little clamp height back for spacing.

## Keep

Everything the last five passes established: the shared 16px left edge, full-bleed rows,
`ROW_MAX`/`COMPOSER_MAX` equality, the 900px prose ceiling, the bottom mask, the toolbar header at
44/16, one target control, Send beside the content.

## Verify

- Before/after table of every spacing value you touch, with the base step named.
- Entries visible per screen at the default pane height, before and after.
- All three pane widths still behave; narrow pane not squeezed further.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `6b732db`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-breathing-room-RESULT.md`: the base step, the before/after table, the
density cost, and anything you deliberately left tight. Then one OPERATOR-REPLY line.
