# Rail tile padding — even air around the column

Answers `dev/briefs/rail-tile-padding-balance.md`. One-line change in
`src/renderer/components/sidebar/ProjectRail.tsx`: the scroller's `padding: '4px 0'` → `'6px 0'`.

---

## The measurements

Clearance from the tile's **drawn** edge (box + ring + pip) to the rail's edge, measured on the
first tile so all four numbers come from one tile and are comparable:

```
current (ringed) tile          before        after
  top                            4px          6px
  left                           6px          6px
  right                          6px          6px
  bottom  (column scrolled)      6px *        8px *
```

\* bottom is measured with 20 tiles scrolled to the end, since a short column is top-aligned in a
`flex: 1` scroller and there is no bottom edge to be near. The last tile there is plain, so 8px is
the *correct* number for it — see below.

## The number, and why the diagnosis shifted

The brief frames this as top-vs-sides. The arithmetic says something slightly different, and it
changes what the right fix is:

- The 44px rail gives the 28px **box** `(44 − 28) / 2 = 8px` sideways.
- The vertical padding gave the box `4 (padding) + 2 (wrapper border) = 6px`.
- **Both ornaments overhang the box by exactly 2px** — the ring is `0 0 0 2px`, and the pip, though
  offset `-3`, paints only 2px past the edge because its `StatusWave` svg carries a pixel of its
  own padding. Measured, not read off the offset.

So the imbalance was never top-vs-bottom: it was **6px of box clearance vertically against 8px
sideways**, and the ring simply made the 2px shortfall visible by eating into the smaller number
first. A plain tile already measured 6/8/8 — wrong in the same way, just less obviously.

**The number is 6px**, derived rather than picked: it is what makes the vertical box clearance
equal the 8px the rail's width already fixes. `6 + 2 (wrapper border) = 8`. Everything then falls
out uniformly:

```
                 box clearance    ornamented tile    plain tile
  every side          8px              6px              8px
```

An ornamented tile clears 6 on all four sides; a plain one clears 8 on all four. The sides were
the constraint and the padding was the free variable, exactly as the brief framed it — I just had
to match the **box** clearance rather than the drawn one, because the ornament subtracts equally
everywhere.

### Bottom — no different treatment needed

The brief flagged that the pip may need its own number. It doesn't, and that is the useful result:
the pip's painted overhang is **2px, the same as the ring's**, so one padding value serves both.
Had it really been 3px I would have needed 7px at the bottom and a comment explaining the
asymmetry; measuring first is what avoided inventing that.

## The neighbouring seams

Checked, and neither needed anything:

- **`DragRegion` above** (`paddingTop: 40`, traffic lights) sits directly on the scroller, so the
  gap between it and the first tile's ink *is* the top clearance — it moved 4 → 6 with the padding
  and needs no separate value. The 40px traffic-light reserve is untouched.
- **The foot below** (`padding: '10px 0'`). With the column overflowing, the last tile's ink to the
  first foot icon's ink is `8 (bottom clearance) + 10 (foot padding) + 6 (icon inset in its 26px
  button) = 24px`. The column does not sit hard against the foot — and it shouldn't be 6px there,
  because the foot is a different group; the seam between groups is correctly larger than the
  rhythm within one.

## Verified

- `npm run build` clean. `npm test` 429/429.
- `dev/drive-rail-tiles.mjs` gains a permanent **1b** check so this cannot regress: it measures the
  drawn-extent clearance on the ringed tile and asserts `top === left === right`. It runs *before*
  the reorder step, deliberately — `top` is a property of the head of the column, so all four
  numbers have to come from the same tile, and the current tile is only first at that point. (My
  first attempt measured the ringed tile wherever it had moved to and reported `top: 86`, which is
  the distance past the tiles above it, not a clearance.)
- Measured at 2 tiles (ringed + pipped first — the case in the screenshot), 7 tiles, and 20 tiles
  scrolled to the end. Eyeballed at 6× (`/tmp/operator-shots/tile-air.png`).
- **No theme pass.** The brief scopes it to "if you touch any ink" — this is one padding value, no
  colour, no token, no ink of any kind.

## Not changed

- Rail stays 44 wide, tile 28×28, ring a `box-shadow`, wrapper borders intact (they are what keeps
  the drag drop-line from shifting the stack, and the brief was right that buying space from them
  would be the wrong trade).
- **The `gap: 8` between tiles is untouched** — that was already sized against drawn extent in the
  previous pass and still measures 8px at the tightest pair (pip above ring) and 12px otherwise.
- Shape vocabulary and the motion rule unaffected.
