# Rail — centred on its outer width, seam softened

Answers `dev/briefs/rail-centering-and-seam.md`. Two changes in `ProjectRail.tsx`, one of which
fixes both halves of the complaint at once.

---

## The mechanism: the seam is a shadow, not a border

```diff
- borderRight: '1px solid var(--border)',
+ boxShadow: `inset -1px 0 0 ${SEAM}`,
```

Under `box-sizing: border-box` the border lived *inside* the 44, so the content field was 43 and
`alignItems: center` centred everything on **21.5** while the strip's true centre is **22**. A
`box-shadow` paints without consuming layout, so the field is the full 44 and every child is
centred for free — no compensating offsets anywhere.

`inset` rather than an outset `1px 0 0`: the line then paints inside the rail's own 44px footprint
instead of bleeding over the sidebar's first column. The element isn't radiused, so there's no
WKWebView colour-changing-border hazard — and it isn't a border any more regardless.

**You were right that I'd written the 43 down as a fact to design around.** The previous pass's
comment said *"the field is 43 and the box sits at (43 − 28) / 2 = 7.5"* — I derived the number
correctly and then treated the symptom as the constraint.

## The acceptance test

Painted centre x vs the rail's **outer** box centre, all six palettes:

```
                        tile    foot btn   foot seam  |  rail outer centre  |  delta
before                  21.50    21.50      21.50     |      22.00          |  −0.50
after                   22.00    22.00      22.00     |      22.00          |   0.00
```

Identical on every palette. The foot's buttons, the usage ring and the short horizontal seam all
inherited the fix, exactly as you predicted — they were 1px left for the same reason.

## The seams

**Both** changed, via one shared constant:

```ts
const SEAM = 'color-mix(in srgb, var(--border) 60%, transparent)'
```

- the **vertical rail seam** (the prominent one) — now the `inset` shadow above
- the **foot's short horizontal seam** (`width: 22, height: 1`) — same ink

Mixed toward transparent so `--border` stays the source rather than a hex, and not stacked as an
opacity.

### Six palettes, before → after

Contrast of the seam against the sidebar field (it's a separator, not text, so no text floor
applies — this is perceptibility, not legibility):

```
theme                   before   after (60%)    45%     30%
mission-control-dark     1.33      1.15        1.10    1.06
mission-control-light    1.32      1.18        1.13    1.08
mr-pink-dark             1.17      1.09        1.07    1.04
mr-pink-light            1.33      1.18        1.13    1.09
1984-dark                1.24      1.12        1.08    1.05
1984-light               1.24      1.14        1.10    1.07
```

## Why it stops at 60% — the finding that set the floor

**The surfaces either side of the seam are identical.** I measured the sidebar's field against the
rail's: **ratio 1.000 on all six palettes** — both are `--bg-sidebar`, by design ("the sidebar
reads as part of the dark field").

So there is no surface change backing this line up. It is the *only* thing separating the two
strips, which is a different situation from a divider that merely reinforces an edge you can
already see. Mr Pink dark is the constraint: `--border` there is already the weakest of the six at
1.17, so 60% leaves it at 1.09 and 30% would take it to **1.04** — a separator you cannot see, on
a palette where the two strips would then merge into one undifferentiated field.

I've included 45% and 30% in the table so the trade is visible rather than asserted. If you want it
quieter still, the honest way is to give the two strips slightly different backgrounds first and
let the surface change carry the separation — but that's a theme-token change well beyond this
brief, so I didn't take it.

Eyeballed at 6× on Mission Control dark and Mr Pink light
(`/tmp/operator-shots/seam-{dark,light}.png`): perceptible on both, a change of surface rather than
a drawn line on the dark one.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- `node dev/drive-theme-pass.mjs`, all six palettes: **`BELOW FLOOR: 0`**. Rail tile acronyms
  unchanged (5.12–10.14), rail foot icon unchanged (3.80–7.38).
- `drive-project-rail.mjs` passes all 7 sections. `drive-rail-tiles.mjs`: the vertical rhythm you
  asked me not to disturb is intact — padding 6, gap 8, tightest ink gap 10px, and **1c still
  reports all four ring/pip states sharing one axis**. The air check now reads a genuinely
  symmetric 6/6 left and right, where before it was 6/6 measured against a 43px field.

## Not changed

- Rail stays 44 as an **outer** width; tile 28×28; ring a `box-shadow`; the pip's `-1` seating and
  the optical-axis invariant from the last pass.
- No vertical geometry touched.

---

## Unrelated, but you should know

While syncing `main` I found a **`node_modules` symlink tracked in the repo** — mode `120000`,
pointing at the absolute path `/Users/juanmnl/Developer/operator/node_modules`. It arrived in
`c0c392c` (another lane) and is now merged. `.gitignore` has `node_modules/`, and the trailing
slash matches directories only, so a symlink slipped past it. It will break any clone that isn't
on this machine, and CI. Not mine to fix — flagging it rather than deleting a tracked file other
lanes may currently be relying on.

I also read your note about `/tmp/claude-501/merge-main`: the earlier merge into it was me, when
you asked me to "merge it forward" and `main` was checked out there. Understood that it's yours —
I haven't touched it this time and won't again.
