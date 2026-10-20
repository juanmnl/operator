# Handoff — 2026-10-20

`main` = `2559b99` (pushed), tagged `electron-v0.28.4`. Release run 39475736467 succeeded on the first attempt; v0.28.4 is published on `juanmnl/operator-releases` (not a draft, six assets), and both update feeds (`latest-mac.yml`, `latest.json` with a signature) serve 0.28.4. Not GUI-verified; the auto-update to 0.28.4 on Juan's machine has not been checked yet.

## What shipped in 0.28.4 (release notes: `electron/release-notes/0.28.4.md`)

- **Idle-lane suspension** (merged 2026-10-16 @ 365142f, six review rounds, QA in the app). Result:
  `dev/results/suspend-idle-lanes-2026-10-16.md`.
- **Memory-pressure banner** (branch `operator/897500` @ 58a882b, merged @ 19a1b7a). Main polls
  `kern.memorystatus_vm_pressure_level`; at warn the banner offers "Suspend N idle lanes", at critical
  idle lanes are suspended every 30 s unless idle suspension is Off. Review rounds 1-3 and QA with lanes
  running (on c8d50f5) are clean. Results: `dev/results/memory-pressure-banner-2026-10-16.md`,
  `-review-2026-10-20.md`, `-review-r2-2026-10-20.md`, `-qa-2026-10-20.md`.
- **Crash recovery fixed** (branch `fix/render-frame-disposed` @ 8f98791, merged @ 887016e). After a
  renderer death, `rendererLeaving()` → `previewApi.close()` → `previewFrame()` read `mainFrame` of the
  dead renderer and threw "Render frame was disposed before WebFrameMain could be accessed". That
  skipped the crash log, the reload and left dispatches held. Now each step is isolated and the hook is
  wrapped. Review clean: `dev/results/render-frame-disposed-review-2026-10-20.md`.
- Window title is "Operator" (2cc08b4).

Tests on `main` @ 19a1b7a: root 1942 passed; electron typecheck clean, 998 passed.

## Verification state

- **Not verified against a real renderer crash.** To check: in a dev build, crash the renderer
  (`kill -TRAP` on the renderer helper) and confirm the window reloads, `~/.operator/logs/renderer-gone.log`
  gets a line, and a dispatch sent during the gap arrives afterwards.
- The banner is verified in a dev build with a faked level only, not with a real kernel pressure rise or
  a packaged build.

## Open

1. **Renderer memory leak.** Both renderer crashes (10-13, 10-19) are V8 heap OOM after 3.0-4.4 days;
   the renderer grows about 30-35 MB/h. Cause unknown. Findings: `dev/results/renderer-sigtrap-2026-10-20.md`.
   Next step proposed, not started (needs Juan's OK, it means running a dev build 12 h+): log
   `process.getProcessMemoryInfo()` and `performance.memory` hourly, and take heap snapshots at 1 h and
   12 h through the CDP port, then compare retained sizes by constructor. Only after that choose between
   a code fix and a planned reload. Also cheap: stop stringifying the whole saved-sessions and projects
   lists twice on every terminal/session change (DashboardView.tsx ~:4876-4899).
2. **Banner polish (QA observations, not defects):** the button's eligible count can lag up to 30 s;
   "Suspended N" is cumulative per episode and can sit next to fresh state; the Off message is hidden once
   a lane was suspended in the episode. Not dispatched.
3. **Review test notes on the crash fix (not blocking):** the preview-inspect test throws from the
   `mainFrame` getter while Electron throws from `.frames`; the per-step isolation in `index.ts` has no
   unit test.
4. **Code lane was stuck** "finishing its turn" for over an hour on 2026-10-20; Operator refused
   dispatches to it twice. The crash fix was done by a subagent in `.claude/worktrees/agent-a491a1b7d0cba4a06`
   instead (node_modules symlinked there; can be removed).
5. Idle-suspend follow-ups still open: run mcp-serve as node, staggered crash auto-resume, tailer
   `findTranscript` ignores `CLAUDE_CONFIG_DIR`, lanes that never had a turn are dropped on relaunch.
