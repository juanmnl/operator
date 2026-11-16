# Renderer leak fix, 2 h re-run on operator/95280 @ 0ac83f5 (2026-10-26)

Measurement only; no app code changed. Same method as `renderer-leak-live-lanes-2026-10-26.md` (which measured 4f330e0, without the fix).

## Answer

**PASS on the stated criterion.** The chain does not grow on 0ac83f5 under the same live-lane workload plus project traffic.

| | 4f330e0 (no fix), +10 min / +1 h / +2 h | 0ac83f5 (fix), +10 min / +1 h / +2 h |
|---|---|---|
| DashboardView render Contexts holding the four chain slots | 54 / 63 / 77 | 14 / 14 / 14 |
| Bytes dominated by those Contexts | 0.746 / 0.841 / 1.096 MB | 0.067 / 0.074 / 0.079 MB |
| AgentSession objects in the heap | 354 / 466 / 626 | 112 / 128 / 112 |

- Link count at +2 h equals the +10 min value; the AgentSession count returns to the +10 min value (112). The bytes dominated by the chain contexts rose 12 KB over 110 min (see "Residual" below), against +350 KB in the unfixed build.
- I did not run 4f330e0 with the new project-traffic step, so I cannot say from my data whether the first commit alone (61ad42d) would already have passed; Code's statement about that is untested by me.
- I found no callback that still roots a growing chain, so there was nothing to trace.

## Setup

- Build: scratch detached worktree at `0ac83f5`, `npm run build` plus `vite build --sourcemap` (bundle `out/renderer/assets/main-wFxhiNeg.js`). Production renderer, unpackaged `Electron .`, CDP 9343. Fresh `OPERATOR_DIR` (`projects.json` copied from my earlier scratch store: 17 filler projects, 5.3 MB, and the four scratch-project entries with their rosters) and a fresh Chromium profile. `~/.operator` and the default profile were not touched.
- Lanes (8): 6 shim lanes in `proj-fake` (5 looping `date; ls -la /usr/bin | head -40` every 3 s, 1 printing 700-char ANSI lines and a 6,000-char line every 20th; Operator, Research, Code, Review, Design, QA roles) and 2 real Claude Code lanes in `proj-scratch` (Research and QA roles, Claude Code 2.1.310, Sonnet 5.5). Launched with the row-level "Launch →" with "dev server" unticked and no brief, as in the earlier runs. `operator.lane.idleSuspendMinutes` = 0; all 8 lanes alive in every sample.
- Prompt: "Reply with the single word: ok" to each real lane every 5 min for the whole run (24 rounds, 48 prompts). The prompt did not change at +1 h this time.
- Driver (`driver.mjs`, alternating every 2.5 min, so each action every 5 min):
  - lane switch: click the next sidebar lane row (22 switches);
  - project traffic: back to the project page, BOARD tab, type a task ("traffic probe N", no assignee, no Send) and press Add (17 successful adds by the driver plus 2 by hand; 19 tasks present in `projects.json` at the end, 14 in `proj-fake`, 5 in `proj-scratch`). Each add runs `addProjectTask`, which changes `projects`.
  - Not done: a real dispatch (needs an MCP call from a lane) and Send. Assigning and status changes on cards were not used (the card's "Assign…" control is not a native select; I did not drive it).
- Sampling every 10 min (post-GC heap, RSS, DOM nodes); heap snapshots after forced GC at +10 min, +1 h, +2 h (`fix-10m`, `fix-1h`, `fix-2h`; t0 = 15:53:01Z). Slot names for this build, from `srcnames.mjs` through the source map: `setPanelOpen`=`on`, `togglePanel`=`go`, `focusTerminal`=`Nc`, `openLaneTerminal`=`qm`, `allSidebarSessions`=`He`, `savedSerRef`=`fu`, `projectsSerRef`=`pu`. Count = Contexts holding `on`, `Nc`, `He` and `pu` (`chaintotal.mjs`, `linkstats.mjs`). `projectsSerRef` still exists in the fix, holding a fingerprint instead of the 9.9 MB string.

## Measurements

| Snapshot | Chain Contexts | Top-level groups | Dominated MB | Largest group | AgentSession objects | Reachable MB (all) |
|---|---|---|---|---|---|---|
| +10 min | 14 | 12 | 0.067 | 12 KB | 112 | 51.2 |
| +1 h | 14 | 12 | 0.074 | 17 KB | 128 | 52.5 |
| +2 h | 14 | 12 | 0.079 | 23 KB | 112 | 43.8 |

- Context slot `He` alone (every DashboardView render Context that holds the sidebar sessions): 15 / 15 / 15. One of them is a 508-540 KB group present from +10 min (the live render), unchanged in structure.
- Real-lane `AgentSession` copies: 20 at +1 h and 16 at +2 h (mean `messages` 15.6 and 25.0). In the unfixed build the same count was 58 and 98. Shim-lane copies: 108 at +1 h, 96 at +2 h (the unfixed build: 408 and 528).
- The +10 min snapshot was taken before the first project-traffic add (the first driver tick failed on a button-text match; I fixed the driver and the first successful add was at 16:03:20Z, 10 min in). The +10 min baseline therefore has no project traffic before it. At +1 h about 6 adds had run (a second bug, a missing composer after the first task, was fixed at 16:34Z, and the cadence moved to every 5 min), at +2 h 19. The chain stayed at 14 in all three snapshots.
- Sampler (12 samples): post-GC JS heap 14.3 MB at start, 18-19 MB from 20 min on; slope from 30 min -0.61 ± 0.45 MB/h (from 0: +0.89 ± 0.69 MB/h). Renderer RSS 171-221 MB, no trend (+6 ± 14 MB/h from 30 min). DOM nodes 1,235-1,443, no trend. All 8 lanes alive throughout.
- Post-GC JS heap is about 11 MB lower than the 4f330e0 run (about 29 MB in the same phase). That is consistent with the fingerprint replacing the saved-sessions and projects text; I did not run a controlled test to attribute it.

### Residual

- The dominated bytes rose from 0.067 to 0.079 MB (+12 KB). One group grew from 12 to 17 to 23 KB; the other 11 groups stay at 4-12 KB. At +2 h three of the eight non-empty real-lane message arrays are dominated by chain Contexts (15 KB), the other five are held elsewhere. The 14 Contexts hold the current sessions, whose `messages` arrays grow until the 80-message cap (inferred, not proven by a retainer trace). A longer run (6 h or more) would confirm that this growth stops at the cap; I ran 2 h.
- I did not identify what holds the 14 contexts (the live fiber, its alternate and callbacks stored in refs would account for a few). They do not grow, which is the criterion asked for.

## Pass/fail rundown

| Item | Result | How exercised |
|---|---|---|
| Chain link count at +2 h close to +10 min | PASS: 14 / 14 / 14 | App driven (8 lanes, 22 lane switches, 19 board tasks, 48 prompts); heap snapshots |
| Dominated MB at +2 h close to +10 min | PASS with a small drift: 0.067 → 0.079 MB (+12 KB, one group); unfixed build +350 KB | Heap analysis |
| AgentSession objects bounded | PASS: 112 / 128 / 112 | Heap analysis |
| Real-lane session versions no longer accumulate | PASS: 20 → 16 copies (unfixed 58 → 98) | Heap analysis (`sessdetail.mjs`) |
| Project traffic changes `projects` | PASS: 19 tasks persisted in `projects.json` | App driven; file read |
| 8 lanes alive for 2 h with idle suspension off | PASS | Sampler rows |
| JS heap / RSS trend | NOT RESOLVED beyond noise: heap -0.61 ± 0.45 MB/h, RSS no trend | Sampler series (12 samples) |
| Real dispatch traffic through the app | NOT TESTED: board add only | — |
| Task status change / assign through the app | NOT TESTED | — |
| First-commit-only (61ad42d) would pass the old workload | NOT TESTED | — |
| Tool calls / `activity` entries | NOT TESTED: prompts use no tools | — |
| 17 lanes | NOT TESTED: 8 lanes (2 real) | — |

## Caveats

- 8 lanes, 2 real; shim lanes have no hook events. The earlier 12 prompts/h per lane rate was kept; busy field lanes emit far more session events.
- Real lanes were prompted with one word only; the earlier run's 120-word phase (larger items) was not repeated. The fix's effect shows as the absence of growth, so item size matters less here than in the unfixed run, but I did not test a long conversation near the 80-message cap.
- Project traffic: board task adds only, 19 in 2 h (about 10/h; the traffic count at +1 h was about 6). Dispatch traffic, task status changes and assignment were not driven. `roleOf` and `accentOf` depend on `projects`, so the adds exercise the path the second commit addresses, but a dispatch would also change `projects.dispatches`.
- The driver changed twice during the run (button match at +10 min; composer detection and 5 min cadence at +43 min). The first traffic event was therefore at +10 min and the traffic rate during the first hour is lower than in the second.
- A single run, one snapshot per time point; the counts are exact counts of Contexts in the snapshot, but there is no repeat.
- Source-map slot names are specific to build `wFxhiNeg`.
- The 14 chain Contexts are not explained (see "Residual").

## Recommendations (the coordinator decides; I do not dispatch)

1. **Coordinator / Code:** the fix meets the criterion in my run. I would merge on this evidence plus Review. Not GUI-verified beyond the driven lanes, switches and board adds listed above.
2. **QA (me), optional:** a 6 h run on the fix with a long conversation per real lane (so `messages` reaches 80) and real dispatch/status traffic would close the residual drift and the untested traffic types; I would also run 4f330e0 with the same traffic as the control.
3. **Code:** the unrelated finding from the earlier run still stands: a real heap snapshot of a long-running field renderer is the only direct check that this chain explains the field's 30-35 MB/h; the fix should be checked against it after release.

## Files

- Tools and data: `dev/results/renderer-leak-fix-qa-2026-10-26-tools/` (`driver.mjs`, `sampler-fix.mjs`, `prompter-fix.mjs`, `launch3.sh`, `fix-samples.jsonl`, logs). The analysis scripts (`chaintotal.mjs`, `linkstats.mjs`, `sessdom.mjs`, `sessdetail.mjs`, `srcnames.mjs`, `heap.mjs`) are in `dev/results/renderer-leak-live-lanes-2026-10-26-tools/`.
- Heap snapshots (34-40 MB each) remain in the scratchpad: `/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/snapshots/fix-{10m,1h,2h}.heapsnapshot`.
- Leftovers outside the repo: the `~/.claude.json` trust entry for the scratch project (existing), the detached scratch worktree `scratchpad/wt` now at `0ac83f5` (`git worktree remove --force` removes it). Everything I started (app, sampler, prompter, driver) is stopped; no stray processes.
