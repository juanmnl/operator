# Perf pass 3 — an orb below the fold draws nothing

A busy orb that has scrolled out of the rail leaves the frame loop and rejoins when it comes back.

**Twenty lanes, five on screen: renderer 12.1% → 5.9%, drawing 60.1 → 18.3 ms/s.**
Seven lanes, two on screen: 6.4% → 4.1%, drawing 25.1 → 9.3 ms/s. Off-screen orbs paint
**zero** — counted, not inferred.

This is pass 2's cheap half, and it was impossible before it. A CSS animation runs wherever it is
declared; there is no way to tell one to stop because its element scrolled out of view. A paint
loop can simply be left.

---

## The change

`OrbCanvas` observes its own canvas. Not intersecting → leave the shared frame loop; intersecting
→ rejoin. `rootMargin: 48px` starts an orb a little before it arrives, so its first visible frame
is the current phase rather than a stale one. No observer available → draw as before, which is the
only sane fallback for a perf optimisation.

**Leaving is safe because the animation is a function of absolute time, not an accumulator.**
`twinkleProgress(elapsed, dur, delay)` asks the clock where the dot is; it does not add a delta
per frame. An orb out of view for a minute paints, on return, exactly the frame it would have
painted had it never stopped. That property is now a test — `is a function of TIME, not of frames`
— because `phase += delta` is the obvious way to write a canvas animation, would pass every other
test in the file, and would make a rail that scrolls drift its lanes out of their seeded rhythm
one scroll at a time.

## Measured

Same bench and protocol: Chromium, `top -l 14 -s 1`, first two samples discarded, three
alternating runs, `dev/perf-orbs.html?visible=k` clipping the column to k rows.

| lanes | on screen | renderer | GPU | drawing (script) |
|---|---|---|---|---|
| 20 | 20 | 12.1% | 1.9% | 60.1 ms/s |
| 20 | **5** | **5.9%** | 1.6% | **18.3 ms/s** |
| 7 | 7 | 6.4% | 1.4% | 25.1 ms/s |
| 7 | **2** | **4.1%** | 1.3% | **9.3 ms/s** |

Drawing falls to 30% at 5-of-20 and 37% at 2-of-7 — a little above the naive 25% and 29% because
`rootMargin` keeps a row-and-a-bit of margin painting on each side, which is what it is for.

The gate itself is verified by counting, not by CPU: instrumenting `CanvasRenderingContext2D.fill`
and watching for 1.5s with 2 of 7 orbs on screen gives `{0: 3330, 1: 3330, 2: 0, 3: 0, 4: 0, 5: 0,
6: 0}`. Scrolling to the bottom moves it to `{0: 37, 1: 37, …, 5: 2627, 6: 2627}` — the two that
left painted one last frame and stopped; the two that arrived took over.

**Resting states are still byte-identical** (`idle`, `waiting`, `error`, `ended`). They do not
animate, so they were never in the loop to leave.

---

## A correction to pass 2's numbers

The sampler was matching **every Chromium on the machine**, not just the browser it launched. On a
run with another Playwright browser open it silently summed a stranger's renderer into the total.

Caught in the act: one run reported `rendererPids: 3` and **142% CPU** next to an otherwise
identical run's 2 pids and **7.8%**. A sampler that quietly includes someone else's process does
not produce a noisy number — it produces a confident wrong one, and pass 2's memory figures are
wrong because of it.

`dev/measure-orb-cpu.mjs` now snapshots the `--type=renderer` / `--type=gpu-process` pids that
exist **before** the launch and excludes them by pid, and reports `rendererPids` / `gpuPids` in
every result so a contaminated run is visible on its face. (`browser.process()` would have been
tidier; this Playwright build does not expose it on `Browser`.)

Re-measured with the scoped sampler, seven busy orbs, three alternating runs — pass 1's two-layer
SVG against what ships now:

| | renderer | GPU | renderer RSS | GPU RSS |
|---|---|---|---|---|
| pass-1 SVG (`005907c`) | 30.8% | 7.2% | 187 MB | 29 MB |
| pass-3 canvas | **6.1%** | **1.5%** | **37 MB** | **16 MB** |

The CPU ratio pass 2 reported holds (−80% renderer, −79% GPU — it said −79%/−80%). The memory
figures in that report — 580 → 430 MB renderer, 58 → 44 MB GPU — were inflated by the other
browsers and should be read as **187 → 37 MB** and **29 → 16 MB**. The direction and the
magnitude of the saving were right; the absolute numbers were not.

A second measurement bug, same family, found while building this pass: **the window was doing the
clipping.** An IntersectionObserver's default root is the viewport, so a 200px-tall page hid most
of a 20-orb column whatever the scroller said, and the first "20 visible vs 5 visible" comparison
measured the same ~5 orbs twice (18.8 against 15.9 ms/s of script — which read as "the gate barely
helps"). The bench now sizes the window to hold exactly the number of orbs a case asks for.

## What changed

| File | Change |
|------|--------|
| `src/renderer/components/sidebar/StatusWave.tsx` | `OrbCanvas` gates its frame-loop membership on an `IntersectionObserver` |
| `src/renderer/components/sidebar/StatusWave.test.ts` | +2 tests: progress is a function of time, not frames; a gap returns to where it would have been |
| `dev/perf-orbs.tsx` | `?visible=k` — a scrolling column with k rows on screen |
| `dev/measure-orb-cpu.mjs` | pids scoped to the launched browser and reported; viewport sized to the case |

`tsc --noEmit` clean. 938 passing; the 33 failures are pre-existing and unrelated.

## For pass 4

- **`visibility: hidden` is not covered.** An IntersectionObserver reports a hidden-but-laid-out
  element as intersecting, and this app does park panes that way. Nothing in the rail does it
  today, so nothing is being wasted — but an orb inside such a pane would keep painting.
  `Element.checkVisibility()` in the observer callback would close it.
- **The floor is now ~1.2 ms/s of drawing per visible orb.** Seven of them is 9 ms/s. Further
  work belongs somewhere else in the app.
