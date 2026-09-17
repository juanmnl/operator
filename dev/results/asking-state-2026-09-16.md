# Lane state `asking` — 2026-09-16

Lane: Design. Branch `operator/asking-state` off `main` (c463d90), in worktree
`~/.operator/worktrees/operator-666300`. Commit: `b30f691`.

## Verification

- Renderer suite: 86 files, 1320 tests passed, 0 failed.
- Electron suite: 33 files, 574 tests passed, 0 failed.
- `tsc --noEmit` passes for the renderer project and `electron` `npm run typecheck` (main + renderer
  configs).
- Not verified in the GUI: the flash in the rail, the reduced-motion look, the tray icon, and the quit
  dialog row all still need a look in the running app.
- `node_modules` and `electron/node_modules` in the worktree are symlinks to the main checkout. Git
  ignores them and they are not committed.

## 1. Detection (`electron/src/main/transcript.ts`)

- `Track.openQuestions`: ids of `AskUserQuestion` tool_use blocks on the main thread
  (`isSidechain !== true`). It is a subset of `openTools`.
- An id is removed by that tool's `tool_result`, whatever it says. Real transcripts write two shapes,
  and both clear it:
  - answered: `"Your questions have been answered: …"`, with `toolUseResult.answers`;
  - declined or Esc: `is_error: true`, `"The user doesn't want to proceed with this tool use…"`,
    `toolUseResult: "User rejected tool use"`.
- The set is cleared on a re-read, like `openTools`.
- `derivePhase(..., compacting, asking = false)` gains a fifth argument, and existing calls are
  unchanged. Order: `compacting` → `asking` → open tool → `tool_use` stop → prompt sent → `waiting`.
  `asking` has to come before the open-tool check because the question is itself an open tool; before
  this change the lane read `running` for as long as the question sat there (4h13m in the transcript
  the fixture is modelled on).
- `tick()`: pty activity no longer relabels `asking` as `running`. The question dialog is drawn in the
  pty and redraws as the user moves between options, so the pty is busy exactly while the user is
  reading the question.
- The Tauri `derive_phase` in `src-tauri` was not changed. It is historical, and the Electron shell
  is the one that ships.

### Permission prompts: not detected

This can't be done reliably from the transcript. I checked real rejected `Bash`/`TaskStop` calls
across local transcripts: the `tool_use` is the last record for the whole time the prompt is on
screen (19s in one case), and the next record is the result. A long-running `Bash` looks exactly the
same, so treating an open tool as a prompt would flash every slow command. The
`permission-pending` fixture test holds this down: it reads `running`.

A reliable source would be Claude Code's hook events (a `Notification` hook for a permission prompt).
Operator does not install hooks today, so that would be a separate piece of work.

## 2. Motion

### Rail orb (`src/renderer/components/sidebar/StatusWave.tsx`)

`WaveStatus` adds `asking`, drawn by a new `BeaconCanvas`. It uses the same shared rAF loop,
off-screen orbs leave the loop, and colours are resolved once per theme.

| | Resting orb | Running twinkle | Asking beacon |
|---|---|---|---|
| Dots | all the same | desynced, own period each | all the same, together |
| Size | full | 0.5 → 1 | full |
| Opacity | `REST_OP` 0.25 | 0.30 → 0.95 | 0.25 → 1.0 |
| Colour | lane rest fill | `--fg-muted` → lane accent | lane rest fill → `--color-warning` |
| Rhythm | static | continuous | 120ms flash up, 450ms fall, 930ms rest; 1.5s cycle |
| Ink (opacity × size) | 0.25 | ≈0.51 per frame, nearly constant | 0.25 at rest, 1.0 at the flash, mean ≈0.365 |

How this fits the measurements in the StatusWave comments:
- **Trough = rest.** Between flashes an asking orb is pixel-for-pixel a resting orb in its own lane
  colour, so it still shows which lane it is. `REST_OP`, its CIELAB derivation, and the rule that a
  resting orb never outshines the running trough are all untouched.
- **Peak ≥ 2× busy.** The flash frame is 1.0 against the twinkle's ≈0.51 (1.96×). That is the "at least
  twice the ink" test `REST_OP` was set by, applied to the flash. A test recomputes the 0.51 from
  `twinkleProgress` rather than trusting the comment.
- **Mean is lower than running, on purpose.** The beacon goes on and off; the eye reads the jump from
  0.25 to 1.0 and the dark gap, not the average.
- **Hue: `--color-warning`, not the lane accent.** A running orb blooms in its lane accent, so an
  accent-coloured beacon on a green lane would differ from its own running orb only by rhythm. Warning
  is the same hue as `compacting`, but compacting is rare and short and it twinkles, so moving together
  plus the rest gap still separates them.
- **Phase:** time comes from `performance.now()`, not time since mount, so every asking orb in the
  app flashes together.
- **It never settles.** `PULSE_SETTLE_MS` still only applies to `waiting`.
- **Reduced motion:** `prefers-reduced-motion: reduce` (followed live) draws a static SVG with every
  dot at full size, opacity 1.0, in `--color-warning`. That is brighter than any resting orb and a
  different colour from the lane's rest fill.
- The running orb does not honour reduced motion today. That was already true and is unchanged.

### Timing (`src/shared/beacon.ts`)

`beaconLevel(elapsed)` returns 0–1 from absolute time, and both the renderer and the main process
import it. Constants: period 1.5s, attack 0.12s (eased out), decay 0.45s (eased in), rest gap 0.93s.

### Tray (`electron/src/main/tray-anim.ts`)

- New `TrayPhase` `asking`, which outranks `busy`. With one lane asking and six running, the twinkle
  would otherwise hide the question.
- Frame: the template image cannot carry colour, so every dot flashes together with opacity
  0.30 → 1.0 and size 0.6 → 1.0 on `beaconLevel`.
- It does not settle (`YOUR_TURN_SETTLE_S` only applies to `your-turn`).

## Consumers of the phase

| File | `asking` handling |
|---|---|
| `shared/types.ts` | added to `SessionPhase` (documented) |
| `lib/session-status.ts` | → `WaveStatus 'asking'` |
| `sidebar/ProjectRail.tsx` `waveStatusOf` | passes `asking` through |
| `sidebar/SessionItem.tsx` | phase word `asking you`, in `color-mix(--color-warning 50%, --fg)`, no opacity (the other phase words keep their existing 0.65 opacity on `--fg-muted`, which breaks the no-opacity-on-muted rule; left as it was, noted for a follow-up) |
| `session/SessionActivityView.tsx` `StatusDot` | `--color-warning` dot |
| `main/quit.ts` `isBusy` | busy, so the quit guard fires |
| `lib/quit-guard.ts` | sorted first, row word `Asking you`, counts toward "waiting on you" |
| `lib/lane-lifecycle.ts` | never auto-closed: "asking you a question" |
| `lib/chat-signal.ts` | `{ kind: 'asking', label: 'Asking you', animate: true, interruptible: true }` |
| `lib/project-status.ts` | rank 5 (above running) and counted in "N needs you" |
| `session/TaskBoard.tsx` | state slot `asking you · <elapsed>`; no second activity line |
| `views/DashboardView.tsx` | chime on running/compacting → asking; submit queue treats it as mid-turn (it read `running` before, so no change in behaviour) |
| `lib/comms.ts` `isBetweenTurns` | stays false for `asking`, so nothing is typed into the dialog |
| `main/tray-anim.ts` | `asking` state (above) |

## Tests

- `electron/src/main/transcript-asking.test.ts`, using fixtures in `electron/src/main/__fixtures__/`.
  The fixtures copy the shape of real Claude Code 2.1.259 records with the text replaced:
  - `asking-open`: the assistant message streamed as three records sharing one message id (thinking,
    text, tool_use) reads `asking`;
  - it stays `asking` with the pty busy;
  - appending the answer clears it;
  - answered read from the start is not `asking`, and neither is declined;
  - a sidechain question does not count;
  - `permission-pending` reads `running`;
  - `derivePhase` ordering;
  - `isBusy`;
  - tray aggregate ordering.
- `electron/src/main/tray-anim.test.ts`: the flash frame carries more than 2.5× the ink of the rest
  gap, two instants in the gap are the same image, and `asking` does not settle after 20s.
- `src/shared/beacon.test.ts`: attack/decay/rest shape, rest gap longer than the flash, absolute-time
  periodicity, stays in [0,1].
- `src/renderer/components/sidebar/StatusWave.test.ts`: the twinkle ink ≈0.51, beacon trough equals
  `REST_OP` with no colour mix, peak 1.0 in `--color-warning` at ≥1.9× the running ink, mean ≈0.365.
- `src/renderer/lib/asking-phase.test.ts`: wave status, project roll-up, quit guard order and copy,
  chat signal, `isBetweenTurns`.

## Open

- GUI check of the flash, the reduced-motion look, the tray icon, and the quit dialog row.
- Permission prompts need a hook-based signal (above).
- If Claude Code is killed with a question open and the same transcript is resumed, the question
  stays open until a result record arrives. I have not checked what `--resume` writes in that case.
