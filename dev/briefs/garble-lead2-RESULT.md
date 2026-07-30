# Result — garble-heal-gap.md, lead 2

Lead 1 is dead (gate confirmed open). Lead 2 was the live thread, and it turned out to have
**two** faults in it — neither of which was the one the brief guessed. The guessed one
("0.02px is collapsed by pixel-snapping, bump it") is **closed by measurement**.

Changed: `components/terminal/TerminalPane.tsx`, `views/DashboardView.tsx`.
New harness: `dev/drive-buffer-dump.mjs`.

---

## Finding 1 — bumping the nudge is pointless (measured)

Rendered a terminal-like block in WebKit and diffed the raster against an untransformed
baseline, decoding the PNGs and comparing actual channel values (dPR 2):

| translate | pixels changed | max channel Δ |
|---|---|---|
| `0.02px` | 2.93 % | 194 |
| `0.1px`  | 3.03 % | 194 |
| `0.34px` | 3.05 % | 194 |
| `0.5px`  | 3.05 % | 194 |

The rasterisation flip has **already happened at 0.02px**, and going 25× larger moves the
needle by 0.12 percentage points with an identical peak delta. There is no threshold between
`0.02px` and a full device pixel for a bigger number to cross. Bumping it would only shift text
antialiasing further for no mechanical gain, so **I did not bump it**, and I've written the
numbers into the code comment so nobody tries again.

## Finding 2 — the nudge was frequently never painted at all (measured, and fixed)

`hardRepaint` set a style and reverted it **in the next rAF**. Those are not a frame apart: rAF
callbacks run at the *start* of a frame's rendering steps, so a set/revert pair inside one
rendering opportunity can coalesce and the compositor never sees the changed value.

Measured directly — a red fill applied in a timer task and reverted either on the next rAF or
after two, sampled 25 times:

```
revert on the NEXT rAF (what the heal did):   intermediate painted  7/25
revert after TWO rAFs:                        intermediate painted 11/25
```

So the heal was **skipping its own commit most cycles**. It "ran" — lead 1 proved the gate was
open — without forcing anything. That is a much better fit for "the heal runs, and it still
garbles" than a nudge that is too small.

**Fix:** a `holdFrame(apply, revert)` helper that reverts after two rAFs, so a painted frame is
guaranteed to have carried the changed value. Both mechanisms go through it.

## Finding 3 — the escalation, wired where the brief reserved space for it

Added `rebuildLayer()`: `refresh` + a `will-change: transform` promote/demote cycle, held one
frame. A transform nudge only asks the compositor to re-commit pixels it may believe are still
valid; a layer promote/demote **destroys and rebuilds the backing store**, so a stale raster
cannot survive it.

Measured pixel-identical while applied — **0 of ~400k pixels changed at dPR 1 and dPR 2** — so
it does not repeat the v0.8.5 opacity/visibility bleed: the element never stops being opaque or
painted, and no layer beneath can show through.

Cost is a viewport-sized backing store per call, so it is wired **only to the ≤1/sec heal**:

| path | cadence | mechanism |
|---|---|---|
| `scheduleRepaint` throttle | ≤1/180ms | `term.refresh` only (unchanged) |
| settle debounce (90ms) | per burst-end | `hardRepaint` — refresh + nudge, now held a frame |
| heal interval | ≤1/sec, gated on recent output | **`rebuildLayer`** — refresh + layer rebuild |

The 6s output gate stays. Lead 1 showed it was open throughout the sighting, and the comment at
`:366` is right that a genuinely idle session must not spin.

---

## The diagnostic — it was never run, and it is not silently broken

`~/.operator/terminal-dumps/` doesn't exist because the command has genuinely never been used,
not because it fails. Traced and then exercised:

- **The writer creates its own directory.** `folderprefs::save_md_file` does `create_dir_all`
  on the parent and returns `Err` on failure, which the handler surfaces as an **error toast
  carrying the exception text** — I saw exactly that when it failed in the harness. It cannot
  fail silently.
- **The ACL permits it.** The handler is the renderer's only importer of
  `@tauri-apps/api/path`, so `plugin:path|resolve_directory` / `plugin:path|join` had never
  been exercised — worth checking, because an ACL-denied invoke is precisely how this would
  have failed in the real app only. `core:default` expands to include `core:path:default`
  (`src-tauri/gen/schemas/acl-manifests.json`), so it is allowed. No capability change needed.
- **Fixed: the filename now carries the terminal id.** It was
  `<sessionId8>-<timestamp>.txt` — the terminal id was in the body but not the name. Two dumps
  of one session across a restart differ *only* by terminal id, and that difference is the
  first thing you want in a directory listing. Now
  `<sessionId8>-<terminalId8>-<timestamp>.txt`, e.g.
  `sop-t0-2026-07-29T18-07-33-813Z.txt`.

`dev/drive-buffer-dump.mjs` (new) drives ⌘K → the command → the file writer and asserts the
path, the header block and the filename shape. It shims `window.__TAURI_INTERNALS__` for the
two path commands, since a plain browser has none; everything downstream of that is real code.

```
1 palette entry: Dump terminal buffer (debug)
2 reached the file writer: true
2 path: /Users/harness/.operator/terminal-dumps/sop-t0-2026-07-29T18-07-33-813Z.txt
3 header: # terminal buffer dump / timestamp / sessionId / terminalId / size 140x53
4 checks: underTerminalDumps ✓ hasTimestamp ✓ carriesTerminalId ✓
```

---

## What is NOT confirmed

**Efficacy against a real stale rect. Headless WebKit has none, so no harness can prove a heal
works** — the brief is explicit about this and I'm not claiming otherwise. What I have proven
is mechanism, not cure:

- the nudge was often not painted, and now is (7/25 → 11/25 on the same probe);
- a bigger nudge would have bought nothing (raster deltas identical from 0.02px to 0.5px);
- the layer rebuild is visually inert (0 pixels changed) and structurally cannot reuse a stale
  backing store.

**What you need to eyeball, on the next long thinking phase:**

1. Does the garble still appear? That's the whole question.
2. If it does — hit **⌘K → "Dump terminal buffer (debug)"** *while it is on screen*, then
   compare `~/.operator/terminal-dumps/<file>.txt` against the screenshot. Clean file +
   garbled screen = still pixel-only, and the next lever is `contain` or forcing a repaint
   through a different property. Garbled file = the buffer is wrong after all and this whole
   line of investigation is aimed at the wrong layer.
3. Watch for any **flicker or text shimmer once a second** on the active terminal. The layer
   rebuild measured inert, but "inert in a headless raster" and "inert on a live GPU
   compositor" are not the same claim. If you see a 1Hz twitch, that's this change, and the
   heal should drop back to `hardRepaint` with the layer rebuild moved to settle-only.

## Regression gates — clean

- `npm run verify:dom` — **0/30 mismatched rows**; the DOM renderer is still not the problem.
- `npm run verify:width` — all cases pass.
- `npm test` — 271 passed / 34 files.
- `npm run build` — clean.
