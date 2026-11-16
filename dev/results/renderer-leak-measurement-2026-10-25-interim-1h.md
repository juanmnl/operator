# Renderer leak measurement, 1 h interim (2026-10-25)

Measurement only; no app code changed. Final result will be `dev/results/renderer-leak-measurement-2026-10-25.md` after the 12 h snapshot.

## Setup actually running

- Build: `ac4591a` (main), `npm run build`, plus `vite build --sourcemap` for source mapping. Built in a detached worktree under my scratchpad, not in the shared `electron/out`.
- Launched unpackaged (`Electron . --user-data-dir=<scratch>`), loading `out/renderer` (production React, minified). `OPERATOR_DIR` and Chromium user-data-dir are both in the scratchpad. CDP on 9343.
- Workload:
  - 5 lanes whose `claude` command is a shim that prints `date; ls -la /usr/bin | head -40` every 3 s, plus 1 lane printing 700-char ANSI-coloured lines every 2 s and a 6,000-char line every 20th line. The shim is selected by `ZDOTDIR` and only for the scratch project; elsewhere it execs the real `claude`.
  - 2 real Claude Code lanes (Sonnet), one prompt each ("Reply with the single word: ok"), then idle.
  - Active lane switched every 20 min through the sidebar (CDP click).
- Sampling every 15 min: `Runtime.getHeapUsage` (precise; `performance.memory` is bucketed to 10,000,000 in this build), `Performance.getMetrics` (nodes, listeners), RSS of every Electron process, `footprint` of the renderer. Heap snapshots (after a forced GC) at 1 h, 6 h, 12 h.

## Two restarts of the clock

1. Phase 1 (19:06:59 to 20:07 local): scratch store was tiny (3 projects). 1 h snapshot taken.
2. At 20:09:25 I injected a synthetic store with the same shape and size as the real one into the scratch `projects.json` (21 projects, 2,550 tasks, 833 dispatches, 5.3 MB; filler text, non-existent paths), reloaded the renderer, and restarted the 1/6/12 h clock. Reason: the brief asks whether the big saved-sessions/projects JSON strings show up, and a 300-byte store cannot answer that. Lanes live in main and re-attached; the renderer is fresh. The final numbers come from phase 2 (about 12 h from 20:09:25). Phase 1 is kept as a small-store control.

## Phase 1 results (1 h, small store)

| min | JS heap used MB (pre-GC) | DOM nodes | RSS MB: main / renderer / gpu / network | lanes alive |
|---|---|---|---|---|
| 0 | 9.7 | 1307 | 190 / 210 / 180 / 105 | 8 |
| 15 | 21.4 | 1226 | 119 / 163 / 136 / 85 | 8 |
| 30 | 15.4 | 1232 | 105 / 147 / 55 / 24 | 6 |
| 45 | 24.1 | 1189 | 169 / 180 / 58 / 25 | 6 |
| 60 | 13.8 | 1155 | 184 / 411* / 59 / 25 | 6 |

\* sampled seconds after the heap snapshot; renderer RSS was 170 MB two minutes later. The sampler now waits 5 min after a snapshot and flags such rows.

- Renderer RSS and JS heap: no growth trend in the first hour. The raw heap is a GC sawtooth (10 to 24 MB), so use the post-GC snapshot totals instead: 24.9 MB at 1 min, 26.6 MB at 3 min, 39.5 MB at 60 min (all reachable objects, including external buffers).
- The +13 MB between 3 min and 60 min is almost all xterm scrollback filling: 6,593 more `BufferLine` objects (`wS`) each holding a 1,224-byte `Uint32Array`, retained through `Buffer.lines` (`f0`) > `CircularList._array` (`u0`) > `wS`. That is the capped scrollback (2,000 lines inactive, 10,000 active), so it should plateau; the 6 h and 12 h snapshots will show whether it does.
- 2.5 MB is per-terminal `InputHandler._parseBuffer` (`i3`/`g3`), also expected.
- No Context/closure class grew by more than 85 KB.
- Idle suspension: both real Claude lanes were suspended by the 30 min idle timer (lanes alive 8 to 6 at 30 min; sidebar shows SUSPENDED). The default `operator.lane.idleSuspendMinutes` is 30 (`src/renderer/lib/tuning.ts:302`). Real lanes in this run therefore do not stay alive; the renderer still holds their tabs.

## Observations not about the leak

- Launching a lane from the Team tab registers a second project named after the folder (`proj-fake`, `proj-scratch`) instead of using the existing project. Seen three times. Not investigated.
- A fresh `OPERATOR_DIR` gets the dev mock-bridge session rows (`s-op`, `s-enc`, `/Users/dev/...`) written to `sessions.json`. Not investigated.
- My first launch used the default Chromium profile (`~/Library/Application Support/Operator`) while the installed Operator.app was running. The LevelDB lock should have kept my process from writing localStorage; `011539.log` had no write after launch. I killed it within a minute and relaunched with a scratch profile.
- Claude asked to trust the scratch folder on first launch; I accepted it (writes one trust entry into `~/.claude.json` for the scratch path).
- `caffeinate -i` is running, tied to the app's pid, so idle sleep does not interrupt sampling.

## Not yet known

Whether anything keeps growing after the scrollback caps fill, and whether the large JSON strings are retained. Answered at 6 h and 12 h.

Files: samples `/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/samples/`, snapshots `.../scratchpad/snapshots/`, phase 1 copies `.../scratchpad/phase1/`.
