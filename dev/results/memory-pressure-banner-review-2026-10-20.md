# Memory-pressure banner — review

Date: 2026-10-20. Reviewer: Review lane. Target: branch `operator/897500` @ `3a17a2f` (`git diff main...3a17a2f`), one commit, 13 files. Design notes: `dev/results/memory-pressure-banner-2026-10-16.md`. Read the full diff plus `suspendLane`, `runSuspend`, `canRestartLane`/`canAnnounceTo`, `Terminals.kill`/`reapTree`, `sessionPorts`, the session-update path that confirms submissions, and the idle-compaction handling in `transcript.ts`. Line numbers below are in the branch's files.

No High findings. One Medium, the rest Low or informational.

## Findings

### M1. An uncapped `'now'` pass acts on a candidate snapshot that can be tens of seconds old, and the pre-kill re-check does not cover background tasks, subagents, dev servers or held deliveries

`src/renderer/views/DashboardView.tsx:4398` (pass loop), `:4136` (`stillIdle`), `:4385` (snapshot planned once).

`suspendableLanes` builds every candidate once at the start of the pass, reads transcripts and then ports one lane at a time (`:4381`), and returns the list. The pass then suspends each lane in sequence. Each `suspendLane` runs `report` (an IPC write), then `terminalKill`, which takes a `ps` snapshot plus the tagged sweep and waits up to `GRACE_MS` 1.5 s (`electron/src/main/reap.ts:38`) before escalating. Under critical pressure, with the Mac swapping, each of those execs is slower. With `limit = Infinity` and 10–15 eligible lanes, the last lane is suspended tens of seconds after it was judged.

Right before the kill, `stillIdle` re-checks only: tab not ended, `canRestartLane` (between turns, nothing in the submit queue), no unsent input, nothing awaiting readiness, not focused. It does not re-check `backgroundTasks`, `activeSubagents`, `devServer`, `heldDeliveries`, `released`, `retiringRef`, `laneGateRef.busy` or the launch maps. The timed tick had the same gap, but its cap of 2 kept a pass to a few seconds, and its quiet-time rule made a turn inside the window unlikely. `'now'` with no cap removes both protections.

Failure scenario: critical level, 12 eligible lanes. The pass starts and lane #11 is judged idle with no ports. While lanes #1–#10 are being killed (~25 s), a dispatch reaches #11. It takes a turn that starts `npm run dev` with `run_in_background` and ends the turn in a few seconds. Its phase is `idle` again and the submission is confirmed. When the pass reaches #11, `stillIdle` passes, and the CLI is killed along with its background task and the dev server it just started. The same applies to a subagent left running, or a dispatch that is held for approval mid-pass.

Suggested direction (Code): re-run the full `suspendDecision` against fresh state for each lane right before its kill, or re-plan after each suspend. At minimum, add `backgroundTasks`/`activeSubagents` from `sessionsRef` and a fresh `heldDeliveriesFor` to `stillIdle`.

### L1. No hysteresis on level transitions: a 1↔2 flap brings a dismissed banner back and resizes every visible pty by 32 px on each flap

`electron/src/main/memory-pressure.ts:85-91` (every change is pushed), `src/renderer/lib/memory-pressure.ts:37` (a rise from 1 clears `dismissed`), `DashboardView.tsx:7057` (the banner is a layout row in every mode).

Near the warn threshold the reading can move between 1 and 2 from one poll to the next (20 s at 1, 5 s at 2). Each 1→2 transition counts as a new rise, so a banner the person dismissed comes back. Each show or hide also takes 32 px from the content card, so every visible lane pane refits and sends SIGWINCH to its CLI. This project has a history of terminal ghosting on resize. I did not verify whether the kernel's own level has enough hysteresis to prevent the flap, so this is plausible, not confirmed. Suggested direction: require N consecutive normal readings, or a minimum time at 1, before reporting the drop to 1. Keep a dismissal for some minutes across a quick 2→1→2.

### L2. The pass lock has no timeout: a hung IPC inside a suspend stops idle suspension for the rest of the renderer's life

`DashboardView.tsx:4394-4404`.

`runSuspendPass` waits for `suspendPassRef.current` with no bound. If `setSuspendedLanes` or `terminalKill` never resolves, the pass never settles. The timed tick then skips on every minute with no log (`:4409`). The first pressure caller keeps `pressureBusy` true, so the button stays on "Suspending…". The level-4 interval adds one waiter every 30 s, indefinitely. The kill path looks bounded today (1.5 s grace plus `ps`), so this is unlikely. Still, nothing reports that the lock is stuck. `GATE_WAIT_CAP_MS` already treats a hold longer than 30 s as a hung IPC. Suggested direction: race each `suspendLane` against a cap and log when the cap fires.

### L3. `pressureBusy` is a boolean shared by overlapping callers

`DashboardView.tsx:4446-4455`.

The level-4 interval calls `suspendUnderPressure` every 30 s whether or not a call is already queued, and the button can add another. The first call to finish sets `pressureBusy` false while another call is still waiting on the lock or running. The button is re-enabled during a pass, shows a count that was read before that pass, and a click queues one more pass. No lane is wrongly suspended, because each pass re-plans. The busy indicator, though, does not show what is happening. Use a counter, or skip queuing an auto pass while one is pending.

### L4. The button's label can name fewer lanes than the click suspends

`DashboardView.tsx:4435-4444`, `:7065`.

The eligible count is read when the banner appears, every 30 s, and after each pass. The click runs a fresh `'now'` plan with no cap. If two more lanes finished their turns since the last read, "Suspend 3 idle lanes" suspends 5, including a lane whose result arrived a second ago and has not been read. Either cap the click at the shown count (quietest first), or refresh the count right before acting.

### L5. Watcher read failures are silent, and the reading's age is never checked

`electron/src/main/memory-pressure.ts:82`, `:79`, `:92`.

- `catch { /* kept */ }` logs nothing. A sysctl that always fails, or a dev `OPERATOR_MEMORY_PRESSURE_FILE` with a typo, produces no reading and no log line. `memoryPressure()` returns null and the renderer behaves as normal. Log the first failure, and log again when reads recover.
- A failed read keeps the last level. If reads start failing at 4 (fork/exec can fail under memory exhaustion, and the 5 s exec timeout can expire while swapping), the renderer keeps running auto passes every 30 s until a read succeeds. That errs toward freeing memory, which is acceptable. The `at` field exists, but nothing in the renderer looks at it, so no limit on staleness is enforced anywhere.
- The doc comment at `:79` says a failed read "is tried again at the normal interval". `:92` uses the elevated 5 s interval when the last level was above 1. Correct the comment or the code.

### L6. Auto passes continue while the banner is dismissed at critical, and nothing else reports them

`DashboardView.tsx:4459-4468`, `src/renderer/lib/memory-pressure.ts` (`bannerVisible`).

If the person dismisses the banner at 4, lanes keep being suspended every 30 s. The suspended count shows only in the banner, which stays hidden until the level drops to 1 and rises again. The only trace is a `console.info` line. This follows the design notes ("Going from 4 back to 2 does not bring a dismissed banner back"), but the person has no in-app way to learn that lanes ended. Consider counting suspensions made after the dismissal and showing the banner again when that count rises.

### Info

- **I1. `'now'` can kill a lane during an idle compaction.** `transcript.ts:720-728`: the compact boundary is written only once the compaction finishes, so a lane compacting between turns reads `waiting` the whole time. The timed tick had the same blind spot, but it needed minutes of quiet first. `'now'` hits it whenever a pass coincides. The transcript stays intact. The cost is one wasted compaction call and a resume into the uncompacted context. No action needed unless it shows up in logs.
- **I2. `MemoryPressureWatcher.start()` is not idempotent.** `stop()` followed by `start()` while a poll is in flight leaves two polling loops, because the old poll sees `stopped === false` and schedules again. Nothing calls it that way today (`index.ts` starts it once).
- **I3. Resume/suspend churn at critical.** A lane resumed by focus is suspended again ≤30 s after focus moves away, because `spawnedAt` no longer counts under `'now'`. Each cycle pays a CLI start-up peak. This follows from the design ("so a lane that finishes its turn while memory is still critical is suspended too"). Recorded so the trade-off is visible.

## Areas checked and clean

- **Lock correctness (`runSuspendPass`).** Checked in a scratch simulation of the exact lock shape: five overlapping callers, two of them throwing. Passes ran one at a time (`maxActive 1`), and the ref was null at the end. When the owner releases, its `finally` runs before any waiter's continuation, and the next waiter sets the ref synchronously, before its first `await`. No macrotask (the 60 s tick) can run inside that microtask gap. A rejected pass releases the lock through `finally`, and waiters swallow it with `.catch(() => 0)`. The timed tick skips while a pass runs. A pass that throws leaves no lock held. It surfaces as an unhandled rejection from `void runSuspendPass` / `void suspendUnderPressure`, which matches the old tick (no catch there either).
- **`'now'` keeps every other exclusion.** `src/renderer/lib/idle-suspend.ts:107-135`, read rule by rule. Only the Off check (`:107`) and the quiet-time comparison (`:130`) depend on `'now'`. These still apply: ended, not resumable, coordinator, focused, in flight, released, no phase, not between turns (running covers a permission prompt; asking is excluded), pending submission, awaiting delivery, unsent input, held deliveries, background tasks, subagents, no activity timestamp, transcript unread or without a turn, ports unread or serving a dev server. `needsConversationCheck`/`needsPortCheck` still ask for reads under `'now'`.
- **Never suspends a working lane (at the moment of the kill).** `runSuspend` checks `stillIdle` before and after the `report` IPC. From the last check to `markSuspended` the code is synchronous. A lane whose phase is running or asking at that moment is not killed. Dispatches are covered until their turn appears: `submitQueue.pending` stays set until `confirm`, and `confirm` fires in the same session update (`DashboardView.tsx:639-648`) that carries the user record that turns the phase to running. M1 is the remaining gap, and it concerns work left running after a turn, not a lane mid-turn.
- **Off is honoured by the automatic pass.** `autoSuspendAllowed` is read on every interval tick, so switching to Off stops the next pass. The button ignores Off, as the notes say it should.
- **The 30 s cadence holds with the window hidden.** `backgroundThrottling: false` (`electron/src/main/index.ts:180`).
- **Watcher teardown.** `stop()` clears the timer. A poll in flight returns after its `await` because `stopped` is set, so it schedules nothing. The timer is `unref`'d. `broadcast` goes through `win()`, which checks `isDestroyed()`.
- **Fake file is unpackaged-only.** `fakePressureFile` returns null when `app.isPackaged`. The watcher starts off-darwin only when the fake file is set. The `sysctl` path is absolute (`/usr/sbin/sysctl`), takes no user input, and has a 5 s timeout.
- **Parser.** It rejects non-numeric input and levels other than 1/2/4, and it clamps the percent to 0–100.
- **Renderer reload.** The mount effect asks `memoryPressure()` for the current reading and subscribes to pushes. The first poll's push can go out before the renderer loads, and this covers that case.

## Recommendations (for the coordinator)

- Code: fix M1 before merge (re-plan or re-check the full decision before each kill in an uncapped pass). L1–L5 are small and can go in the same round.
- QA: the notes' "with lanes running" checks are still owed. Add a flap test (rewrite the fake file between 1 and 2 every ~10 s) to see L1 in the app.
