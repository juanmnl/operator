# Result — sidebar-collapse terminal vertical-space defect

Brief: `dev/briefs/2026-08-20-sidebar-collapse-terminal-vspace.md`. Driver:
`dev/drive-sidebar-collapse-vspace.mjs` (throwaway, `dev/` only — no product code touched).
Run against the already-live dev server: `MOCK_PORT=1430 node dev/drive-sidebar-collapse-vspace.mjs`.

## Setup

Boot the mock harness expanded (default), activate a lane (`[data-lane-row]`/`[data-session-row]`
— `[data-rail-session]` only exists on the *collapsed* rail's orb, which is why the first attempt
at this driver timed out), feed 80 lines of filler through `window.__mockTerminalData` so the
xterm pane has real content, clear the call log, mark a page-side `performance.now()` zero point,
press ⌘B, and sample at t = 0/100/260/320/500/1000/2000ms. `terminalResize` / `gridtermResize` /
`gridtermAttach` are spied by wrapping the `window.operator` setter in an `addInitScript`, the same
technique `dev/drive-gridterm-wire.mjs` uses.

**One driver bug worth naming**: the first run stamped call timestamps with page-side
`performance.now()` (since navigation) but compared them against a Node-side `Date.now()` toggle
marker — two different clocks — and produced a bogus "resize fired 3066ms after the toggle"
reading. Fixed by stamping `window.__toggleT0 = performance.now()` atomically with the key press
and reporting every call as `t - toggleT0`. Flagging this because it's exactly the kind of
measurement artifact that could get reported as a finding if not caught — the corrected numbers
below are the ones from the fixed driver (`vspace-run4.log` in the scratchpad if still present).

## What the harness proves: LAYOUT is ruled out, ROWS is ruled out

The root of the whole view is `height: '100vh'` (`DashboardView.tsx:3933`), and `ProjectRail`
animates only `width: 260ms cubic-bezier(...)` (`ProjectRail.tsx:334`) — nothing in the collapse
touches height. Measured across every sample, in every pass:

```
content-column height stable across the whole window: true (values: 884.0)
xterm row COUNT stable across the whole window: true (values: 53)
```

The content column's `getBoundingClientRect().height` was **884.0px at every single sample**,
before, during, and after the collapse, in both the xterm and grid passes. The one
`terminalResize` call that fired sent `rows=53` — identical to the row count before the toggle and
identical to the DOM's rendered `.xterm-rows` child count at every sample. There is no code path in
this collapse that can change the pane's height or the pty's row count, and none did. **A pure
layout bug (host offset under the header, height carried over from before the collapse, a
leftover transform) and a "pty rows < pane rows" resize bug are both ruled out as causes of the
row dimension** — the mechanism the user saw cannot be either of those, at least not from anything
this brief pointed at.

That leaves cols/width as the only thing that actually moves during this animation — and there,
the harness found a real, reproducible bug.

## XTERM path — CONFIRMED: the fit can be starved indefinitely by streaming output

`TerminalPane.tsx:110-132`'s `handleResize` reschedules itself instead of fitting whenever
`Date.now() - lastDataAtRef.current < FIT_QUIET_MS` (150ms, `TerminalPane.tsx:93`) — including the
ONE call the `suspendFit → false` effect makes when the 320ms hold ends
(`TerminalPane.tsx:630-632`). That gate has no bound: as long as new data keeps landing inside
every 150ms window, the fit reschedules forever and never runs.

**Idle (no output during/after the toggle) — clean, single resize at 327ms:**
```
t= 260ms  col=1355.0x884.0 host=1355.0x798.0  screen=1135.0x795.0 rows=53  resizeCalls=0
t= 320ms  col=1356.0x884.0 host=1356.0x798.0  screen=1135.0x795.0 rows=53  resizeCalls=0
t= 500ms  col=1356.0x884.0 host=1356.0x798.0  screen=1338.0x795.0 rows=53  resizeCalls=1 last=[t0,171,53]@327ms
```
The host is already at its final width by t=260-320ms (matches the declared 260ms CSS transition
plus the 320ms JS hold), but `.xterm-screen` — the actual rendered terminal — stays at the STALE
pre-collapse width (1135px) through t=320ms and only catches up to 1338px by t=500ms. That ~180ms
gap between "the box is the new size" and "the terminal visibly uses it" is the real, measured
version of "slow to take the freed width" — small or annoying, but self-resolving, in the idle case.

**Streaming (synthetic output arriving every 60ms throughout) — starved, zero resizes in 2000ms:**
```
t= 320ms  col=1356.0x884.0 host=1356.0x798.0  screen=1135.0x795.0 rows=53  resizeCalls=0
t=2000ms  col=1356.0x884.0 host=1356.0x798.0  screen=1135.0x795.0 rows=53  resizeCalls=0
all IPC calls (fn@t, args) over 2000ms window:   (empty)
```
Every 60ms tick resets `lastDataAtRef`, so `sinceData` never clears 150ms and the deferred fit
keeps rescheduling itself past the entire 2-second sampling window — the terminal simply never
catches up to the new width while output keeps arriving. This is the mechanism for "well past the
260ms animation" the user actually reported: a real Claude Code session producing spinner/output
updates more often than every 150ms (entirely plausible) would hit this every time.

Cols/rows in the one fired call: `terminalResize(t0, 171, 53)` — rows unchanged (correct, since
height never moved), cols recomputed for the new width. No evidence of a resize sent with a stale
or wrong value — when it fires, it fires once, correctly. The bug is purely about **whether it
fires at all**, not what it sends.

## GRID path — clean, no starvation risk, but uncoordinated by design

`GridTerminalPane` gets no `suspendFit` prop at all (`DashboardView.tsx:4273-4282` passes only
`terminalId`/`theme`/`active`) — it relies entirely on its own `ResizeObserver` + 120ms
settle-after-last-*resize-event* debounce (`GridTerminalPane.tsx:358-363`), which is NOT gated on
output activity the way xterm's is:
```
t= 260ms  col=1355.8x884.0 host=1355.8x798.0 host.clientWH=1356x798  resizeCalls=0
t= 320ms  col=1356.0x884.0 host=1356.0x798.0 host.clientWH=1356x798  resizeCalls=0
t= 500ms  col=1356.0x884.0 host=1356.0x798.0 host.clientWH=1356x798  resizeCalls=1 last=[t0,172,46]@401ms
all IPC calls: 401ms  gridtermResize(t0, 172, 46)
```
One clean call at 401ms — ≈260ms (transition end) + 120ms (its own debounce), exactly as its code
predicts. Because this debounce resets on *resize* events, not *data* events, the streaming
starvation found on the xterm path structurally cannot happen here — a continuously-updating
`gridterm:update` stream never touches `resizeTimer`. Not a proven bug, but worth naming: nothing
here guards against firing mid-transition if the browser's ResizeObserver batching ever changes —
today it happened not to, by observer-coalescing luck, not by an explicit hold.

Rows: 46 vs xterm's 53 for the same 798px-tall host — expected, the grid pane uses `LINE_HEIGHT =
Math.round(13 * 1.3) = 17px` rows vs xterm's tighter `lineHeight: 1.2`, not a defect.

## The vertical symptom itself — NOT reproduced, and here's why that's the honest answer

"Content in the upper half, empty band below the composer, top row cut mid-line" requires either a
height change or a rows change, and this harness proves neither ever happens during a sidebar
collapse — the row count sent and rendered was 53 (xterm) / stable dims (grid) at literally every
sample, in every pass. So the mechanism the user saw is not in the code this brief pointed at, and
I'm not going to hand-wave a layout theory the measurements just ruled out.

The one place this harness's numbers point, and can't go further: the CONFIRMED starvation above
means a real session can go **seconds** with the terminal's `cols` silently stale after a
collapse. If Claude Code's own TUI (which this mock cannot fake — it emits no real escape
sequences) receives that stale-then-sudden width change mid-redraw, a partial-frame paint (old
content in the upper rows, blank rows below where the new width's redraw hasn't reached yet) is
exactly what a full-screen TUI clearing and redrawing at a new size looks like mid-flight. That
would explain the vertical symptom as a **side effect of the confirmed width-starvation bug**,
happening inside Claude Code's own rendering rather than Operator's layout — but that's inference,
not something this harness measured, because it never paints real TUI content. Only the user's live
session can confirm or rule this out, ideally by reproducing while an agent is actively streaming
output (the harness shows that's the necessary condition) vs. idle (where it self-resolves in
~200ms) — if it only ever happens on a *busy* lane, that's strong corroboration.

## Smallest fix I'd propose (NOT applied)

**xterm path**: give the settle call an escape hatch from the quiet-gate instead of routing it
through the general `handleResize`. The `suspendFit → false` effect (`TerminalPane.tsx:630-632`)
already knows it's catching up after an explicit, intentional hold — it doesn't need the same
protection ordinary per-chunk `ResizeObserver` fits need (that gate exists to avoid interrupting a
live redraw mid-frame, not to hold a fit hostage indefinitely). Have that effect call `doFit()`
directly, or bound the retry chain in `handleResize` to a max total defer (e.g. force a fit after
~500ms of continuous rescheduling regardless of `sinceData`). Either keeps the original
overprint-avoidance intact for steady-state resizes while guaranteeing the post-collapse fit can't
be starved forever by output that happens to never go quiet.

**grid path**: no fix indicated by these measurements — behaves correctly and isn't exposed to the
same starvation class by construction.

## What I could not reproduce, and why

- The visual glitch itself (partial top row, empty band) — the mock fakes pty *bytes* for xterm
  and *no* stream at all for grid (`dev/mock-bridge.ts:441-450`'s own comment: a fixture more
  generous than reality would validate a feature that cannot work), so nothing here ever painted
  real Claude Code TUI content to screenshot.
- Whether a *real* debug-build Tauri window's CSS transition genuinely runs slower than the
  declared 260ms (the brief's other candidate for "slow to take the width") — this harness's
  browser (Playwright WebKit against the Vite dev server) is not the same rendering pipeline as
  the packaged/dev Tauri WKWebView; only the user's `npm run tauri dev` session can time that.
