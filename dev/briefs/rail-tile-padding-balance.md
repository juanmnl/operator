# Brief — the rail tile's surrounding space is unbalanced (follow-up to rail-tiles)

User, looking at the merged build: **"spacing here needs to be balanced"** — screenshot is a
single current (ringed) `OP` tile in the ProjectRail.

## The arithmetic, from the merged code

`ProjectRail.tsx`: `RAIL_W = 44`, tile `28×28` `borderRadius: 7`, current-tile ring
`boxShadow: '0 0 0 2px var(--accent)'`, per-tile wrapper with constant `2px` transparent borders,
scroller `gap: 8, padding: '4px 0', alignItems: 'center'`.

The ring is drawn **outside** the 28px box, so a current tile's drawn extent is **32×32**.

```
                         clearance from the tile's DRAWN edge
  left / right           (44 − 32) / 2            =  6px
  top (first tile)       scroller padding-top     =  4px
```

**6px at the sides, 4px at the top.** Your rail-tiles pass correctly re-sized the gaps *between*
tiles against drawn extent — this is the same mistake one level out: the padding *around* the
column was left at its old value and never reconciled with the ring's 2px overhang. With one
tile, which is now the common case after the prune, that 2px difference is the whole read.

## What I want

Balance the space around the tile column so a single ringed tile sits in visually even air — and
check the bottom of the column too, not just the top; the last tile's pip hangs ~3px below its
box and may need different treatment from the first tile's ring.

Do it with the **drawn** extent, the way you did the inter-tile gaps. And decide deliberately
whether the correct number is 6 everywhere (match the sides) or something else — the rail is 44
wide and the sides are fixed by that, so the sides are the constraint and the padding is the free
variable.

Sanity-check the neighbouring seams while you're there: the `DragRegion` above the scroller
(`paddingTop: 40`, traffic lights) and the foot's `padding: '10px 0'`. A tile column that's
internally balanced but sits hard against the foot has just moved the problem.

## Constraints

- Rail stays 44 wide; tile stays 28×28; ring stays a `box-shadow` (a colour-CHANGING border on a
  radiused element re-rasterizes in WKWebView).
- The wrapper's 2px borders are load-bearing — they're constant so the drag drop-line can't shift
  the stack. Don't remove them to buy space.
- Shape vocabulary unchanged: project = rounded square, session = circle.
- Motion rule unchanged: only running/compacting animate.

## Where to work — read this

Your branch `operator/1cf818` has already been **merged into `main`** (`2a544e7`). Make this fix
as a **new commit in your own worktree** (`~/.operator/worktrees/operator-1cf818`) as usual — I'll
merge it forward. Do **not** try to edit `/tmp/claude-501/merge-main`; that's my merge scratch
worktree and anything you write there will be lost.

## Verify

- `npm test`, `npm run build` clean.
- Measure the four clearances (top / bottom / left / right of the drawn extent) before and after,
  for BOTH a single ringed tile and a column of several — the one-tile case is now the common one.
- `node dev/drive-theme-pass.mjs` if you touch any ink.

## Output

`dev/briefs/rail-tile-padding-balance-RESULT.md`: the four measurements before/after, the number
you chose and why, and whether the foot/drag seams needed anything. Then one OPERATOR-REPLY line.
