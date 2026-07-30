# Bottom-left corner: rail foot + sidebar footer — one balance pass

Answers `dev/briefs/rail-foot-balance.md`, Parts A and B.

Drivers: **`dev/drive-corner-balance.mjs`** (new — the corner as one cluster) and
`dev/drive-theme-pass.mjs`, to which I added two probes (see B4). Run against a vite dev server
on 1436; see the note on ports at the end.

---

# Part A — ProjectRail foot

## A1 · Ink mass — the ring was the hero

| | before | after |
|---|---|---|
| ring, drawn extent | **18.6px** (R 8.2 + stroke 2.2) | **13.5px** (R 6 + stroke 1.5) |
| ring band as % of its own diameter | 13.4% | **12.5%** |
| glyphs, drawn extent | 13px svg / ~8–11px painted | 14px svg / **~11px painted** |

**The second number is the one that matters, and it is a trap.** Shrinking the radius alone makes
the ring proportionally *chunkier* — at R 6 with the original 2.2 stroke the band is 18% of the
diameter against 13.4% before, and it stays the loudest thing in the strip no matter how small it
gets. I shipped exactly that mistake first (R 6 / stroke 1.9 = 16%) and it looked barely changed
at 4× zoom. Thickness is what reads as weight here; the radius is secondary.

## A2 · Rhythm — the divider was the most crowded thing in the strip

Measured **painted** gaps (not box gaps — every box is 26×26, so the boxes said nothing):

```
                              before        after
Agents      → ring              19            20
ring        → seam              15            22
seam        → All projects      17            23
All projects→ Open folder       21            20
```

Before, the seam sat in **15–17px** of air while the buttons either side had **19–21px**. The one
element whose entire job is to separate two groups had *less* space than the things it separates,
so the foot read as five items in a row rather than 2 + 2. Seam margin `5` → `11`.

Note the two within-group gaps are now identical (20, 20) — the brief's "robot↔ring looks tighter
than grid↔plus" was 19 vs 21, and closing the ring fixed it without touching `gap`, which stays 4.

## A3 · Glyph weight — two problems, not one

The brief calls out stroke. Measuring the **painted extent** of each glyph found something the
box geometry hid completely:

```
              before   after
robot           10       10
ring            16       13.5
grid            11       11
plus             8       11     ← 27% shorter than the grid it is supposed to pair with
```

The plus spanned 3.5–12.5 of a 16 viewBox; the grid spans 2–14. Same 26px box, same 14px svg,
visibly different glyph. Fixed to `M8 2v12M2 8h12`.

Extent alone didn't finish it: at 6× the grid still carried more mass, because it draws four
closed rects (~72 units of outline) against the plus's two strokes (~24) — 3:1 at equal weight.
`RailFootButton` now takes a `strokeWidth` (default 1.2) used only as an optical correction:
**grid 1.05, plus 1.45**, closing it to ~2:1. That is as far as it goes before the plus reads as
a bar and the grid as a ghost.

## A4 · Padding

`'8px 0 10px'` → `'10px 0'`. The 10 at the bottom is load-bearing — it is what puts this strip's
last icon on the sidebar footer's baseline — so the top came up to meet it, not the reverse.

---

# Part B — Sidebar footer row

## B1 · One baseline for the corner

| | before | after |
|---|---|---|
| rail foot, last icon ink centre | y **869** | y 869 |
| sidebar footer, icon ink centre | y **872** | y **869** |
| `SidebarRail` "+" centre (collapsed) | y **867** | y **869** |

The 3px stagger was purely the box: 26×26 vs 20×22 over a shared 10px bottom padding. Converging
the box fixed it exactly, with no magic numbers.

**The brief asked me to check `SidebarRail`.** It did disagree — 867 vs 869 — so per the brief I
fixed it: `padding: 8` → `'8px 8px 6px'`. All three strips now land on 869 in both sidebar states.

## B2 · The stranded version string — and the obvious fix is the documented bug

`v0.11.2` was `textAlign: 'right'` inside a `flex: 1 1 0` box, parking it at the far edge of a
220px row with ~90px of dead space between it and four huddled icons.

`flex: '0 1 auto'` and `marginLeft: 'auto'` both **reintroduce the wrap bug** the comment at
`Sidebar.tsx:446` documents: with `flexWrap` on, wrapping is decided *before* shrinking, so any
basis other than 0 puts a long version on a line of its own the moment it doesn't fit.

So the basis stays 0 and only the alignment changed: the box still claims all the leftover, it
just no longer pushes its text to the far side of itself. Version + update pip are now one
`flex: 1 1 0` sub-box, left-aligned, so the pip stays beside the version instead of being flung
to the edge. The row reads as one left-anchored cluster; the slack is outboard of the content
rather than splitting it in half.

Ink left edge: **186 (right-aligned) → 190**, i.e. 9px after the last icon. Verified no wrap at
`v0.11.2`, `v0.10.11`, `v0.10.11-rc.4` and `v0.100.100-canary.12345` — row height stays 42 (one
line) throughout, and the longest ellipsises instead of wrapping.

## B3 · Hit boxes

`padding: '3px 4px'` around a 14px glyph (~**20×22**, `borderRadius: 8`) → **26×26, radius 7**,
matching the rail exactly. Nothing shrank. Fit re-checked against the comment's arithmetic: four
26px icons + three 5px gaps + 16px padding = 135 of 220, leaving 85 for the version — past the
56px the comment budgets for the widest plausible string. `flexWrap` intact.

## B4 🔴 · `opacity: 0.85` stacked on `--fg-muted`

**Why this survived: it was invisible to the harness meant to catch it.** `drive-theme-pass`'s
`__contrast` reads an element's `color` — and both strips' icons painted with a hardcoded
`stroke="var(--fg-muted)"` instead, so there was nothing to read and no probe pointed at them.
That hardcoded stroke is also exactly why these four buttons could not answer hover while the
three beside them could.

Both rows now set `color` and draw with `currentColor`, which is what makes them measurable at
all. I added `rail foot icon` and `sidebar footer icon` probes to `drive-theme-pass.mjs`.

Sidebar footer icon ink vs the sidebar field:

```
theme                   at rest                disabled
                    before  ->  after       before  ->  after
                   (×0.85)     (token)      (×0.35)    (mix 65%)
mission-control-dark  4.92  ->  6.48         1.73  ->  3.30
mission-control-light 3.22  ->  4.18         1.53  ->  2.34
mr-pink-dark          5.72  ->  7.38         2.07  ->  3.92
mr-pink-light         2.98  ->  3.80         1.49  ->  2.22   ← was UNDER the 3:1 floor
1984-dark             4.42  ->  5.74         1.66  ->  3.02
1984-light            3.07  ->  3.93         1.51  ->  2.27
```

The brief's "lands invisible on the three light palettes" is confirmed: **mr-pink-light was at
2.98, below the meta floor.** All three lights improve.

Disabled is treated separately, as the brief requires — a `color-mix` toward `--bg-sidebar`, not a
third opacity. **65% is measured, not picked:** my first choice of 55% bottomed out at 1.93:1 on
mr-pink-light, as invisible as the 0.35 it replaced.

*(Before-numbers are computed from the old declarations — `--fg-muted` at α0.85 / α0.35 over
`--bg-sidebar`, same luminance math — rather than from a checkout. Those two inputs fully
determine the old ink, but it is a reconstruction, not a measurement of the old tree.)*

## B5 · Active state

All four buttons now share one `FootButton` with identical rest / hover / active treatment
(background `--overlay-subtle` + ink `--fg`), so the row can no longer drift. The theme toggle
still has no *active* state — it is a verb that toggles a setting, not a view you can currently be
in — but it now shares the hover treatment, which was the actual inconsistency: before, three
buttons lit up and four did nothing.

---

## Verification

- **`npm run build`** — clean (`✓ built in 1.13s`; the pre-existing >500kB chunk warning is
  unrelated and unchanged).
- **`node dev/drive-theme-pass.mjs`**, all 6 palettes — **`BELOW FLOOR (4.5 body / 3 meta): 0`**,
  no regression. `rail foot icon` and `sidebar footer icon` read **identically** in every palette
  (6.48 / 4.18 / 7.38 / 3.80 / 5.74 / 3.93), which is the proof the two arms share one spec.
  Plan-meter fill separation still ΔRGB 84–261 (want >60), so shrinking the ring didn't harm the
  danger/warn/normal thresholds.
- **`dev/drive-corner-balance.mjs`** — baseline delta **3px → 0**; both arms `26x26 r7px`, ink
  `14x14`; all opacities `1`; all strokes `currentColor`; **all 8 controls answer hover** (was 3
  of 7); footer ink column 62 → **68**, the lane-orb column.
- Both sidebar states eyeballed at 2× and the foot at 4–6×
  (`/tmp/operator-shots/final-{expanded,collapsed}.png`, `verbs-6x-v2.png`).
- Regression: `drive-project-rail` (all 7 sections), `drive-rail-tiles`, `drive-plan-limits`,
  `drive-sidebar` pass. `npm test` 420/420.

**Port note:** the brief says to use a live dev server on **1433** and not start another. 1433 is
serving a Python `http.server` directory listing of an empty folder — not the app — so nothing
could be eyeballed there. I used 1436, which is the port this session is assigned; I did not bind
1433.

---

## Decided NOT to do

- **The duplicate `+`.** In the collapsed state the corner now shows two `+` buttons on one
  baseline — and they are the *same action*: `onOpenFolder={handleNewSession}`
  (`DashboardView.tsx:2689`, `:3032`), the same handler and the same ⌘N as `SidebarRail`'s
  accent button. `ProjectRail.tsx` already states the rule this breaks — *"Two identical +
  buttons 44px apart is how you get one that nobody trusts"* — which was applied when the button
  was pulled out of the sidebar footer but never extended to `SidebarRail`. Aligning the baseline
  has made it **more** conspicuous, not less: perfectly aligned duplicates draw the eye to their
  sameness. The fix is deleting `SidebarRail.tsx:169-195`; nothing is stranded, because the rail
  carries the action in every state. Left alone because it deletes a shipped primary CTA.
- **Re-toning `delivered`/`sent` chips**, noted while in `drive-theme-pass` — out of scope here,
  raised in the channel result instead.
- **The update pip's size.** 14×14 in a row of 26×26 boxes. It centres correctly on 869 and it is
  a badge rather than an icon, so the difference is defensible — but it is the one thing in the
  row not on the shared spec. I could not exercise it live; the fixture never sets `update`.
- **The disabled folder button in situ.** `!project?.path` is near-unreachable (`pickFolder`
  always yields a path), so its ink is computed from the component's own expression rather than
  read off a rendered DOM.
