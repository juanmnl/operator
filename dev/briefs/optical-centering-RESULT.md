# The letters looked low because the app never loaded its own typeface

Answers `dev/briefs/optical-centering.md`. Done alongside `landing-look-and-feel.md`, which is what
made the real cause measurable.

**Headline: the vertical half of this brief is fixed by loading Archivo, not by a nudge.** I built
the metrics-derived correction the brief describes, measured what it actually did, and it made the
defect **worse** — so it is not in the code. The horizontal half is real and is fixed.

---

## What I measured, and why the usual method can't see this

`getBoundingClientRect` on the span returns the **line box**, which is the thing `place-items:
center` already centres perfectly — measuring it is why this passed unnoticed. So
`dev/drive-optical-centering.mjs` measures painted ink by difference: screenshot, hide the letters
with `visibility: hidden` (no reflow), screenshot again; the changed pixels are the ink. The disc
stays put underneath, so both centres come from one frame pair.

It sweeps **device scale**, which turned out to be the whole story.

## The numbers, at the user's real 2× display

`Δy` positive = ink sits LOW. Channel avatar, `"OP"`, 26px disc:

| | system-ui (what shipped) | Archivo |
|---|---|---|
| box-centred | **+0.75** | **+0.25** |
| with the metrics-derived nudge | +1.25 | +0.75 |

**Loading Archivo moved it from 0.75px low to 0.25px low.** The rail tile behaves identically
(+0.75 → +0.25). That is the complaint, and its cause: the app declared Archivo for its entire
life and never loaded it, so everything rendered in system-ui, whose vertical metrics seat capitals
lower in a `line-height: 1` box. `place-items` was never the wrong tool.

## Why the nudge is not in the code

I derived it properly — cap-band ink from canvas, baseline from a real DOM strut rather than
canvas's `fontBoundingBox` (the two disagree by 0.017em, and only one of them is what CSS used to
lay the line out). It came to **+0.0095em**, consistent across 9.5 / 10 / 11px. Then:

```
              1x        2x (real)     4x
  no nudge    +1.00     +0.25         +0.25
  nudged        —       +0.75         +0.75     ← worse, at every scale that has one
```

Glyph baselines are snapped to the **device pixel grid at raster time**. At 2× that grid is 0.5px
and the correction is 0.09px, so all a sub-pixel transform can do is push the glyph across a snap
boundary — it cannot land closer than doing nothing, and here it landed half a pixel further away.
**A correction smaller than the quantum it is fighting is not a correction.** No DOM or canvas API
exposes the snap, which is why only the pixel diff caught it; and it differs per scale, so a
constant tuned at 4× would be wrong on the display the user owns.

Two things I got wrong on the way there, both worth recording:

- **My cap sample included `Q`.** Its descending tail dragged the ink box down and produced a
  correction of the *wrong sign* — it reported that letters sat low when they sat high. Typographers
  centre the cap band; `"QA"` must sit exactly where `"OP"` does, so the number must not depend on
  which letters a disc happens to hold. The sample is `HO`: one flat cap, one round one whose
  overshoot is symmetric.
- **My driver's `letters` selector was a selector list** (`.ink-centred, [data-channel-avatar]`).
  `querySelector` returns the first match in *document order*, which is the avatar — the span's own
  ancestor — so I was hiding the whole disc and measuring the circle. Before and after read
  identically and it looked like the fix had not applied.

## What did ship — the shared treatment

`.ink-centred` in `styles.css`, one class, four consumers:

```css
.ink-centred {
  letter-spacing: var(--track, 0.02em);
  margin-right: calc(-1 * var(--track, 0.02em));
}
```

`letter-spacing` adds its space **after the last glyph too**, so the text box is wider on the right
than the ink and centring the box lands the ink left. The tracking and its cancellation are one
declaration pair keyed off `--track`, so a site that changes its tracking cannot leave the
cancellation behind — which is the failure mode of writing them apart. `SidebarRail` sets
`--track: -0.5px / 0px` (it tightens two-letter initials only); the preview pin sets `0px`.

Measured: rail acronym −0.25 → 0.00 at 4×. At 2× it is below the grid quantum, i.e. correct and
invisible — which is the right outcome for a 0.1px error.

## The audit — every `place-items: center` site

**Text in a disc or tile — fixed (4):**

| site | contents |
|---|---|
| `ProjectChannel` avatar | `channelInitials`, 26px disc — the reported one |
| `ProjectRail` tile | `projectInitials`, 28px rounded square |
| `SidebarRail` lane initial | `initialOf` over the status orb |
| `AppPreviewPanel` pin | the annotation number |

**Icons — unaffected, an SVG has no baseline (8):** `PlanMeter` (the ring), `RosterPanel` (drag
grips, the dev-server tick), `ProjectGallery` (the checkbox tick), `Sidebar` (footer icon buttons),
`MoodboardPanel` (image cells and the zoom overlay — layout, no text).

**Glyph-character buttons — deliberately left alone (5):** the `⋯` and `✕` in `ProjectGallery`,
`RosterPanel`, `TaskQueue` and `ChatComposer`. The same mechanism applies, but these are symbols in
transparent buttons with **no disc to be off-centre within** — there is no visible reference circle,
so the offset has nothing to read against. Changing them would move hit targets for no visible gain.

`RosterPanel`'s circles are all plain status dots with no text, so it is not a site despite the
brief listing it.

## Verified

- `npm run build` clean; `npm test` 562/562.
- `node dev/drive-theme-pass.mjs` — `BELOW FLOOR: 0` with the new fonts in.
- Avatar column at 6×, system-ui vs Archivo: `/tmp/operator-shots/optical-before-fallback.png`
  and `/tmp/operator-shots/optical-after.png`. The `QA` avatar is in frame, tail and all.

## The dependency the brief flagged, resolved

The brief asked me to state how I handled Archivo not being loaded. The answer is stronger than
coordination: **the font was the cause.** Had I tuned a constant against system-ui — which is what
was on screen when the screenshot was taken — it would have been a −0.75px correction, and it would
have been 0.5px wrong the moment the real font landed later the same day.

## If the discs still look off

The number is 0.25px low at 2× and that is a quarter of one device pixel — below what a nudge can
address. If it still reads wrong, I'd look at the disc rather than the letters: the avatar is 26px
with a 1px hairline, and a ring's optical centre and its geometric centre are not the same thing
when the ring is brighter than the fill.
