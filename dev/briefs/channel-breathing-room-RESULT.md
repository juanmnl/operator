# Channel breathing room — a rhythm, not six numbers

Answers `dev/briefs/channel-breathing-room.md`.

---

## The base step: 4px

Every vertical gap in the pane is now a multiple of it, and it is a named constant (`STEP`) that
the values are *expressed in* rather than merely documented:

```
 4   a continuation's own padding, a block's closing edge
 8   inside the composer
12   a block's opening edge, the feed's top and bottom, below the day rule
16   around the composer
24   above the day rule
```

**4 rather than 8**, because the row's internal steps were 2–3px and had nowhere to round to on an
8px grid without either doubling a continuation's height or collapsing it to nothing.

## Before / after

```
                                  before    after    steps
composer, above (vs the feed)        8        16       ×4    ← the reported symptom
composer, below (vs pane edge)      10        16       ×4
composer, textarea bottom            2         4       ×1
composer, action row bottom          6         8       ×2
row, block opening edge             10        12       ×3
row, block closing edge              3         4       ×1
continuation row                     3         4       ×1
day separator, above                18        24       ×6
day separator, below                12        12       ×3
day separator, own padding           6         8       ×2
feed, top                           14        12       ×3
feed, bottom                        24        12       ×3    ← reduced, see below
```

You were right that `8px above / 10px below` was the worst offender: the feed gave itself more
room at its own bottom (24) than the composer got on either side, for a surface wedged between a
scrolling wall of text and the window edge.

**The feed's bottom came down, not up.** It was 24 because the composer gave itself almost nothing
and the feed was compensating; once the composer carries 16 of its own, the two stacked to 40px of
dead space at the scroll end. 12 + 16 = 28 is still the most air anywhere in the feed.

## The density cost: exactly one entry

**7 → 6 entries fully visible** at the default pane height. Counted, not inferred — the pane's own
scroller height fell 784 → 765px, which is the composer's growth (+19px: 14 from the wrapper, 5
from the internals).

That is right at the threshold you set, so: **I think it's worth it, and here is the trade.** The
composer was the reported defect and 8/10 was genuinely jammed; the other +3px per row is what
stops a run of messages reading as one undifferentiated block. One entry out of seven is a ~14%
density loss on a pane that carries 118 entries in a day — real, but the alternative is a pane
that is dense and unpleasant to read, which is the state that produced this brief.

**I did not use the clamp lever you offered.** Dropping the clamp from 4 lines to 3 would recover
the height, but at the 900px measure a median dispatch now fits in 4 lines *without folding* — so
3 would re-fold the median and undo the main win of the prose-wider pass. Trading a fixed
readability gain for a variable density one is the wrong direction.

I did take the one genuinely free recovery (the feed's redundant bottom padding, above). It
returned 12px, which is not a row, so the count stayed at 6.

## One thing this pass caught that wasn't spacing

The header's `#` glyph now sits at **48**, not 16 — because the sidebar toggle from the previous
brief is the leading element and the `#` follows it. The shared-left-edge invariant still holds
where it means something: the header's content *begins* at 16, same as every row and the composer.

```
header first child   16      ← the invariant
header `#` glyph     48      ← after the toggle, exactly as the title follows it in SessionToolbar
composer surface     16
```

Incidentally an improvement: the title now sits at 48 against the message *text* column at 52,
rather than at 16 against text at 52. My driver was asserting on the `#` specifically, so it
reported `NOT SHARED`; it measures the header's first child now, which is the property that was
always meant.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- All three pane widths unchanged: 96 / 151 / 151 chars, rows still bleed, left edges shared.
- Narrow pane not squeezed further: 326px content, 43 chars, no horizontal overflow.
- Tallest entry still 16% of the viewport.
- The rhythm numbers are now printed by `dev/drive-channel-view.mjs` (section 4d2) **with the
  entries-per-screen count beside them**, so the next spacing change reports its own density cost
  rather than discovering it later.

## Left tight, deliberately

- **The day separator's `below` stays at 12** while its `above` went to 24. A break belongs to what
  follows it; symmetric margins would make it float between two days rather than heading one.
- **`gap: 10` between avatar and body** is not on the step. It is horizontal, and it is derived from
  `AVATAR_GAP`, which `ROW_MAX` depends on — changing it would move the prose ceiling and the
  action rail. Out of scope for a vertical rhythm pass.
- **The header stays 44** — that is the canonical toolbar height from the alignment pass and is
  shared with two other views.
