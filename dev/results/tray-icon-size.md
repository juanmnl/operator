# Tray icon size — 20pt → 18pt

**Branch:** `operator/a30080` · commit `c0892b5` · 2026-08-24 · Code lane

## The numbers

Measured by rasterizing `frame()` across a full animation cycle (60 samples, 0.05s apart) in all
three phases and taking the extent of every non-zero alpha pixel — not derived from the constants,
so a mismatch between what the constants say and what gets painted would have shown up.

| | Canvas | `MARK` | `INSET` | Ink extent (x, y) | Painted | At `scaleFactor: 2` |
|---|---:|---:|---:|---|---:|---:|
| **Before** | 44×44 | 40.0 | 2 | `2..41` | **40px** | **20.0pt** |
| **After** | 44×44 | 36.0 | 4 | `4..39` | **36px** | **18.0pt** |

Identical in `idle`, `busy` and `your-turn` — the dot *scale* varies with time but the mark's
outer bound does not, which is why the test asserts the extent across a cycle rather than on one
frame.

macOS menu-bar template icons are ~18pt. The old 20pt is why it read larger than the Tauri build's.

## What changed

**`electron/src/main/tray-anim.ts`** — `MARK` 40 → 36; `INSET` is derived and follows, 2 → 4.

The canvas stays **44**. Shrinking it instead would have been the same pixels in a different
container, and would have moved the problem onto anything else that assumed 44 (the buffer length,
the bitmap dimensions handed to `createFromBitmap`, the test's own `SIZE`).

**`electron/src/main/tray.ts`** — `trayImage()` is now `frameImage(buildDots(), 'idle', 0)`
instead of reading `src-tauri/icons/tray.png`.

This is the half worth explaining. The PNG's opaque box is 40×40 inside its 44×44 canvas, and
`MARK` was a hand-matched copy of that number, with a comment saying so. Two geometries in two
files, agreeing only for as long as nobody edited either — which is precisely how this drifted in
the first place. They are now **one number in one file**, and the icon cannot change size between
its first paint and its second. `frameImage(…, 'idle', 0)` is also exactly the frame the animation
settles back to, so the static icon *is* the rest state rather than a lookalike of it.

`setTemplateImage(true)` and `scaleFactor: 2` are unchanged on both paths.

**`electron/scripts/build-main.mjs`** — nothing reads `out/tray.png` any more. The copy is kept
(it costs nothing, and the PNG is still the Tauri build's icon source), but its comment no longer
claims to be feeding the tray; it points at `tray-anim.ts` instead. A dead step with a confident
wrong comment is worse than a dead step.

## The test

`tray-anim.test.ts`'s size assertion was *"the 1px border is empty"*, which is a weak proxy: dot
scale varies with time, so a single frame can sit well inside the mark and pass a border check
while the mark itself is the wrong size — it would have passed before and after this change. It
now measures the extent across a full cycle in all three phases and asserts the exact box, the
36px width, and the 18pt result. The old border check survives as its own test, because "never
paints outside the canvas" is still worth pinning.

## Checks

| | |
|---|---|
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `tsc --noEmit` (root) | **0** |
| `vitest run` (electron) | **351 passed, 0 failed** |
| `npm test` (root) | **834 passed / 33 failed** — the 33 unchanged, pre-existing jsdom-under-Node-26 |

## Not verified

Not seen in a real menu bar — GUI verification is yours. The pixel measurements above are exact
and come from the shipping rasterizer, so what is left to check by eye is the judgement call:
whether 18pt sits right next to your other menu-bar items, and that the first paint no longer
changes size when the animation starts.
