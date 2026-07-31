# Channel layout — direction A, left-aligned and full-bleed

Answers `dev/briefs/channel-layout-full-bleed.md`.

---

## The frame

The centred `MEASURE = 720` is gone. Three constants replace it, and each is derived rather than
picked:

```
INSET        16    the shared LEFT edge — header, every row, the composer
PROSE       470    the body cap (unchanged; ~79 chars in the body's own font)
ROW_MAX     570    AVATAR(26) + GAP(10) + PROSE(470) + GAP(10) + ACTION(54)
COMPOSER_MAX 720   a writing surface, not a reading one
NARROW_AT   520    below this the action rail gives its width back to the prose
```

**The row is full width; the paragraph is not.** The row's hover background and hit area run edge
to edge, and the row's own horizontal padding is what insets the content — that split is the whole
design. The feed container lost its horizontal padding so the rows could carry it.

`ROW_MAX` is derived because both attempts at choosing it were wrong in instructive ways:

- **880 (a round number)** left the copy action floating ~360px past the last word, orphaned in
  the middle of the row — the same "content adrift in a wide field" defect this brief exists to
  fix, just relocated.
- **Omitting the action from the sum** let it *eat* the prose instead: the button is a flex
  sibling of the body column, so 470px → 414px, 79 → 69 chars. If it's in the row, it's in the
  arithmetic. A second slip on top of that (counting the flex `gap` once when it applies twice)
  cost another 10px, 79 → 77.

## Chars per line, at three widths

```
pane (content)          row bleeds   body    chars   left edges h/r/c
 712px (706)               true      470px    79        16/16/16  SHARED
1152px (1146)              true      470px    79        16/16/16  SHARED
1812px (1806)              true      470px    79        16/16/16  SHARED
```

A **hard cap, not a `clamp()`**. The brief left it open; I kept it hard because 79 chars is a
number this feed already argued for and measured, and letting prose grow on wide windows would
re-open exactly the readability question the last pass closed. The recovered space is what the
row's *background* uses, not the text.

*(`row bleeds` compares against the scroller's `clientWidth`, not its bounding rect: the pane is
`overflow-y: scroll` so it always reserves a 6px gutter, and measuring against the border box made
a correct full-bleed row read as 6px short.)*

## The shared left edge

Measured, not eyeballed — header `#`, row content and composer textarea all report **16** from the
pane's left at every width. Right edges deliberately differ by role: the header's kill switch
rides the pane's far edge because it is *pane chrome*, a titlebar control; the composer stops at
720 because it is a writing surface; rows stop at `ROW_MAX`.

The day separator moved with it — it was centred between two rules, which put the date in the
middle of a 2000px pane. It is now left-anchored with the rule trailing off to the right.

## What uses the recovered space

**Nothing, deliberately** — the brief's first option, and the honest one. The alternative it
offered (right-aligned meta) is a regression at this width: a timestamp 1500px from its own
message is not "using the space", it is making the eye travel for something it was already
reading. The one thing that *did* move right is the hover action, and only as far as `ROW_MAX`,
because an affordance should sit near the thing it acts on.

## Hover action, and its focus state

One action — **copy** — at the row's right edge, revealed on hover *or* focus.

**`visibility: hidden` was the wrong mechanism and the driver caught it.** It removes the element
from the tab order entirely, so the focus state I had written could never fire: `btn.focus()`
measured `isActiveElement: false`. It is `opacity: 0` + `pointer-events: none` now, which keeps it
focusable. The focus ring is an inset `box-shadow` in `--accent` — the house rule forbids browser
focus rings, and this is the feed's first interactive furniture, so it needed a real one.

It **reserves its space at rest**, which inverts the usual hover-affordance rule (a grip must not).
Here reserving is correct: without it the prose would re-wrap every time the pointer crossed a row.

## Scroll must not drift

It did — narrowing 1400 → 900 moved the row under the reader's eye by **16px**. Now **0px**.

The anchor is recorded on **scroll**, not on resize: by the time a `ResizeObserver` fires, the new
layout is already in place and the old position is gone. So the pane remembers the topmost visible
row and how far it sat below the fold, and puts it back after a width change. Height-only changes
are ignored, since nothing re-wraps.

## Narrow widths

The avatar **stays** — it is the identity channel this layout is built around, and the brief notes
the colour-coded author is direction A's load-bearing element. What goes instead, below 520px, is
the action rail: prose at a 326px pane went from 194px/33 chars to **258px/43 chars**.

Two real bugs surfaced only at that width:

- **13px of horizontal overflow** with *no offending element box* — because a clipped element whose
  **text** overflows never appears in a bounding-rect check. Found by switching the probe to
  `scrollWidth > clientWidth` per element. The culprit was the paused banner: as a wrapping
  baseline row it could not fit headline + explanation + an unshrinkable button into ~290px.
  `flexWrap` does not save you when one child has a hard minimum, so it now stacks when narrow.
- A `white-space: nowrap` on `→ target` (from the last pass, so the arrow can't break) pushed a
  long lane name past the row. It truncates now.

## Verified

- `npm run build` clean. `npm test` **533/533**.
- `node dev/drive-theme-pass.mjs`, all 6 palettes: **`BELOW FLOOR: 0`**.

Two ink defects were found and fixed, and finding them took correcting the *probe* first:

- **The copy action** measured a flat `1.00:1` on every palette — which is a probe artifact, not a
  contrast failure: `__contrast` folds effective opacity into its sample, so an
  `opacity: 0` control reads as fg == bg. Forcing `style.opacity = '1'` doesn't work either, since
  this feed re-renders on every `session:update` and React puts the prop straight back. The probe
  now hovers the row, i.e. measures the state a reader actually sees — which revealed a genuine
  **2.99:1 on Mr Pink light**. Its ink is `--fg` now (it is only ever on screen while hovered, so
  it has nothing to recede behind): **8.48–10.55**.
- **The avatar initials** dropped to **4.11 on Mr Pink dark** — caused by *this* pass, since the
  new row-hover background lightens the backdrop under them, and only while hovering. Now
  **9.38–11.65** with plain `--fg`: the identity lives in the disc's tint and hairline and in the
  author name beside it, so the two letters don't need to carry it a third time.

**Two failed attempts on that one are worth recording.** Strengthening the disc's tint 16% → 24%
went the *wrong* way (4.11 → 3.55): on a dark palette a heavier accent wash lightens the disc
faster than it helps the ink on it. And two subsequent edits **silently no-op'd on an indentation
mismatch**, so a run I read as "the mix helped every palette except that one" was really "nothing
changed at all" — the giveaway was two different inks producing byte-identical numbers. Both
`python` replacements now assert.

- Everything from the previous channel pass still holds: clamp at 4 lines with Show more (tallest
  entry 17% of viewport), author-run grouping (12 labels → 5), `parseInline` (0 literal backticks,
  8 code chips), sticky day separator visible at the feed's bottom, chip tones, the paused notice
  and its retirement when delivery is on, and 0px drift when a body expands.

## Not done

- **No second column, no sidebar** — the brief ruled it out for this pass and I did not sneak one
  in under another name.
- **Only one hover action.** Copy is the one with an obvious use in a feed full of paths and
  result references. More belong to a pass that knows what they are.
- **`channel-author-uuid` is Code's** — I built assuming names resolve, as instructed. In this
  worktree a reply from an unmapped session still shows its raw id, which is that brief's job.
