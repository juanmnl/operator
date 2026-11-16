# Renderer leak measurement, 12 h run (2026-10-25 to 2026-10-26)

Measurement only. No app code was changed. Build measured: `ac4591a` (main at the time), production renderer (`out/renderer`, minified React), unpackaged Electron 43.4.1, run from a detached worktree.

## Result

- The 30 to 35 MB/h growth seen with 17 real lanes did **not** reproduce. With 6 live lanes, 2 suspended Claude Code lanes, and a 5.3 MB synthetic project store, every process stayed flat over 11.75 h (705 min after the clock restart).
- There is one monotonic growth in the JS heap, and its cause is identified from the snapshots: **one retained React render context per recreation of two `useCallback`s in `DashboardView`, chained together** (details in "Suspect 1"). It grew from 17 to 47 to 85 retained contexts at 1 h, 6 h and 12 h, about 6 per hour, and the JS heap after GC rose 0.056 MB/h (standard error 0.021). In this workload each retained context costs about 6 KB, so the leak is invisible here.
- I did **not** show that this chain explains 30 to 35 MB/h. The chain length grows with how often `sessions` or `terminals` change. My workload has no Claude hook or transcript events on 6 of 8 lanes, so it recreates the callbacks about 6 times per hour. Real lanes emit events continuously. What each retained context holds also depends on the transcript data in each session. Both factors would raise the rate, and neither was measured. This needs a run with live Claude lanes (see Recommendations).
- The large saved-sessions/projects JSON string **is** in the heap: one copy, 9.9 MB, constant at all three snapshots. It is retained by `projectsSerRef`, not growing.

## What ran

- Phase 1 (19:07 to 20:07 local, small store) and phase 2 (20:09:25 to 08:09 local, synthetic 5.3 MB store injected into the scratch `projects.json`, renderer reloaded once to restart the clock). The final numbers are phase 2. Phase 1 is a small-store control.
- Workload: 5 lanes running `date; ls -la /usr/bin | head -40; sleep 3` in a loop, 1 lane printing 700-character ANSI-coloured lines every 2 s and a 6,000-character line every 20th, 2 real Claude Code lanes (one prompt each: "Reply with the single word: ok"). The loop lanes are real lane panes whose `claude` command is a shim, chosen by a scratch `ZDOTDIR`. The real Claude lanes were suspended by the 30 min idle timer and stayed suspended. Active lane switched every 20 min by clicking the sidebar over CDP (6 live lanes cycled).
- `OPERATOR_DIR`, the Chromium profile, and CDP port 9343 were all in the scratchpad or reserved for this session. Sampler: every 15 min via CDP (`Runtime.getHeapUsage`, `Performance.getMetrics`, a post-GC heap reading) plus `ps` RSS of every Electron process and `footprint` of the renderer. Snapshots after a forced GC at 1 h, 6 h, 12 h.
- 48 usable samples in phase 2 (rows taken within 5 min of a snapshot are flagged and excluded from the fits).

## Growth per process (phase 2, linear fit over 48 samples, 0 to 705 min)

| Series | Start (mean of first 6) | End (mean of last 6) | Slope per hour (± s.e.) | Reading |
|---|---|---|---|---|
| JS heap after GC (MB) | 28.2 | 28.9 | **+0.056 ± 0.021** | small positive trend, explained by Suspect 1 |
| JS heap before GC (MB) | 33.2 | 35.9 | +0.23 ± 0.20 | GC sawtooth, not significant |
| JS heap total (MB) | 67.0 | 72.3 | +0.17 ± 0.29 | not significant |
| Renderer RSS (MB) | 222.9 | 209.3 | -0.8 ± 0.8 | flat (first sample 321 MB just after reload is in the fit) |
| Renderer `phys_footprint` (MB) | 212.5 | 221.0 | +0.34 ± 0.31 | flat |
| Main RSS (MB) | 160.4 | 165.8 | +0.27 ± 0.27 | flat |
| GPU RSS (MB) | 59.5 | 58.9 | -0.06 ± 0.05 | flat |
| Network utility RSS (MB) | 25.5 | 25.1 | -0.04 ± 0.01 | flat |
| Lane child processes, sum (MB, 12 processes) | 19.0 | 18.9 | -0.015 | flat |
| DOM nodes | 995 | 852 | -6.5 ± 3.7 | flat, varies with the active lane |
| JS event listeners | 563 | 545 | +2.5 ± 2.2 | flat |
| xterm instances | 6 | 6 | 0 | |
| localStorage bytes | 4,959,551 | 4,959,594 | +2.5 | flat (the 43 bytes are the volatile fields) |

For comparison, the field growth was about 30 to 35 MB/h of renderer RSS (`memory-footprint-research-2026-10-16.md` Q3). The measured renderer RSS slope here is -0.8 ± 0.8 MB/h.

Phase 1 (1 h, small store): post-GC snapshot totals 24.9 MB at 1 min, 26.6 MB at 3 min, 39.5 MB at 60 min. The +13 MB is xterm scrollback filling (6,593 more `BufferLine` objects, each with a 1,224-byte `Uint32Array`) plus 2.5 MB of per-terminal `InputHandler._parseBuffer`. Correction to the interim note: it said no Context/closure class grew by more than 85 KB and attributed nothing to them. The phase 2 snapshots show the contexts in Suspect 1 are the only monotonic JS-side growth.

## Snapshot comparison (phase 2; reachable objects after forced GC)

| | 1 h | 6 h | 12 h |
|---|---|---|---|
| Reachable total (MB) | 66.03 | 58.07 | 57.79 |
| Reachable nodes | 402,373 | 379,026 | 383,012 |
| Native (MB) | 41.38 | 33.65 | 33.08 |
| JS-side, everything else (MB) | 27.85 | 27.24 | 27.52 |
| Strings (MB) | 15.26 | 15.27 | 15.31 |
| Compiled code (MB) | 5.63 | 5.70 | 5.76 |
| Objects (MB) | 4.84 | 4.12 | 4.25 |
| Closures (KB) | 432 | 448 | 465 |

- The total fell 8 MB between 1 h and 6 h. Cause: native `JSArrayBufferData` fell 7.4 MB as `BufferLine` objects went 20,274 to 16,292 (then 16,374 at 12 h). That is xterm scrollback, which depends on which lane was active when the snapshot was taken; I did not test this explanation by controlling the active lane. It is bounded and not a leak.
- JS-side memory is flat to within 0.6 MB across 11 h. The sum of growth in the code, closure, array, object, and string types between 6 h and 12 h is about 0.27 MB.
- Object ids are not stable across snapshots without heap-object tracking, and tracking would change the measurement. The diff is therefore by class and by retainer-path signature, not by object id. The scope numbers in the class key (`Context / scope @N`) are snapshot-specific: the same contexts appear as `@91269` in the 6 h diff and `@83407` in the 12 h diff. Counting contexts by their slot names (`ctxcount.mjs`) removes that artefact.

### Top 5 growers and where they point

Names are minified; source locations come from a source-map build of the same commit (`vite build --sourcemap`), by mapping the declarations of the minified slot names (`srcloc.mjs`).

1. **Retained `DashboardView` render contexts: 17, 47, 85 (1 h, 6 h, 12 h).** Same count of `AgentSession` arrays below. Retainer path, from GC roots: `Window` > React fiber (`__reactFiber$…` on a `<div>`) > `pendingProps` > `onTogglePanel` > closure > Context `fn` > closure > Context `ic` > closure > Context `fn` > … 70+ links, alternating, ending in a Context slot `Ke` (and `e`) that holds an array of 8 `AgentSession` objects. Sources:
   - `fn` is `setPanelOpen`, `DashboardView.tsx:456` (`useCallback`, deps `[patchLayout, sessionLayouts, beginLayoutMove, cardWFor, sidebarCollapsed]`).
   - `ic` is `focusTerminal`, `DashboardView.tsx:3440` (`useCallback`, deps `[terminals, sessions]`; also stored in `focusTerminalRef.current` at `:3450`).
   - The root is `onTogglePanel={togglePanel}`, `DashboardView.tsx:6784`; `togglePanel` is `:465` and depends on `setPanelOpen`. The prop is declared at `SessionToolbar.tsx:87`.
   - `Ke` is `allSidebarSessions = localSessions` (`:4730`), rebuilt on every render; the non-hook entries are new objects each time (`startedAt: new Date().toISOString()`, `:4724`).
   - `Rc` in the same scope is `projectsSerRef` (`:4996`). The scope is the whole component body.
   - Mechanism (inferred from the path; not proven by a controlled test): each render creates one JS Context for the component's captured variables. A memoized callback keeps the Context of the render that created it. When another memoized callback is recreated in a later render, the new Context holds the older callback in its slot, which holds an older Context, and so on. A recreation of either callback therefore pins the whole Context of that render, and nothing in the chain is released while the newest link is referenced from the fiber. Each pinned Context holds that render's `allSidebarSessions` array.
   - Growth in this run: 17 to 85 contexts, 1,420 bytes of self size each, about 5.8 KB retained each with their session arrays, matching the +0.056 MB/h post-GC slope.
2. **`AgentSession`-shaped objects (own properties `workingDirectory`, `activity`, `messages`): 132, 432, 812.** Counted by property names (`sessobj.mjs`): 6 to 8 per array, about 60 per hour. Same retainers as 1 (the `Ke` and `e` slots). The strings `workingDirectory` (+32) and `startedAt` (+75) and the empty `activity`/`messages` arrays (+75 each) in the 1 h to 6 h diff belong to these. Their size here is small because the shim lanes have no transcript; in real lanes each object also carries its activity and messages.
3. **React props/children `Object` and `PropertyArray` (+2,000 objects 6 h to 12 h, +0.06 MB):** path `[] <- Array | children <- Object | props <- Object | children <- Object`, that is the React element tree, and `properties <- Object | [] <- Array | Ke (ctx)`, which is the same session arrays again. I read the first as the live render tree (it grows with Suspect 1's retained trees only if it keeps older elements; not separated).
4. **Compiled code, +125 KB (47,655 to 48,745 objects).** Lazy JIT compilation as code paths run; the 6 h to 12 h step is +55 KB. No retainer chain to our code. Not treated as a leak.
5. **Blink native objects: `HTMLCollection` and `HeapHashTableBacking` (566, then 725, then 723), `GeometryMapperClipCache::ClipCacheEntry` (176, 300, 299).** Retained by accessibility (`AXNodeObject`) and style nodes of `xterm-cursor` spans. They rose between 1 h and 6 h and are flat between 6 h and 12 h, so they are not continuing growth.

## The large saved-sessions / projects strings

- A string of 9,904,384 bytes (two bytes per character, about 4.95 M characters) starting `[{"createdAt":"2026-10-25T00:00:00.000Z","id":"leakscratch-0001",…` is in the heap at 1 h, 6 h and 12 h, count 1 each time, same size. It is `Rc.current` (`current <- Rc <- Context`), that is `projectsSerRef` at `DashboardView.tsx:4996-5001`: the last serialized projects list (without `lastActiveAt`), kept to skip identical writes.
- It is **not** part of the growth: constant at three snapshots. It costs memory proportional to the projects store for the life of the renderer, at twice the character count here. The saved-sessions twin (`savedSerRef`, `:4949`) is small in this store.
- The transient `JSON.stringify` results at `:4985`, `:4999` and `:5002` are not visible in snapshots because they are collected before a forced GC. Their peak cost (a 10 MB string per run) is a heap-pressure effect, not a retained one; I did not measure how often the effect runs (`localStorage` bytes stayed flat, and the sampler cannot see allocations).
- The persisted-JSON detector found only this string and the 1,024-character mock sessions string (`s-op`, `/Users/dev/operator`), which the dev mock bridge writes into a fresh `OPERATOR_DIR`.

## Caveats: how this differs from 17 real lanes

- 6 live lanes, not 17; 2 real Claude lanes, suspended for most of the run. Shim lanes have no Claude hook events and no transcript, so `sessions` and `terminals` change rarely. The recreation rate of the two callbacks in Suspect 1 is the main thing this workload under-represents.
- Session `messages` and `activity` arrays are empty here; real ones are populated.
- The synthetic store is 2,550 filler tasks and 833 dispatches over 17 `/nonexistent` projects, not real data. localStorage 4.96 MB.
- The renderer was reloaded once at the phase boundary. Phase 1 data is a separate control.
- The switcher cycles lanes of the scoped project only, and does not wake suspended lanes.
- Two extra snapshots at 1 and 3 min (validation) were taken in phase 1.
- The machine was memory-constrained at times (pressure level 1 to 2 in the log). `caffeinate -i` kept it awake.
- The Preview panel, Team board, dispatches, worktrees, and Tuning were not used. I did not click the Team "Launch →" for the whole-team brief; the per-row Launch was used after the user approved it, with the dev-server option off and an empty brief.
- Production crashes happened at 3 to 4.4 days; this run is 0.5 day. A slow leak (such as 0.056 MB/h) is visible only through the structure of the snapshots, not through an RSS trend.

## Recommendations (the coordinator decides; I commission nothing)

1. **Code lane:** make `setPanelOpen`, `togglePanel`, `focusTerminal` and `openLaneTerminal` read changing state through refs (`activeSessionIdRef` already exists; add `sessionsRef`/`terminalsRef`) so their dependency lists stop containing `sessions`, `terminals`, `sessionLayouts`. That removes the chain at its source. Then re-measure with the same scripts. This is a hypothesis fix until the rate under real lanes is shown.
2. **QA lane (me), next run, about 1 to 2 h:** repeat the 3-snapshot comparison with the 2 real lanes kept alive (set `operator.lane.idleSuspendMinutes` high in Tuning) and forced activity (a tiny prompt every 5 min), so hook events reach the renderer. Count contexts with `ctxcount.mjs` and `AgentSession` objects with `sessobj.mjs`. This shows the chain's growth rate and per-link size under real events. Needs approval for the token cost.
3. **Coordinator, decision:** a planned renderer reload when the heap passes a threshold (option 2 in `renderer-sigtrap-2026-10-20.md`) is still the cheapest containment, since the field leak is not yet attributed.
4. **Code lane, low priority:** `projectsSerRef` keeps one full serialized copy of the projects list. Storing a hash or length plus a cheap version counter would remove a retained copy proportional to the store.
5. **Review lane:** check recommendation 1 for the case where a callback in the chain is used by a child that relies on identity changes to re-render.
6. **Side findings, not investigated (Code or Research):** a Team-tab launch registers a second project named after the folder; a fresh `OPERATOR_DIR` receives dev mock-bridge session rows.

## Pass/fail rundown

| Item | Result | How exercised |
|---|---|---|
| Build current main, run production renderer with isolated `OPERATOR_DIR` and CDP 9343 | Pass | App driven (build and launch in a detached worktree) |
| Workload: scratch project, 5 loop lanes, 1 long-line/ANSI lane, 2 real Claude lanes | Pass, with substitution | App driven; plain terminals are not creatable in the UI, so shim lanes were used; real lanes were suspended by idle timer |
| Active-lane switching over CDP | Pass | Script, 6 live lanes, `logs/switcher.log` |
| 15-min sampling, per-process RSS and heap | Pass (48 samples) | Script via CDP and `ps` |
| Heap snapshots at 1 h, 6 h, 12 h | Pass | `HeapProfiler.takeHeapSnapshot` after forced GC, files in the scratchpad |
| 1 h vs 12 h comparison, retainer paths, source locations | Pass | Snapshot analysis scripts, source maps |
| 12 h or longer uptime | Pass | App alive 13 h 9 min at shutdown |
| Reproduce the field leak | **Fail** (not reproduced) | Measured; see Result |
| Attribute the 30 to 35 MB/h | **Not shown** | One candidate mechanism identified; magnitude under real lanes not measured |
| Large JSON strings among the growth | Pass (answered) | Present, constant, not growing |
| Quit the app and stop loops | Pass | Quit via the guard dialog ("Quit and end them"), sampler and switcher killed by pid after checking their command line, caffeinate stopped; `ps` check found no process with the scratch profile, shim, or scripts |

## Leftovers

- `~/.claude.json` has a trust entry for the scratch folder `…/scratchpad/proj-scratch` (accepted at first launch).
- A detached git worktree `…/scratchpad/wt` is registered in the repo (`git worktree list`). `git worktree remove --force` removes it; I did not alter the shared repo's worktree list on my own.
- Snapshots (173 MB), `opdir` (11 MB), and `userdata` are in the scratchpad.
- My first launch used the user's default Chromium profile for under a minute while the installed Operator.app was running. The profile's LevelDB log showed no write after my launch; I relaunched with a scratch profile.

## Files

- Tools and data copied here: `dev/results/renderer-leak-measurement-2026-10-25-tools/` (sampler, switcher, snapshot loader and analyzer, source-map lookup, `ctxcount.mjs`, `sessobj.mjs`, `chain.mjs`, `bigstr.mjs`, shim, `samples.jsonl`, `diff-1h-12h.json`). The scripts have the scratchpad path hard-coded as `S`.
- Interim note: `dev/results/renderer-leak-measurement-2026-10-25-interim-1h.md`.
- Snapshots: `/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad/snapshots/{1h,6h,12h}.heapsnapshot`.
