# Rail tiles — one optical axis

Answers `dev/briefs/rail-tile-optical-axis.md`. One-line change in `ProjectRail.tsx`: the pip's
`right: -3, bottom: -3` → `right: -1, bottom: -1`, plus the corrected comments and a new
invariant test.

---

## The mechanism, and why this one

**Seat the pip so it paints inside the box.** The ring then becomes the only ornament drawn
outside the tile, and a ring is symmetric — so painted extent is either the box, or the box + 2px
on all four sides, and both are centred.

The brief listed three options. Two of them cannot work, and it's worth saying why:

- **"Reserve the ornament's extent symmetrically on the wrapper."** Padding the wrapper equally on
  both sides doesn't move anything — the box was already centred in the field, so symmetric
  padding leaves it centred and the pip still extends the painted bounds to one side. I worked
  this through before discarding it.
- **"Optically centre against the drawn extent."** This works, but only by shifting the *box*
  sideways when a pip is present — which moves the acronym, makes the geometry conditional on
  state, and would itself break the moment a second ornament appeared.
- **"Make the overhang symmetric about the corner"** — the one I took, in its strongest form. A
  corner ornament can never overhang symmetrically in x while sitting at a corner; the only way to
  stop it moving the centre is to stop it extending the bounds at all.

The pip still **overlaps** the corner — it just overlaps inward now instead of outward. Because
the tile is `borderRadius: 7`, a pip flush with the bounding box still pokes past the *visible*
rounded silhouette into the corner notch, which is what makes it read as attached to that tile
rather than floating beside it. That was the brief's condition for touching the overhang at all,
and it holds (see `/tmp/operator-shots/axis-pair.png`, 8×).

## The four states, measured

Painted centre x, measured from the rail's left edge. Field centre is **21.5** — the strip is 44
wide with a 1px right border, so the usable field is 43, not 44.

```
state              before            after
                centre  overhangR   centre  overhangR
ringed+pipped    21.5     +1.9       21.5     −0.07
plain+pipped     22.4     +2.0       21.5      0
plain            21.5      —         21.5      —
ringed           21.5      —         21.5      —
```

`plain+pipped` was **0.9px right** of every other state. All four now share one axis.

All four are reachable, which I had wrong at first: I reasoned that a tile with no pip must be
idle and therefore only on the rail if it's current-and-ringed, making `plain` impossible. It
isn't — a project with an open-but-idle session is live (so on the rail) with `status: 'idle'`
(so no pip). The driver samples whatever states actually render rather than the four I expected.

## Clearances after

```
                      top   bottom   left   right
ringed tile            6      6       6      6
unringed tile          8      8       7.5    7.5
```

The 0.5px on the sides is the rail's 1px right border, not a defect: the box is centred in the
43px field, and the vertical padding gives it the same 8px the field gives it horizontally.

Inter-tile gaps improved as a side effect — the tightest pair went **8px → 10px**, because the
ring is now the only thing eating into a gap. Ordinary pairs stay at 12.

## The corrected comment

The brief asked for the replacement of the false claim. What was there:

> *"Both ornaments overhang the box by the same 2px … So a ringed or pipped tile clears 6 on every
> side and a plain one clears 8, uniformly."*

The magnitude was right and **"on every side" was not** — a ring overhangs four sides, the pip
overhung two. The comment now records that explicitly as a past error, because it is the kind that
survives review: *equal clearances per tile did not make the column agree, and two passes of
per-tile arithmetic could not have found it, because the defect only exists BETWEEN tiles.*

The invariant is stated on the pip itself, where the next person will be tempted to undo it:

> *THE INVARIANT: a tile's PAINTED CENTRE is independent of its ring and pip state. … That is why
> this is `-1` and not `-3`. … Do not restore the -3 to "make it pop": that is the bug, and
> `dev/drive-rail-tiles.mjs` asserts the centre is identical across all four combinations.*

## Verified

- `npm run build` clean. `npm test` 429/429.
- New **1c** section in `dev/drive-rail-tiles.mjs`: measures the painted centre for every
  ring/pip combination it can reach — cycling which project is current so both ringed states are
  sampled — and asserts `new Set(centres).size === 1`, plus that the pip never paints past the
  box. Result: 4 states seen, all 21.5.
- **Measured on painted bounds, which is the part that failed twice.** `getBoundingClientRect` on
  the tile excludes the box-shadow ring, and the pip's `<span>` reserves more than its dots cover
  — so both obvious handles lie about where the ink is. The ring comes from the shadow's spread;
  the pip from its svg **shapes**. Measuring the span, as I did in the previous pass, is what
  produced the "~2px on every side" figure that read as symmetric.
- The screenshotted pair — a pipped tile stacked directly above a ringed+pipped one — is now in
  the driver and was eyeballed at 8×.

## Not changed

- Rail 44, tile 28×28, ring a `box-shadow`, pip a `StatusWave`, wrapper borders constant-width.
- `gap: 8` and `padding: '6px 0'` are untouched — they were correct against the box; the defect
  was the pip's asymmetry, not the spacing around the column.
- Shape vocabulary and the motion rule unaffected: the pip is still a `StatusWave` that animates
  only for running/compacting.
- **No theme pass** — no ink, token or colour changed, only a 2px offset.
