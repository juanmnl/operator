# Brief: memory-pressure banner (and suspend under pressure)

## Why
On 2026-10-16 the Mac ran out of memory and rebooted with 19 lane CLIs running. Operator does not read
system memory at all. Idle-lane suspension is merged on main (365142f); this adds the warning and the
action, so the next event is caught before jetsam.
Research: /Users/juanmnl/Developer/operator/dev/results/memory-footprint-research-2026-10-16.md
(Q5 and fix #2). Suspension design: /Users/juanmnl/Developer/operator/dev/results/suspend-idle-lanes-2026-10-16.md
and src/renderer/lib/idle-suspend.ts.

## What to build
1. **Watcher in main.** Poll `sysctl -n kern.memorystatus_vm_pressure_level` (1 normal, 2 warn,
   4 critical) and `kern.memorystatus_level` (percent free) with `execFile` every 15-30 s, or use a
   cheaper source if you find one that is reliable (Electron `process.getSystemMemoryInfo`, a
   dispatch-source equivalent). Send level changes to the renderer over the existing IPC/preload
   pattern. Poll faster (for example 5 s) while the level is above normal. No polling cost worth
   noticing at level 1.
2. **Banner at level 2.** A quiet, dismissible banner in the app chrome (not a toast that fades):
   says memory is low, how many lanes are running, and offers one action, "Suspend idle lanes",
   which suspends every lane that idle-suspend's eligibility rules allow right now, ignoring only the
   idle-minutes threshold. All the other exclusions still apply (focused lane, coordinator, unsent
   input, held deliveries, background tasks, dev server, no conversation yet, and so on). If no lane
   is eligible, say so instead of offering a button that does nothing. Dismissal lasts until the
   level next rises from normal. The banner goes away when the level returns to 1.
3. **Level 4 (critical).** Suspend the eligible lanes automatically, and change the banner to state
   how many were suspended. Respect the Tuning setting: if idle suspension is Off, do not suspend
   automatically; show the banner and the button only. Consider adding a separate Tuning toggle for
   the automatic part if that reads better; your call, explain it.
4. Follow the existing status vocabulary, tokens and styles, and the UI rules in memory: never stack
   opacity on `--fg-muted`, two verbs never share a glyph, no stray word after a full stop in display
   copy (bind with ` `). Plain copy, no drama.

## Done means
- Unit tests: the level parser, the banner state machine (show, dismiss, re-show on a new rise,
  hide at normal), "suspend now" ignoring only the time threshold, and level 4 honouring the Off
  setting.
- Show the banner in an isolated dev build (OPERATOR_DIR in the scratchpad, never ~/.operator,
  port 1431) by faking the level through a dev-only override (env var or localStorage); attach a
  screenshot path.
- `npm test` green in both suites; report the counts. The electron suite has timing-sensitive
  worktree tests that time out under heavy machine load; say so if that is what fails.
- Write `/Users/juanmnl/Developer/operator/dev/results/memory-pressure-banner-2026-10-16.md`:
  files changed, decisions, what is untested, anything you could not do.
- Commit on your lane branch. Don't merge.
