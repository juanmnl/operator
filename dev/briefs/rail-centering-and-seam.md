# Brief — centre the rail on its OUTER width, and make the seam much subtler

User, on the merged build: **"the whole rail needs to be horizontally centered and balanced edge
to edge, and the divider line has to be way subtler."**

Screenshot is the full-height rail: two tiles at top, the foot at the bottom, and the vertical
seam down its right side.

## One cause behind the centring half

```ts
width: RAIL_W,                                    // 44
borderRight: '1px solid var(--border)',
boxSizing: 'border-box',
alignItems: 'center',
```

`border-box` means the 1px right border is *inside* the 44. **The content field is 43px**, so a
28px tile centres at `(43 − 28) / 2 = 7.5` — 7.5px from the rail's left edge and **8.5px from its
right edge** once the border is counted. Everything the rail contains is a pixel left of the
strip's true centre: the tiles, the foot buttons, the seam in the foot, all of it.

Your last pass found this number and wrote it down (*"the field is 43 and the box sits at
(43 − 28) / 2 = 7.5"*) but treated it as fixed. It isn't — it's the bug. The user is looking at
the whole column sitting off-axis inside its own strip.

**Fix it at the container**, not by nudging children. The clean move: stop letting the seam consume
layout width — draw it as a `box-shadow` (`1px 0 0 …`) or an inset border-image rather than a real
`border-right`, so the content field is the full 44 and `alignItems: center` lands on the true
centre. Then every child is centred for free and nothing needs a compensating offset. Argue for a
different mechanism if you prefer, but the invariant is: **the content field equals the strip's
outer width.**

This also settles the foot: its buttons, the usage ring and the little horizontal seam all inherit
the same axis, so they stop being 1px left too.

## The seam, much subtler

There are two lines and I want both quieter — say which you changed:

1. **The vertical rail seam** (`borderRight: 1px solid var(--border)`) — the prominent one in the
   screenshot, running the full height beside the sidebar. This is the one I read the user as
   meaning by "the divider line", since it's the most visible line in the shot.
2. **The short horizontal seam in the foot** (`width: 22, height: 1, background: var(--border)`),
   separating Agents/Usage from the navigation pair.

`--border` is doing double duty as both a structural edge and a decorative separator, and at
full strength on a near-black field it reads as a drawn line rather than a change of surface.
Take them down — `color-mix` toward transparent is the house-consistent way, and it keeps the
token as the source rather than inventing a hex.

**Do not delete either.** The vertical seam is what separates the rail from the sidebar, and the
foot seam is load-bearing — your own earlier pass established it has to out-space the things it
divides so the foot reads as 2 + 2. Subtler, not absent.

Check both against **all six palettes**: a value tuned on Mission Control dark can vanish entirely
on the three light ones, where a near-invisible separator is worse than a slightly heavy one. It
is a separator, not text, so it is not held to a text contrast floor — but it must still be
perceptible on every ground.

## Constraints

- Rail stays 44 wide **as an outer width**; tile stays 28×28; ring stays a `box-shadow`.
- Don't disturb the vertical rhythm you just settled (padding 6, gap 8, one optical axis across
  ring/pip states). This is the horizontal axis and the seam ink only.
- No colour-CHANGING border on a radiused element.
- Never stack opacity on `--fg-muted` (and don't stack it on `--border` either — mix the token).

## Verify

- Measure the tile's painted centre x against the rail's **outer** box centre. They must be equal —
  report both numbers. That single measurement is the acceptance test.
- Same for a foot button and for the foot's horizontal seam.
- `node dev/drive-theme-pass.mjs` — report the seam's contrast against the sidebar field on all
  six palettes, before and after, so "subtler" doesn't become "gone" on light.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `4b897c4`. Commit in your own worktree; I'll merge forward. **Do not touch
`/tmp/claude-501/merge-main`** — something merged into it earlier from outside my session, and
that directory is mine.

## Output

`dev/briefs/rail-centering-and-seam-RESULT.md`: the mechanism that freed the content field, the
two centre-x measurements, which seams you changed and to what, and the six-palette table. Then
one OPERATOR-REPLY line.
