# Switching agents makes every lane's orb animate

**User report, 2026-08-06:** "switching agents is waking up all of them, like showing the orb
working." Selecting one lane in the UI puts the whole roster into the busy/working state visually
— motion on orbs whose agents are idle.

This matters beyond cosmetics: MOTION IS THE BUSY SIGNAL in this app (StatusWave rule — only
`running`/`compacting` animate). If a UI navigation can manufacture `running`, the one signal that
tells the user which agent is actually working is untrustworthy. It may also be feeding other
consumers of `phase` (auto-close/keep-warm in `lane-lifecycle.ts` uses `BUSY = running|compacting`,
`project-status.ts` ranks it, `project-shelf.ts` counts it).

## What I already traced — start here, verify it, don't re-derive it

`src-tauri/src/transcript.rs:992`:

```rust
let pty_active = !t.ended && mgr.active_within(&t.terminal_id, Duration::from_millis(1500));
let phase = if pty_active { "running" } else { t.phase() };
```

**Any byte a pty emits forces `running` for 1.5s**, overriding the transcript-derived phase.
`note_activity` (`lib.rs:235`) is called on every read of pty output, with no notion of *why* the
output happened. A SIGWINCH repaint is indistinguishable from the agent thinking.

And on the renderer side, `TerminalPane.tsx:619` refits when a pane becomes active
(`fitRef.current?.fit()` → `term.onResize` → `window.operator.terminalResize` → SIGWINCH → the TUI
redraws → output → `note_activity` → `running`). A `ResizeObserver` (`:510`) plus a window `resize`
listener call `handleResize` on **every mounted pane** — and every session's terminal stays mounted
by design.

**Leading hypothesis:** switching lanes changes layout (sidebar/rail/project section, panel width)
for *all* mounted panes, so the ResizeObserver fires on all of them, every pty gets a resize, every
TUI repaints, and every session flips to `running` for 1.5s. That is precisely "waking up all of
them."

## Task — DIAGNOSE ONLY. Do not change product code.

1. Confirm or kill the hypothesis **with evidence**, not reasoning. Instrument or log: on a single
   lane switch, how many distinct terminal ids receive a `terminalResize`? How many sessions flip
   to `phase: 'running'`? Does it happen on every switch or only when the switch crosses projects
   / changes the sidebar's width?
2. Identify every path that can make an idle pty emit output on a UI-only action: the
   active-change refit, the ResizeObserver, the `kick1`/`kick2` timers, the background-buffer
   flush and `term.refresh` on activation, scrollback trimming, the grid handshake at `lib.rs:238`.
   Say which ones actually reach the pty (a client-side repaint that writes nothing back does NOT).
3. Recommend a fix and say what it costs. The candidates I can see — evaluate, don't just pick:
   - don't refit a pane that isn't the active one (fit on activation only);
   - suppress `note_activity` for a short window after *we* sent a resize to that terminal
     (backend knows it just wrote a SIGWINCH);
   - make resize idempotent — skip `terminalResize` when cols/rows are unchanged (likely the
     cheapest real fix, and probably where most of the spurious traffic comes from);
   - stop letting pty output alone mean `running` (largest change, most correct, riskiest —
     `pty_active` exists to cover quiet stretches during a long tool call, so it can't just go).
4. Note any second-order damage you find: does a spurious `running` reset the keep-warm timer in
   `lane-lifecycle.ts` and keep lanes alive that should have closed? Does it corrupt the
   `waiting`/`idle` counts on the project cards?

## Output

`/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-switching-wakes-every-lane-RESULT.md`
— that absolute path in the MAIN repo, not only your worktree — and report via `operator__report`.
Lead with the measured numbers from step 1 and a one-line recommended fix; I'll dispatch the
implementation from it.
