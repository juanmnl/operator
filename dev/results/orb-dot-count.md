# The rail orb's dot count — 37 is right, don't touch it

**Verdict: keep CELLS=7 / RADIUS=3.4 / 37 dots. Change nothing in `StatusWave.tsx`.**

Every candidate below 37 either breaks the disc silhouette or drops the orb out of the
"thinking" register into a different, worse one — and the shimmer that the brief suspected
was sub-pixel is not sub-pixel at any size the orb actually renders at.

Perf pass 2 (canvas-painted orb, renderer 35.4%→7.3%, GPU 9.0%→1.8%) removed the only reason
the question was asked — animated-element count is no longer a CPU cost at all. But the
answer would have been the same before it: the cheapest remaining win was never worth what
it cost, and §2 shows the constraint the file leans on does not even permit the trade.

(The canvas orb is not in this worktree — `StatusWave.tsx` here still draws 37 SVG `<circle>`s
at `7ab5a68`. Nothing below depends on the renderer: it is all geometry and timing, which the
canvas port carries over unchanged.)

---

## 1. The sizes audit — the premise was wrong

The brief assumed 24px. There are **eight** distinct sizes, and 24 is the largest:

| size | call site |
|---|---|
| 11 | `TaskBoard.tsx:688`, `:999` — the running chip and the tone dot |
| 12 | `CanvasConversation.tsx:1061` — inline signal |
| 13 | `QuitGuard.tsx:95`, `CanvasConversation.tsx:1099` |
| 14 | `ProjectGallery.tsx:594` — the lane strip on a gallery card |
| 15 | `ActivityDashboard.tsx:114` |
| 17 | `ChatComposer.tsx:340` (`ORB_WAVE`) |
| 20 | `AgentsHubView.tsx:314` — the roster |
| 24 | `ProjectRail.tsx:965` (`ORB`), `SessionItem.tsx:175` — the rail, with the letter |

**"Most of that shimmer is sub-pixel" is false.** A cell is `size/7` CSS px and a dot's
diameter is one full cell (`R = 0.5` cell units). On the retina display the app ships to:

| size | cell (device px) | dot Ø at peak | dot Ø at trough (scale 0.5) |
|---|---|---|---|
| 24 (rail) | 6.86 | **6.9 device px** | 3.4 |
| 17 | 4.86 | 4.9 | 2.4 |
| 11 (smallest) | 3.14 | **3.1 device px** | 1.6 |

At the rail the twinkling dot is a ~7-device-pixel disc breathing to ~3.4 and back. That is
a large, plainly resolvable object. Even at the smallest site in the app the peak dot is
3.1 device px — above the ~2px floor where antialiasing dissolves a shape into a smear. The
one thing that *is* sub-pixel is the trough at 11px (1.6px), and a dot is supposed to
disappear at its trough. Nothing is being wasted on invisible detail.

## 2. Ink is invariant to count — the file's binding constraint does not bind here

The comment block in `StatusWave.tsx` fixes the busy-versus-quiet argument on ink: a running
dot averages ≈0.51 of a full-strength dot over its cycle against a resting orb's flat
`REST_OP = 0.25`. Modelled over 30 s at 60 fps across six lane seeds, with the real
`ease-in-out` bezier and the real `durMin/durMax/tempo` generator:

```
layout                 N   mean ink/dot   ink vs rest
7×7 r3.4 (SHIPPED)    37          0.436         1.74×
7×7 r3.0              29          0.436         1.74×
5×5 r2.4              21          0.436         1.74×
5×5 r2.0              13          0.436         1.74×
3×3 r1.4               9          0.437         1.75×
```

(0.436 rather than 0.51 because this weights ink by *area* — `opacity · scale²` — where the
file's figure is `opacity · scale`. The ratio to rest is what the constraint is about, and
it clears 1.7× either way.)

**Mean ink per dot does not move with the count**, because each dot runs its own unchanged
cycle. The disc's coverage fraction is also count-invariant (dots are always `r = 0.5` on a
1-unit pitch → π/4 of every cell). So the "twice the ink" rule and the trough rule are both
silent on this question. They neither permit nor forbid a cut. The decision has to be made
somewhere else.

## 3. Where it is actually decided: fewer dots make the mark UNSTABLE

A dot spends most of its cycle far below the resting level, so at any instant a chunk of the
disc is missing. That is fine when it reads as *texture on a surface*. It stops being fine
when the missing chunk is structural.

```
layout                 N   below rest   swing (min..max)   dots near peak   worst invisible
7×7 r3.4 (SHIPPED)    37         42%             19 .. 65%           12.9             25%
7×7 r3.0              29         42%             16 .. 67%           10.1             29%
5×5 r2.4              21         42%             13 .. 72%            7.3             32%
5×5 r2.0              13         42%              9 .. 79%            4.5             38%
3×3 r1.4               9         42%              6 .. 85%            3.1             43%
```

At **37**, ~13 dots sit near peak at any moment and the worst instant still leaves 75% of
the disc drawn — scattered over 37 positions, so the outline always closes. You read a round
object with moving texture.

At **9**, 3.1 dots are near peak and up to 43% of the mark is gone at once — but with only
nine positions, the four that vanish *are* a corner of the mark. The screenshots show this
directly: compare the `9 · 3×3` row between frame 0 and frame 1 and the silhouette is a
different shape each time. That is not a disc thinking, it is three lights blinking — and
"discrete lights blinking" is the register the retired unison your-turn pulse occupied. The
cut would put the busy state into the beacon's idiom.

**The count is not a motion budget, it is a resolution budget.** "Thinking" is carried by how
many independent twinkles you can resolve at once. Below roughly seven simultaneous peaks
the impression collapses from a surface to a handful of blinking points, and 21 is the last
candidate that clears it (7.3).

### The counter-intuitive half, for completeness

Aggregate flicker gets *stronger* as the count falls — 37 desynced sinusoids average each
other out, 9 do not:

```
layout                 N   flicker CV   Michelson contrast of the whole disc
7×7 r3.4 (SHIPPED)    37        0.116                 0.298
7×7 r3.0              29        0.135                 0.337
5×5 r2.4              21        0.161                 0.390
5×5 r2.0              13        0.206                 0.473
3×3 r1.4               9        0.225                 0.546
```

So if the only question were "is it moving", fewer dots would win. It is not the only
question, and 37 is already 25–50× over the temporal-contrast detection threshold at ~0.5 Hz
(≈1% at that rate). The shipped orb has an enormous margin on *detecting* motion and spends
its dots on *characterising* it. That is the correct trade for a thing whose whole job is to
say "working" rather than "alert".

## 4. What the screenshots show

`/tmp/operator-shots/orb-dots/{wk,blink}-<theme>-f{0,1,2}.png` — every candidate × all eight
real sizes × running-beside-resting, at deviceScaleFactor 2 (real retina size), in
mission-control dark/light, 1984 dark and mr-pink light. Three frames ~0.55 s apart, because
one still of a shimmer lies. WebKit (what the app ships in) and Chromium (whose compositor
the perf work was about) agree on the pixels.

- **37 (shipped)** — a round disc at all eight sizes, in both themes. Texture shifts between
  frames, footprint does not. The letter sits on it cleanly at 24.
- **29 (7×7 r3.0)** — the worst of the set and the one that looks cheapest on paper. Dropping
  the radius clips the corners into an octagon-plus; at 11–14px it reads skeletal, and at 24
  it is visibly *not the logo*. Rejected on silhouette alone.
- **21 (5×5 r2.4)** — the only real contender. Still round, chunkier, holds its footprint
  across frames. Fails on §5 below, not on legibility.
- **13 (5×5 r2.0)** — a plus/diamond, not a disc. Off-brand at every size.
- **9 (3×3 r1.4)** — a square. The circle is gone entirely, and the resting orb becomes a
  heavy opaque block: on mission-control light the quiet lanes stop receding, which is the
  exact complaint `REST_OP` was lowered to 0.25 to answer. Integrated ink is unchanged, but
  37 small dots spatially average into a soft grey wash while 9 large ones resolve as hard
  discs at full 0.25 — so the *perceived* weight of a resting lane goes up when the count
  goes down.

## 5. The count is a three-way mirror, and one leg has a test on it

`CELLS`/`RADIUS` are not local to `StatusWave.tsx`:

- `components/LogoMark.tsx` — the brand mark, `radius = (cells/7) * 3.4`, explicitly "geometry
  mirrors StatusWave".
- `src-tauri/src/tray_anim.rs` — the menu-bar icon: `CENTER 3.5`, `DISC 3.4`, and a test that
  asserts `dots.len() == 37`.

So a cut is a three-repo-surface change ending in "the rail orb and the app's logo are now
different marks". That is a brand decision wearing a perf decision's clothes, and there is no
longer a perf decision underneath it.

## 6. If it ever has to shrink anyway

Not recommended, but so the next person does not re-derive it: the lever is **which dots
animate, not how many exist**. Keep all 37 circles and give the outer ring `staticOp` while
the inner ~19 twinkle. Silhouette is preserved exactly, the logo mirror is untouched, the ink
ratio goes *up* (static dots at 0.5 against rest's 0.25), and animated-element count halves.
It fails the resolution budget less badly than any geometry cut because the twinkles that
survive are the ones nearest the eye's fixation point. Do this before ever touching `CELLS`.

---

### Reproduce

- `dev/drive-orb-flicker.mjs` — the ink / aggregate-flicker / silhouette-stability model.
- `dev/drive-orb-dots.mjs` — the screenshot sheet (Playwright, WebKit + Chromium, dSF 2).

Both transcribe `StatusWave`'s dot generation 1:1 rather than importing it, so they measure
the shipped numbers without needing the app running.
