# The rail, measured in pixels instead of boxes

Answers `dev/briefs/rail-assert-the-invariant.md`. The deliverable is the table; the fixes follow
from it. `dev/drive-rail-invariant.mjs`, re-runnable, `THEMES=all` for the six-palette sweep.

**Horizontal centring was already right.** All four earlier passes were correct about that, and a
fifth adjustment to it would have been damage. What was wrong was **size** — three foot glyphs sat
in identical 26×26 boxes at three different painted sizes — and the seam's position, which turned
out to be a symptom of the same thing.

---

## How it measures, and why not `getBoundingClientRect`

Every earlier pass measured a **handle**: a border box, a shadow's spread value, an svg's shape
rects. Each of those lies in a different direction — the rect excludes the ring, the svg rects
exclude the stroke's outer half, the pip's span reserves more than its dots cover. So each pass
could be right about its own number and blind to the pixels.

This one measures by **difference**:

```
screenshot the rail  →  `visibility: hidden` on ONE element  →  screenshot again
the pixels that changed ARE that element's ink, whatever drew them
```

`visibility: hidden` suppresses painting without reflowing, so nothing else can move between the
two frames. It catches box-shadow rings, stroke overshoot, round line caps, glyph side bearings
and antialiasing tails without knowing anything about how they were drawn. 2× device scale, so the
resolution is half a pixel — the scale every one of these defects has lived at.

**The driver had this bug too, and it is worth recording.** Against a single base frame captured
at the top of a scene, any later repaint in the strip lands in the diff of every element measured
after it, indistinguishable from ink. It surfaced as one palette reporting six different elements
with byte-identical bounds of 8.00–44.00 — the tell, because real ink from six glyphs cannot agree
to the pixel. The base is now re-taken immediately before each element. A driver that can drift
silently is worth less than no driver, which is the whole lesson of the four passes before this.

## What the assertion covers

Not a sample — every element, in every state:

- each tile in **all four** ring/pip combinations (three appear at rest; selecting a plain tile
  produces `ringed` without a pip, which no single frame gives you)
- the acronym text ink, separately from the tile it sits on
- each foot glyph — **the drawn ink, not the 26×26 button**
- the usage ring, whose painted extent is not its viewBox
- the foot's horizontal seam, and the rail's own vertical one
- the corner pip

Two of those are off the centre line **on purpose** — the pip is a corner ornament, the rail seam
is an edge — so they are held to their own invariants (`does not widen its tile`, `paints inside
the 44px footprint`) instead of being flagged forever. An assertion that reports intentional design
as a defect is one nobody keeps running.

---

## BEFORE

```
H · PAINTED CENTRE
foot robot              glyph           17.00 27.00 10.00   22.00   0.00     738.0    749.0
foot usage ring         glyph           15.00 29.00 14.00   22.00   0.00     767.0    781.0
foot seam               rule            11.00 33.00 22.00   22.00   0.00     802.0    803.0
foot grid               glyph           16.00 28.00 12.00   22.00   0.00     825.0    837.0
foot plus               glyph           16.00 28.00 12.00   22.00   0.00     855.0    867.0
tile (all 4 states)                      ...                22.00   0.00
  └ acronym                              ...          21.50 – 22.00  −0.50 … 0.00
H: worst painted-centre delta -0.50px

S · FOOT GLYPH INK
  GLYPH           SIZE            AREA    WEIGHT   CHROMA
  robot          10.00 × 11.00     54.5     92.2     16.1
  usage ring     14.00 × 14.00     75.8     99.3     95.1
  grid           12.00 × 12.00     92.0     86.1     15.3
  plus           12.00 × 12.00     42.0     89.9     15.8
  spread 4.00px across four controls in a column  ◀ OFF

V · RHYTHM
  tile pitch constant                        40.0 / 40.0 / 40.0 / 40.0 / 40.0  0.00  ok
  plain pairs: ink gap constant              12.0 / 12.0 / 12.0 / 12.0         0.00  ok
  ring pairs: exactly 2px tighter            10.0 (ring ink)                   0.00  ok
  pair A == pair B                           A  18.0   B  18.0                0.00  ok
  seam centred in its own air                above  21.0  below  22.0        -1.00  ◀ OFF
  seam out-spaces the pairs it divides       yes                                    ok

PALETTE     WORST |Δ22|   GLYPH SPREAD   RHYTHM
mc·D        0.50px        4.00px         OFF      (identical on all six)
```

## What it found

**1 · The four foot glyphs are three different sizes.** 10×11, 14×14, 12×12, 12×12 — a 4px spread
across four controls in a 44px column. They sit in identical 26×26 boxes, which is exactly why
three passes over this strip never saw it: every number in the code said they matched.

**2 · The usage ring was 13.5px where its own comment says 12.** `PlanMeter`'s note reasons
carefully about the meter being too large, sets `R = 6`, and states the result as "12px across with
a 1.5 band". But the painted diameter is `2R + STROKE`, not `2R` — the stroke straddles the path, so
half of it lies outside the radius. The comment diagnosed the right problem and then made the exact
error this brief is about.

**3 · The seam is not centred in its own air** — 21 above, 22 below.

**4 · The acronym's ink sits left of the axis**, −0.25 to −0.50px, on every tile, never positive.
A directional error is a systematic one: `letter-spacing` adds its space *after* the last glyph
too, so the text box is wider on the right than the ink is, and centring the box lands the ink left.

**5 · Not a defect, and I am not touching it:** the ink gap beside the current tile is 10 where
every other pair is 12. The ring is 2px of ink outside the box, so it *must* narrow the gap either
side. What matters is that it does not move anything — **pitch is constant at 40.00 across all
five pairs regardless of state.** The assertion now checks both numbers rather than demanding one
flat gap, which would have left a permanently-failing row.

## Fixed

| | change | why |
|---|---|---|
| usage ring | `R 6 → 5.25` | painted diameter `2R + STROKE` = 12.0, which is what the comment already wanted |
| robot | body `10×7.5 → 12.5×9`, same 27% corner radius, eyes recentred | 12×12 of ink, matching the grid and the plus. Proportions unchanged; only the scale is |
| acronym | `marginRight: -0.02em` | takes the trailing letter-space back out of the centring |
| seam | **nothing** | it was a symptom of the ring, not a cause — see below |

**The seam needed no change.** Shrinking the ring moved its ink 0.75px further from its box edge,
which took the gap above the seam from 21 to 22 and matched the 22 below it. One cause, two
symptoms — and had I "fixed" the seam by margin first, the ring fix would then have broken it in
the other direction. That is a fair description of how this strip got to a fourth complaint.

I redrew the robot by arithmetic, which is how you make something worse, so I looked at it at 8×
before believing the numbers: `/tmp/operator-shots/rail-foot-zoom.png`. It reads as the same robot.

## AFTER

```
S · FOOT GLYPH INK
  GLYPH           SIZE            AREA    WEIGHT   CHROMA
  robot          12.00 × 12.50     63.0     94.4     16.4
  usage ring     12.00 × 12.00     65.8    101.3     97.7
  grid           12.00 × 12.00     92.0     86.1     15.3
  plus           12.00 × 12.00     42.0     89.9     15.8
  spread 0.50px  ok

V · RHYTHM
  tile pitch constant                        40.0 / 40.0 / 40.0 / 40.0 / 40.0  0.00  ok
  plain pairs: ink gap constant              12.0 / 12.0 / 12.0 / 12.0         0.00  ok
  ring pairs: exactly 2px tighter            10.0 (ring ink)                   0.00  ok
  pair A == pair B                           A  18.0   B  18.0                0.00  ok
  seam centred in its own air                above  22.0  below  22.0         0.00  ok
  seam out-spaces the pairs it divides       yes                                    ok

O · OFF-AXIS BY DESIGN
  pip on operator      widens its tile by  -2.00px  ok
  pip on el-encanto    widens its tile by   0.00px  ok
  rail seam            inside the 44px footprint: yes  ok

PALETTE     WORST |Δ22|   GLYPH SPREAD   RHYTHM
mc·D        0.50px        0.50px         ok
mc·L        0.50px        0.50px         ok
pink·D      0.25px        0.50px         ok
pink·L      0.50px        0.50px         ok
1984·D      0.25px        0.50px         ok
1984·L      0.50px        0.50px         ok

CLEAN on every palette measured
```

Residual: the robot is 12.0 × 12.5 — half a pixel taller than square, which is the driver's own
resolution. The acronym's worst is −0.50px on one tile; the systematic component is gone and what
is left is per-letter side bearings, which no single rule can centre.

---

## Two things the table can now see that alignment never could

I added **area, weight and chroma** columns because "balanced" is a claim about how loud each
control reads, and a geometry table cannot see that. Both findings are design decisions with
reasoning already recorded in the code, not defects, so I measured them and left them alone:

- **The usage ring's chroma is 97.7 against 15–16 for its three neighbours** — six times the
  colour, and the only saturated thing in a strip of neutral chrome. `PlanMeter`'s comment names
  this exact worry and addresses it by *size*; size is now matched and the colour difference is
  what remains. If the corner still reads as unbalanced after this, **that is my first suspect,
  and it is the one thing here I'd want a brief for** — the tone carries meaning (healthy / warn /
  critical), so muting it is a semantic decision, not an alignment one.
- **The grid has 2.19× the ink area of the plus** (92.0 vs 42.0), the two controls that are meant
  to read as a matched pair. Pass 3 attacked this with `strokeWidth` and its comment says it went
  as far as it goes. The measurement agrees: it landed at the ~2:1 it was aiming for. Reaching
  parity would need the plus at `strokeWidth` 3.2, which would read as a bar — so **`strokeWidth`
  is the wrong lever** and closing it further means redrawing the grid, which is not this brief.

## Verified

- `THEMES=all node dev/drive-rail-invariant.mjs` — **clean on all six palettes**, before/after above.
- `npm run build` clean. `npm test` — see below.
- `node dev/drive-theme-pass.mjs` — no new contrast failures.
- Screenshots: `/tmp/operator-shots/rail-invariant-*.png`, `/tmp/operator-shots/rail-foot-zoom.png`.

## If it is still wrong a fifth time

Then it is not geometry. The table above is exhaustive over the strip's elements and clean to half
a pixel on every palette, so the next hypothesis should be one of the two weight findings — most
likely the ring's chroma — or something outside the rail entirely: the strip's field against the
sidebar's (they are the same colour, separated only by the seam), or the column reading top-heavy
in a tall empty rail. Please don't accept another geometry fix without a table.
