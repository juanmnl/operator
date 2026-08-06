# Fix: a lane switch makes every lane's orb animate

Implementation brief. The diagnosis is **done** — read
`dev/briefs/2026-08-06-switching-wakes-every-lane-RESULT.md` (Research lane) in full before you
touch anything. Do not re-derive it; do not re-open the candidate comparison. What follows is the
decision that came out of it.

## The mechanism, in one paragraph

Every terminal pane, across every project, is a sibling in one **unfiltered** `terminals.map(...)`
(`DashboardView.tsx:4162`), each `position: absolute; inset: 0` with `visibility: hidden|visible` —
and `visibility: hidden` still has a real, measurable box, so a hidden pane's `ResizeObserver`
fires exactly like the visible one. The Plan/Diff side panel is **per-session** state
(`sessionLayouts[activeSessionId].panelOpen`) rendered as a **flex sibling** of the terminal
container, not an overlay. So switching from a lane with the panel open to one with it closed
mounts/unmounts that div, the `flex: 1` container genuinely changes width, and **every** mounted
pane gets a real resize → `fitAddon.fit()` → `terminalResize` → `TIOCSWINSZ` → SIGWINCH → each
Claude Code TUI redraws → bytes come back → `note_activity` (`lib.rs:235`) →
`transcript.rs:992` forces `phase = "running"` for 1.5s. On every open lane, in every project.

Falsifiable trigger: *every mounted, non-ended terminal flips to `running` for ~1.5s whenever the
incoming session's `panelOpen` differs from the outgoing session's.* Not every switch; not
project-crossing; **not** the rail and **not** the Console/Chat/Preview toggle (that one is an
overlay by deliberate design and was ruled out by reading the comment that says so).

## The fix — do this one

Guard `handleResize` in `TerminalPane.tsx` (~line 109) so an **inactive** pane's
`ResizeObserver` / window-resize callbacks never reach the backend:

```ts
if (!activeRef.current) return
```

This is not a novel design call. `GridTerminalPane.tsx:263-269` — the app's other terminal
implementation — already ships exactly this guard (`if (activeRef.current) window.operator
.gridtermResize?.(...)`), and `TerminalPane.tsx` itself already uses the same `activeRef.current`
pattern three times for a different concern (lines ~337/392/412). You are applying a pattern this
codebase already committed to.

The other three candidates were evaluated and rejected — the Rust-side resize dedupe doesn't help
(the width change is *real*, so nothing is deduplicable), suppressing `note_activity` after a
resize treats the symptom while still SIGWINCHing every background TUI, and touching
`pty_active → running` is the big risky one that becomes unnecessary once the traffic stops.

## What you must verify, because Research could not

Its lane is read-only, so the trigger condition is a *derived* claim, not a captured trace. Get the
receipt — it is five minutes:

1. Instrument `terminalResize` (a temporary `console.log` of the terminal id is fine) and count how
   many distinct ids fire on **one** lane switch, before the fix. Confirm it equals the open
   terminal count across all projects, and that it only happens when `panelOpen` differs.
2. Same count after the fix: it must be **1** (the pane becoming active), or 0 if its size is
   unchanged.
3. Remove the instrumentation before you commit.

## Don't regress these

- **A pane that mounts while inactive must still get a correct initial size.** `ensureInitialFit`
  (`TerminalPane.tsx:261-274`) is a separate path that fits and calls `terminalResize` directly —
  confirm the guard doesn't sit in front of it, or a lane launched without focus (`opts.focus:
  false`, which is how a dispatch launches a lane) starts at the wrong width and bakes bad wrapping
  into its scrollback. That failure mode has shipped here before.
- **The activation path must still fit.** `TerminalPane.tsx:646` (`fitRef.current?.fit()` when
  `active` flips true) is what lets a background pane catch up; it must keep working, and it is the
  reason a background pane holding a stale size is acceptable.
- **`suspendFit`** (~line 615) calls `handleResize` when it flips false — check that an inactive
  pane skipping that fit is harmless.
- A real OS window resize on the *active* pane must still work.

## Known, accepted, do not fix here

A spurious `running` blip does **not** re-arm the keep-warm timer: `lastActivityAt` is set only
from a transcript line's own timestamp (`transcript.rs:253`), never from `note_activity` — two
separate clocks. It *can* make a close-eligible lane transiently ineligible for 1.5s via
`laneCloseDecision`'s `if (BUSY.has(lane.phase))` early return (`lane-lifecycle.ts:93`). Low odds,
non-zero, and it disappears with this fix. Note it, don't chase it.

## Done means

`npm test` + `npx tsc --noEmit` + `npm run build` green, a test covering "inactive pane's resize
callback does not reach the backend", **committed on your branch** (verify with `git log` that the
commit exists), and the before/after counts from the verification step in your result.

## Output

`/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-orb-wake-up-fix-RESULT.md`
— that absolute path in the MAIN repo, not only your worktree — plus `operator__report`. Lead with
the measured before/after resize counts.
