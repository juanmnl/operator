# Memory-pressure banner — result

Date: 2026-10-19 (brief dated 2026-10-16). Lane: Design, branch `operator/897500`, commit `3a17a2f`. Not merged.

## What was built

1. **Watcher in main** (`electron/src/main/memory-pressure.ts`). One `execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level'])` per poll: every 20 s at level 1, every 5 s above it. A reading takes about 2 ms. Only level changes are pushed (`onMemoryPressure`); `memoryPressure()` returns the latest reading for a renderer that reloads. A failed read keeps the last level. It starts on macOS only (or when the dev fake file is set), and stops in teardown next to the Claude version watcher. Each change is logged as `[memory] pressure level N, X% available`.
2. **Banner at level 2** (`src/renderer/components/MemoryBanner.tsx`, state and copy in `src/renderer/lib/memory-pressure.ts`). A 32 px strip, the last row of the content card, in every mode. Copy: "Memory is low. 14 lanes are running." plus a button "Suspend 6 idle lanes". When no lane is eligible it says "None of them can be suspended right now." and shows no button. The eligible count is read when the banner appears, every 30 s while it shows, and after each pass.
3. **Level 4.** The same pass runs without asking, at once and again every 30 s while the level stays at 4. The banner reads "Memory is critically low. 9 lanes are running. Suspended 5 idle lanes." If idle suspension is Off in Tuning, nothing is suspended automatically; the banner says "Idle suspension is off in Tuning." and keeps the button.
4. **"Suspend now"** (`src/renderer/lib/idle-suspend.ts`). `suspendDecision` takes `IdleThreshold = number | 'now'`. `'now'` drops only the quiet-time rule (and the Off check, see decisions). Every other exclusion still applies: focused lane, coordinator, mid-turn or asking, unsent input, pending submission, messages waiting for readiness, held deliveries, background tasks, subagents, dev server (ports are still read), no conversation yet (transcript still read), not resumable, released, in flight, no tracked session, no activity timestamp.

## Files changed

- `electron/src/main/memory-pressure.ts` (new): parser, dev fake-file source, watcher.
- `electron/src/main/memory-pressure.test.ts` (new): 6 tests.
- `electron/src/main/index.ts`: start/stop the watcher, broadcast changes.
- `electron/src/main/ipc.ts`: `memoryPressure` handler.
- `electron/src/shared/operator-api.ts`: `onMemoryPressure` (event), `memoryPressure` (invoke).
- `src/shared/types.ts`: `MemoryPressureLevel`, `MemoryPressure`.
- `src/renderer/env.d.ts`: the two methods.
- `src/renderer/lib/idle-suspend.ts`: `IdleThreshold`, `'now'` handling.
- `src/renderer/lib/memory-pressure.ts` (new): reducer, visibility, auto rule, copy, sentence joining.
- `src/renderer/lib/memory-pressure.test.ts` (new): 34 tests.
- `src/renderer/components/MemoryBanner.tsx` (new).
- `src/renderer/views/DashboardView.tsx`: the suspend tick's candidate gathering moved into `suspendableLanes(threshold, limit)`; `runSuspendPass` holds one lock shared by the timed tick and pressure passes; pressure subscription, eligible count, auto pass, banner render; the scratch-terminal sheet's `bottom` clears the banner. `suspendLane`'s second argument is now a reason string for the log line instead of minutes.
- `dev/drive-memory-banner.mjs` (new): CDP driver for the banner states.

## Decisions

- **Polling `sysctl` and not a cheaper source.** Electron has no pressure API. `process.getSystemMemoryInfo()` reports free pages, which sit near zero on macOS whenever the file cache is warm, so it says nothing about pressure. Chromium's dispatch-source monitor is not exposed to JS. A native addon for `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` would be event-driven, but it adds a native build for a cost that is already negligible (one 2 ms exec every 20 s).
- **No separate Tuning toggle for the automatic part.** The existing setting already means "Operator may end idle lanes on its own". Off stops the automatic pass and leaves the button; on (any minutes value) allows it at level 4. A second toggle would only matter to someone who wants idle suspension on but would rather let jetsam act at critical, which I don't think anyone would choose. If wanted later, it is one more `autoSuspendAllowed` input.
- **The button works when idle suspension is Off.** The person pressed it, so the Off setting (which is about Operator acting on its own) does not block it.
- **Dismissal comes back on a rise from 2 to 4.** The brief says dismissal lasts until the level next rises from normal. I added one more case: if the banner was dismissed at warn and the level goes critical, it shows again, because lanes may now be suspended without the person asking and they should see the count. Going from 4 back to 2 does not bring a dismissed banner back. If this should follow the brief exactly, delete one line in `reducePressure`.
- **Repeat passes at critical.** Every 30 s while at 4, so a lane that finishes its turn while memory is still critical is suspended too. No per-pass cap (`limit = Infinity`). The timed tick keeps its cap of 2.
- **Placement.** A row in the layout at the bottom of the content card, not a floating card. A floating card would look like a toast and could cover a lane's composer, which sits at the bottom of the terminal. Placing it at the top would push the toolbar out of the traffic-light band. In session mode it sits under the footer and the terminal loses 32 px while it shows.
- **Visual vocabulary.** Same as the toasts: a 7 px status dot with a halo and a 7% wash of the hue over `--bg-terminal`; `--color-warning` at 2, `--color-error` at 4; neutral `--border` rule on top; no radius (the card clips it). The button uses the TidyBar/toast surface style (`--btn-bg`, `--overlay-medium` on hover). The dismiss control is the same ✕ as TidyBar and the toasts, and it only dismisses. No opacity on `--fg-muted` anywhere.
- **Display copy.** `joinSentences` binds each new sentence's first word to the next with U+00A0 and binds the last two words, so no sentence opens on a stray word and the text never ends on a lone word.
- **Dev override.** `OPERATOR_MEMORY_PRESSURE_FILE` names a file main reads instead of `sysctl` (unpackaged builds only, `fakePressureFile`). It goes through the real poll, IPC and renderer path, and the level changes live when the file is rewritten.
- **Port.** The brief asked for port 1431; this session had 1425 reserved for dev servers, so the dev build used 1425 (CDP 9345).

## Verification

- Unit tests: parser (valid, out-of-range percent, junk, unknown levels); watcher (reports only changes, 20 s / 5 s intervals, a failed read keeps the level, stop); banner state machine (shown at 2 and 4, dismiss holds, shown again on a new rise from 1, shown again 2→4, stays dismissed 4→2, hidden at 1, count reset); auto rule (only at 4, never when Off); copy (counts, singular, no button at 0 eligible or while reading, Off message, no-break spaces); "suspend now" (suspends a lane quiet for 10 s that the timed tick keeps, works with Off, and 18 exclusions each still keep the lane, ports still read, no cap).
- `npm test`, root: 123 files, 1929 tests passed. Electron: 55 files, 989 tests passed. Both typechecks clean. The timing-sensitive worktree tests did not fail on this run.
- In an isolated dev build (`OPERATOR_DIR` in the scratchpad, Vite on 1425, CDP 9345), `dev/drive-memory-banner.mjs` passed 14 of 14 checks in dark and light (mission-control): hidden at 1, shown at 2, critical at 4, dismissed, stays dismissed 4→2, shown after a new rise from 1, gone at 1. Screenshots:
  - `/Users/juanmnl/Developer/operator/dev/results/_scratch/memory-banner-shots-2026-10-19/memory-banner-dark-warn.png`
  - `/Users/juanmnl/Developer/operator/dev/results/_scratch/memory-banner-shots-2026-10-19/memory-banner-dark-critical.png`
  - `/Users/juanmnl/Developer/operator/dev/results/_scratch/memory-banner-shots-2026-10-19/memory-banner-light-warn.png`
  - `/Users/juanmnl/Developer/operator/dev/results/_scratch/memory-banner-shots-2026-10-19/memory-banner-light-critical.png`

## Not tested

- **With lanes running.** The isolated dev build had no live lanes, so the screenshots show "0 lanes are running." with no button. Not seen in the app: the button, "Suspending…", the count after a pass, an automatic pass actually suspending a lane at 4, "None of them can be suspended right now." with lanes running, and the banner under the session footer with the scratch-terminal sheet open. I did not start lanes because test lanes are real agents and act on their briefs. QA should run the driver with two or three idle lanes in a dev build.
- Only the mission-control palette was checked, in dark and light. 1984 and mr-pink were not.
- Narrow windows: the text is set to truncate with an ellipsis before the button and ✕ do, but this was not checked at a narrow width.
- A real level change from the kernel. The `sysctl` path was read once (level 1, 66% available); levels 2 and 4 came from the fake file.
- The packaged build: `fakePressureFile` returns null when `app.isPackaged` (unit-tested), but no packaged build was made.

## Recommendations (for the coordinator)

- QA: the "with lanes running" checks above, in a dev build with `OPERATOR_MEMORY_PRESSURE_FILE`.
- Review: the shared suspend-pass lock in `DashboardView` (`runSuspendPass`) and the unbounded pass at critical.

## Round 2 (2026-10-20)

Fixes for Review's findings (`dev/results/memory-pressure-banner-review-2026-10-20.md`): M1 and L1–L5, plus I2. L6 was not in scope for this round and is unchanged.

### M1: each lane is judged again on fresh state right before its kill

- The pass loop is now `suspendPlanned` in `src/renderer/lib/idle-suspend.ts`, used by both the timed tick and the pressure passes. For each planned lane it reads the ports again, then runs the full `suspendDecision` on a candidate rebuilt from the view's current state. It does this before the suspend starts and again inside `suspendLane`'s `stillIdle`, which runs before and after the report IPC and so immediately before the kill.
- Re-checked: background tasks, subagents, a dev server (ports read again), held deliveries, a release, a restart or retire in flight, a busy lane gate, a launch in flight, phase, unsent input, a pending submission, awaiting delivery and focus. The transcript is not read again, because once a turn is seen it stays seen.
- The candidate builder moved out of `suspendableLanes` into `suspendCandidate(tab, now, suspending)`. During the re-check the lane's own suspend in progress does not count as in flight. Any other suspend of the same lane is still refused at the top of `suspendLane`.
- Tests: a lane that gains a background task while an earlier lane is being killed is not killed. A lane that gains one between its report and its kill is not killed. The same holds for a subagent, a held dispatch, a release, another end of the lane in flight, a turn in progress, and a dev server started mid-pass (found by the new port read). A lane whose ports cannot be read now, or whose tab is gone, is kept.

### L1: no flap

- Main reports a drop to normal only once the grade has read 1 for `NORMAL_CONFIRM_MS` (60 s, read every 5 s). A rise is reported at once. A 2→1→2 shorter than a minute never reaches the renderer, so the banner neither hides nor resizes the panes.
- The reducer also keeps a dismissal across a drop to normal followed by a rise to warn within `DISMISSAL_KEPT_MS` (5 min) of the drop. A rise to critical always shows the banner, as warn to critical already did.
- Cost: the banner stays up for about a minute after memory recovers.
- R2-1 fix (2026-10-20, commit `58a882b` on `operator/897500`): a read of 1 while 4 is reported now reports 2 at once, so the critical pass stops on the first normal read, and the banner stays up and changes from "critically low" to "low". The 60 s hold applies only to the final drop to 1, counted from that first normal read. A return to 4 during the hold is reported at once and restarts the count. Tests: 4→1 reports 2 then 1 after 60 s; 4→1→4→1 reports 4, 2, 4, 2, 1. Root 1942 and electron 994 tests pass (2 new, 1 updated); both typechecks are clean. Not run in the app.

### L2: capped steps

Each lane's step (port read, report and kill) is raced against `SUSPEND_STEP_CAP_MS` (20 s), and so is the planning read. Past the cap the pass logs `[lanes] suspend of <id> took longer than 20 s; the pass moved on` and continues, or logs that the planning read timed out and suspends nothing. A port read that comes back after the cap starts no suspend. A step that throws is logged and the pass continues; before this, the rest of the pass was skipped.

### L3: busy state

`pressureBusy` is driven by a count of pressure passes asked for and not finished, so the button stays on "Suspending…" until every pass has finished. The level-4 interval does not queue another pass while one is pending.

### L4: the button suspends at most what it shows

The click runs the pass with `limit` set to the count on the button, quietest first. A lane that went quiet after the count was read waits for the next read (30 s) or the next pass.

### L5: watcher reads

The first failed read is logged with its error (`[memory] pressure read failed (...); keeping level N`), and so is the recovery (`... recovered after N failed reads`). Unparseable output counts as a failure. The retry comment now matches the code: a failed read is tried again at the interval of the last level, 5 s above normal and 20 s at normal.

### I2

`start()` called while a read is in flight no longer leaves two polling loops. Each start or stop increments a run counter, so a read from an earlier run schedules nothing.

### Verification

- `npm test`, root: 123 files, 1942 tests passed (13 new). Electron: 55 files, 992 tests passed (3 new). Both typechecks are clean (`tsc` at the root and `npm run typecheck` in electron).
- Isolated dev build (`OPERATOR_DIR` in the scratchpad, Vite 1425, CDP 9345): the updated `dev/drive-memory-banner.mjs` passed 18 of 18 checks in dark and light. That covers staying dismissed across a 15 s 2→1→2 (the main log shows no level-1 report during it), still being shown 30 s into normal, and being gone once normal has held. Screenshots are in `/Users/juanmnl/Developer/operator/dev/results/_scratch/memory-banner-shots-2026-10-20/`.
- Still not tested in the app: anything with lanes running, including the M1 re-check against a real background task. QA's "with lanes running" checks are still owed.
