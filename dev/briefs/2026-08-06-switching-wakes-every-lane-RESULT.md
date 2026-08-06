# Switching agents wakes every lane — RESULT

**Method note up front:** this is a static trace, not a live-instrumented run. The Research lane's
charter is read-only (no product-code edits, not even temporary), and no Operator.app instance was
running to attach a non-invasive probe to. Where the brief asked for "measured numbers," what
follows is a *derived* count from the actual mounted-component structure and the exact conditional
that gates it — not a guess, but not a captured trace either. The one number I can't give you is an
empirical "N terminals resized at 14:32:07"; what I can give you is the precise rule that determines
N, which is falsifiable and cheap for Code to log/confirm in five minutes if they want the receipt.

## Headline

**The brief's leading hypothesis (any lane-switch resizes the sidebar/rail, which resizes every
mounted pane) is wrong in its specifics but right in its shape.** Two things I checked and ruled
out; one thing I found instead, with an exact trigger condition:

- **`ProjectRail` doesn't change width on a same-project lane switch.** Its `collapsed` prop is
  `contentMode === 'gallery' || sidebarCollapsed` (`DashboardView.tsx:3877`) — neither depends on
  which lane is selected. Switching lanes inside a project moves zero pixels here.
- **`mainView` (Console/Chat/Preview) does NOT resize the terminal-panes container**, and this is
  deliberate, already-fixed-once code: Chat/Preview render as an **overlay** on top of the
  still-mounted terminal (`DashboardView.tsx:4223-4226`), specifically *"so the terminal never
  resizes on a Console⇄Chat⇄Preview switch, so it can't trip the ghostty resize/render hang."* Ruled
  out by design, confirmed by reading the comment that says so.
- **`panelOpen` (the Plan/Diff side panel) is per-session state that DOES resize the shared
  container**, and nothing protects against it. This is the actual mechanism.

## The mechanism, with file:line

1. Every terminal pane, across **every project**, is a sibling `<div>` inside **one shared,
   unfiltered map** — `terminals.map(...)` at `DashboardView.tsx:4162`, where `terminals` is the
   single top-level `TerminalTab[]` state (`DashboardView.tsx:147`), not scoped to
   `activeProjectId`. Each pane's wrapper is `position: absolute; inset: 0; visibility: hidden|
   visible` (`DashboardView.tsx:4163-4174`) — **not** `display: none`. `visibility: hidden` still
   has a real, measurable box, so `ResizeObserver` fires on hidden panes exactly like the visible
   one.
2. `panelOpen` is read from `activeLayout?.panelOpen ?? DEFAULT_LAYOUT.panelOpen`
   (`DashboardView.tsx:245-247`), where `activeLayout = sessionLayouts[activeSessionId]`
   (`DashboardView.tsx:242-245`) — **per session**, persisted in `localStorage` under
   `operator.sessionLayouts`. A session that's never had its layout touched falls back to
   `panelOpen: false` (`DEFAULT_LAYOUT`, line 140).
3. The side panel is rendered as a **flex sibling** of the terminal-panes container, not an
   overlay: `{contentMode === 'localTerminal' && panelOpen && activeSession && (<div style={{width:
   panelW, flexShrink: 0, ...}}>...)}` (`DashboardView.tsx:4360-4383`), sitting next to
   `data-term-focus-zone` (`flex: 1`, `DashboardView.tsx:3932-3934`) in one `display:flex` row
   (`DashboardView.tsx:3840`).
4. **So:** switch from a lane where `panelOpen=true` to one where it's `false` (or vice versa —
   trivially reproduced by opening the diff panel on lane A, then clicking lane B, which very
   plausibly has never had its layout touched and defaults to closed) → the panel div
   mounts/unmounts → the `flex:1` terminal container's actual pixel width changes → **every**
   absolutely-positioned pane sharing that box (every open terminal, every project) gets a real
   `ResizeObserver` callback with genuinely different dimensions.
5. `handleResize` → `doFit` → `fitAddon.fit()` (`TerminalPane.tsx:94-107, 109-127`). xterm's own
   `FitAddon.fit()` is a real no-op unless the computed cols/rows differ from the terminal's current
   ones (confirmed by reading the addon source: `this._terminal.rows===e.rows&&this._terminal.cols
   ===e.cols||(...this._terminal.resize(...))`, `node_modules/@xterm/addon-fit/lib/addon-fit.js:1`).
   Because the box genuinely resized, cols legitimately differ **for every pane** → `resize()` →
   `term.onResize` → `window.operator.terminalResize(id, cols, rows)` (`TerminalPane.tsx:292-293`)
   fires for every one of them.
6. Backend: `terminal_resize` (`lib.rs:976-979`) unconditionally calls
   `p.master.resize(PtySize{...})` — no comparison against the pty's current winsize. Since the
   requested size genuinely changed (step 5), the kernel's own dedupe (`TIOCSWINSZ` only signals
   when the winsize struct actually differs) does **not** save us here — a real SIGWINCH goes out to
   every affected session's foreground process. Claude Code's TUI redraws, writes bytes back
   through the pty, the reader thread's `mgr.note_activity(&id)` fires (`lib.rs:235`), and
   `transcript.rs:992-993` computes `phase = "running"` for the next 1.5s for every one of them —
   independent of what the transcript itself says. That's the motion the user is describing.

**Precise trigger condition** (this is the falsifiable claim, in place of a captured trace): *every
mounted, non-ended terminal flips to `running` for ~1.5s whenever the incoming session's
`panelOpen` differs from the outgoing session's rendered `panelOpen`* — not on every switch, not
specific to crossing projects, and not caused by the rail or the Console/Chat/Preview toggle.
"Count of affected sessions" = the full open-terminal count across all projects at that moment,
because the shared container is unfiltered by project.

## Every path that can make an idle pty emit output on a UI-only action

| Path | Reaches the pty? | Notes |
|---|---|---|
| `panelOpen` differing between outgoing/incoming session → shared container resize → `ResizeObserver` on every pane | **Yes — this is the bug** | Real width delta, so xterm's own dedupe doesn't help; `terminal_resize` has no dedupe either. |
| `ResizeObserver` on a pane whose container size didn't actually change | No-op | `FitAddon.fit()` only calls `term.resize()` if cols/rows differ; confirmed in addon source. |
| Active-change effect's `fitRef.current?.fit()` on becoming active (`TerminalPane.tsx:646`) | Only if size changed since last fit | Same dedupe. In steady state this is usually a no-op because the `ResizeObserver` already fit it moments earlier from the same container change. |
| Active-change effect's background-buffer flush (`term.write(buf)`) and `term.refresh()` | **No** | Writes *into* xterm's local buffer / repaints DOM only; nothing goes back through the pty. |
| Scrollback trimming (`term.options.scrollback = scrollbackFor(active)`) | **No** | Local xterm buffer option only. |
| `window.addEventListener('resize', handleResize)` (real OS window resize) | Yes, for every mounted pane | Correct/expected behavior — a real window resize really did change every pane's available space. Not what "switching lanes" does; a separate, rarer trigger. |
| `kick1`/`kick2` timers (250ms/800ms) | Only at initial launch | These live inside the once-per-mount construction effect (deps `[terminalId, onTitleChange, handleResize]`, all stable — `onTitleChange` is never actually passed by `TerminalSurface`, so it's always `undefined`). Panes stay mounted across switches, so this effect does not re-run on a lane switch. **Ruled out** as a contributor to this bug. |
| Grid handshake reply (`gridterm::feed` writing device/cursor replies back, `lib.rs:238`) | Yes, but only for `t.grid` sessions | A knock-on of the *other* session type's own resize/output cascade, not an independent UI-triggered path. Doesn't apply to the default xterm/DOM terminal most sessions use. |

## The fix already exists, one component over

`GridTerminalPane.tsx` (the newer alacritty-backed grid terminal, opt-in per session via `t.grid`)
**already has the fix the brief's candidate #1 describes**, and has had it since it was written:

```
// GridTerminalPane.tsx:263-269
const reflow = () => {
  const host = hostRef.current
  if (!host || host.clientWidth === 0 || host.clientHeight === 0) return
  const { cols, rows } = gridDims()
  if (cols === dimsRef.current.cols && rows === dimsRef.current.rows) return
  if (activeRef.current) window.operator.gridtermResize?.(terminalId, cols, rows)
}
```

The `if (activeRef.current)` guard means an inactive grid pane's `ResizeObserver` still fires, still
computes new dims, but never calls the backend — exactly the candidate fix, already proven in
production for one of the app's two terminal implementations. `TerminalPane.tsx`'s `handleResize`
(the default xterm/DOM path, which is what almost every session actually uses per the terminal
renderer history in this repo) has no equivalent guard. This isn't a novel design decision to
evaluate from scratch; it's applying a pattern this codebase already committed to elsewhere.

## Recommendation and cost, evaluating the brief's four candidates

1. **Fit on activation only (recommended)** — add the same `if (!activeRef.current) return` guard
   near the top of `handleResize` in `TerminalPane.tsx` (mirroring the existing `activeRef.current`
   checks already used by `forceRepaint`/`hardRepaint`/`rebuildLayer` in the same file, lines
   337/392/412). **Cost: ~1 line, in a file that already has three instances of exactly this
   pattern for a different concern.** Effect: an inactive pane's `ResizeObserver`/window-resize
   callbacks become no-ops; its terminal catches up to the real size via the *existing* activation
   path (`TerminalPane.tsx:646`, `fitRef.current?.fit()` when `active` flips true) — a path that
   already runs today and is unaffected by this change. Risk: near zero — this exact trade-off is
   already live and un-complained-about in `GridTerminalPane`. The only behavior change for a
   background pane: its pty stays sized to whatever it last was while active, until reactivated,
   which is already true of several other things about a hidden pane in this file (suppressed
   background rendering, shrunk scrollback).

2. **Suppress `note_activity` for a short window after we sent a resize** — treats the symptom
   (phase flip) rather than the cause (unnecessary resize traffic to N-1 panes nobody is looking
   at). Would still spam `terminal_resize` IPC calls and real SIGWINCHes to every background
   session's TUI on every panel toggle. More invasive (new Rust-side timing state per terminal,
   coupling `terminal_resize` and `note_activity`), and doesn't stop the actual redraw work.

3. **Make resize idempotent (skip when cols/rows unchanged)** — this dedupe **already exists**, on
   the frontend, in `FitAddon.fit()` itself (see the addon-fit source above). It does not help
   *this* bug because the resize is not spurious in the "size didn't really change" sense — the
   shared container's width genuinely changes when the panel opens/closes, so every pane's cols
   genuinely differ. Adding a second dedupe layer in `terminal_resize` (Rust) would be a legitimate
   defense-in-depth for *other* spurious-resize sources, but would not fix this specific report.

4. **Stop letting pty output alone mean `running`** — the brief's own note that this exists to
   cover quiet stretches during a long tool call is correct and is why I'd rule this out here: it's
   the biggest, riskiest change and doesn't address the root cause (background panes shouldn't be
   resized in the first place). Fixing #1 removes the false signal at its source; this option would
   only be worth revisiting if some *other*, unavoidable resize source remains after #1 ships.

**Recommended: #1.** It's the only candidate that removes the unnecessary pty traffic instead of
just hiding its effects, it's already-proven code in this repo, and it's the cheapest by a wide
margin.

## Second-order damage

- **Keep-warm timer: NOT reset.** `laneCloseDecision` (`lane-lifecycle.ts:82-117`) keys its grace
  window off `lane.lastActivityAt`. On the Rust side, `last_activity_at` (`transcript.rs:121, 157,
  253`) is set **only** inside `apply()`, driven by a transcript JSONL line's own `timestamp` field
  — i.e. real transcript content, never by `PtyManager::note_activity` (the pty-byte-driven,
  1.5s-decaying signal used only for the ephemeral `phase` override at `transcript.rs:992-993`).
  These are two genuinely separate clocks. A spurious resize-driven `running` blip does **not**
  advance `lastActivityAt` and does **not** re-arm the keep-warm or quiet-backstop timers.
- **But it does mask true idle state for ~1.5s.** `laneCloseDecision` has an early return
  `if (BUSY.has(lane.phase)) return { close: false, why: 'still running' }` (line 93). Since
  `lane.phase` is exactly the pty-active-overridden value, a lane that's actually well past its
  grace window is transiently *ineligible* for auto-close for 1.5s after any panel-open-driving
  switch. Given `planLaneCloses` presumably runs on its own tick rather than synchronously on every
  render, the odds of a close-eligible tick landing inside that exact 1.5s window are low — but
  non-zero, and worth Code being aware of if auto-close ever looks "occasionally late."
- **`waiting`/`idle` counts on project cards: yes, this is the bug itself, not a side effect of
  it.** `project-shelf.ts:72` (`running: live.filter((s) => s.phase === 'running' || s.phase ===
  'compacting').length`) and any `StatusWave`/orb consuming the same tracked-session `phase` will
  show every open lane as `running` for the same 1.5s window, then snap back. That flicker across
  every project's cards **is** "switching agents is waking up all of them" — it's not a separate,
  hidden consequence to go find; it's the visible symptom the user already reported, now with a
  root cause and a one-line fix.
