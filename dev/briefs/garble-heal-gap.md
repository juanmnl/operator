# Brief — terminal garble: the heal runs, and it still garbles

Sighting: 2026-07-29, live, during a long `thinking` phase (status line read
`Working… (16m 18s · ↓ 49.1k tokens)`). Screenshot shows classic overprint —
interleaved characters, eaten spaces, two status lines composited on top of each other.

Read `dev/garble-triage.md` first. This brief is the code-side follow-up to it.

## What is already established — do NOT re-derive

- `npm run verify:dom` re-run 2026-07-29 → **0/30 mismatched rows**. The DOM renderer is clean.
  No regression. The corruption is **pixel compositing only** — the buffer and the DOM are right,
  the screen is stale. No parser/width fix will help.
- The `translateZ(0) ↔ ''` no-op was already replaced. `hardRepaint` (`TerminalPane.tsx:339-349`)
  now does `term.refresh(0, rows-1)` + a non-identity `translate3d(0, 0.02px, 0)` nudge, reverted
  on the next rAF. That is the CHOSEN mechanism and its rationale is documented at `:313-338`.
- Burned, never reintroduce: opacity nudge (shipped v0.8.5, reverted v0.8.6 — sub-1 frame let the
  layer beneath bleed through), visibility/content-visibility toggles (same bleed), width/padding
  nudge (trips xterm's ResizeObserver → full buffer reflow).
- `tui:fullscreen` / alt-screen structurally can't leave stale rects, but it is CLOSED as an
  option: it desyncs cells and freezes input. Do not reopen it.

## The two leads

### 1. The heal loop is gated on recent output — and a long think emits none

`TerminalPane.tsx:367-369`:
```ts
const healInterval = window.setInterval(() => {
  if (Date.now() - lastDataAtRef.current < 6000) hardRepaint()
}, 1000)
```
The heal stops 6s after the last byte. This sighting was 16 minutes into a thinking phase — the
spinner/timer line updates, but if those writes are sparse or land on a different path,
`lastDataAtRef` goes stale and **nothing is healing the stale rect while the user stares at it**.
`:269` already acknowledges the shape of this ("The heal loop only runs during output, so an idle
…").

Investigate: does the ticking elapsed-timer/token-count line actually bump `lastDataAtRef`? If it
does, the gate isn't the bug and this lead dies — say so explicitly in the result file rather than
silently dropping it. If it doesn't, the fix is to keep a slower heal alive while the session is
*busy* (phase `running`/`compacting`), not merely while bytes are arriving. Do not make it
unconditional — `:366` is explicit that it must pause when the session is genuinely idle.

### 2. `0.02px` may be collapsed by pixel-snapping

`TerminalPane.tsx:335-337` names this in advance: *"If live testing shows 0.02px is still
collapsed by pixel-snapping, bump the value or switch to a will-change/contain cycle (layer
rebuild) — both force a commit too, but are heavier per call."*

That is now the live evidence. Try, in order of cost: a larger sub-device-pixel value; then a
`will-change` or `contain` add/remove cycle that forces a genuine layer rebuild. Keep the element
fully opaque and do not change layout.

## The hard constraint on verifying this

**Headless WebKit renders correctly — it has no stale rect, so no automated harness can prove a
heal works.** `verify:dom` proves the DOM is right, which is already known and is not the
question. Only the live app can confirm efficacy. So:

- Do not claim a fix is confirmed on the strength of a green harness. Say precisely what you
  changed, what mechanism you expect it to force, and that live confirmation is outstanding.
- Do not regress the DOM: `npm run verify:dom` and `npm run verify:width` must stay clean.
- Keep the cost profile: heavier than `refresh`, so settle + periodic only, **never per-chunk**.

## Also — the diagnostic has never been run

`~/.operator/terminal-dumps/` does not exist, so the ⌘K **"Dump terminal buffer (debug)"** command
(`DashboardView.tsx:2054`, handler `:1814`) has never been used. Confirm it actually writes a file
and that the filename carries both terminal id and timestamp (the triage doc flags at step 2 that
the format was never finalised). If it's broken, fix it — it is the only instrument that can
settle buffer-vs-pixels on the next sighting, and it is worthless if it fails silently.

## Write your result to

`dev/briefs/garble-heal-gap-RESULT.md` — what you changed, which lead proved out, which died, and
exactly what the user needs to eyeball to confirm. There is no other way for me to see your output.
