# Launch opens on the home overview — 2026-09-16

Lane: Design. Branch `operator/launch-on-overview` off `main` @ `a58c78d`, in worktree
`~/.operator/worktrees/operator-666300`. Commit: `0ab91b0`.

## Decision implemented

On every app launch (cold start, relaunch after quit or update) the first screen is the project
gallery on its worktree overview tab. A renderer reload inside a running app (the stall watchdog's
hourly WebContent kill and respawn, a renderer crash, ⌘R in dev) still puts the user back where they
were.

## Telling a launch from a reload

- **Main process** (`electron/src/main/launch-kind.ts`): `createLaunchTracker()` answers `launch` to
  the first `claim()` and `reload` to every later one. `ipc.ts` holds one tracker at module scope, so
  there is one per main process, i.e. one per app run. It is exposed as the IPC `launchKind`
  (`operator-api.ts` SPEC; optional in `env.d.ts`).
  - The renderer cannot work this out alone: a reload starts it from nothing, with the same
    localStorage as a launch.
  - The main process lives for the whole run and sees every renderer start.
- **Renderer** (`src/renderer/lib/launch-kind.ts`): `launchKind()` asks once per document and memoises
  the promise.
  - React StrictMode runs effects twice in dev, and a second ask from the same document would turn a
    launch into a reload.
  - A reload re-evaluates the module, so the new document asks again and gets `reload`.
  - `unknown` when the shell has no answer (Tauri bridge, mocks, failed call, unexpected value).
    `unknown` keeps the old behaviour (restore), so a shell that cannot tell never hides the user's
    place.
- **Claimed early:** `DashboardView` calls `launchKind()` on mount, before the restore effect needs it.
  If the first renderer died between mount and restore, the respawn is still recognised as a reload.
- **Existing reload path kept:** when ptys survived a reload (`terminals.length > 0` after re-attach),
  nothing is restored, as before. That path does not ask, and does not need to.
- **Window close and reopen on macOS:** reopening creates a new renderer in the same main process, so it
  counts as a reload and restores where the user was. I think that is right, because the app did not
  relaunch, but it is a choice. It could be made a launch by resetting the tracker when a window is
  created.

## What a launch does (`launchLanding` in `src/renderer/lib/workspace.ts`, pure)

`launchLanding(kind, plan, lastProjectId, projectIds)` returns `{ view, galleryTab?, continueTo }`.

- **`launch`:**
  - `view` is the gallery (project null) with the plan's project tab kept, and `galleryTab: 'overview'`.
  - `continueTo` is where the plan would have put the user (project and tab, or a view such as
    Preferences or Agents).
  - If the plan itself is the gallery, `continueTo` is the last project instead (`Workspace.lastProjectId`,
    only if the project still exists).
  - Otherwise there is no Continue offer.
- **`reload` / `unknown`:** `view` is the plan, exactly as before, with no overview and no offer.
- **First run with no snapshot:** a launch opens on the overview; a reload restores nothing, as before.

## Everything else the snapshot restores is kept

- `planRestore` still runs unchanged. The lanes that were live are still carried as the pending
  offer, the per-project last agent is still seeded, and the "Where you left off" toast still names
  blocked lanes. On a reload the toast title is unchanged: "Picked up where you left off".
- **Auto-resume** (setting, default off) still resumes the last project's lanes on a launch, in the
  background. `handleRestoreSession` and `handleResumeProject` take `{ background: true }`, which
  spawns the lane and records it without setting the active terminal, session or project and without
  changing the view. The overview stays on screen.
- **Nothing kills or detaches a lane.** A cold launch has no live ptys, and landing on the gallery
  changes only which view is shown. The reload path with surviving ptys is untouched.

## "Continue in <place>"

- A header button in `ProjectGallery`: "Continue in **operator** →", in the same chrome as
  "+ Open folder", placed just before it. The place is in `--fg` and weight 600, and ellipsises past
  260px. "Continue in", the name and the arrow are separate non-wrapping spans, so the sentence
  cannot break.
- The label is `continueLabel()`: the project name, or Preferences / Global settings / Agents / Tuning
  for a view.
- Clicking applies the saved view (project, tab, view flags) and clears the offer. The offer is also
  cleared the moment the user goes anywhere other than the gallery.
- **Persisted:** the workspace snapshot now writes `lastProjectId` (the active project, else the
  pending Continue target, else the previous value). A launch spent entirely on the overview still
  offers the same project next time. The field is optional, so older snapshots read fine and
  `WORKSPACE_VERSION` is unchanged.

## Tests

- `electron/src/main/launch-kind.test.ts` (3): the first claim is the launch; later claims in the same
  run are reloads; a new run (new tracker) is a launch again.
- `src/renderer/lib/launch-landing.test.ts` (11):
  - a launch lands on the overview with Continue to where the user was;
  - a reload restores with no offer;
  - `unknown` equals a reload;
  - a launch after a launch on the overview offers the last project, and nothing when that project
    is gone or unset;
  - a view without a project is a Continue target;
  - the plan's lanes are untouched;
  - `continueLabel`;
  - `launchKind` asks once per document (StrictMode), a new document gets `reload`, and a missing,
    failed or garbage answer is `unknown`.

## Verification

- Renderer suite: 94 files, 1404 tests passed, 0 failed.
- Electron suite: 36 files, 649 tests passed, 0 failed.
- `tsc --noEmit` passes for the renderer project and `electron` `npm run typecheck`.
- Not verified in the GUI. Still to check in the app:
  - cold start lands on the overview with Continue;
  - quit and relaunch, and relaunch after an update, do the same;
  - a forced renderer reload (⌘R or the watchdog) inside a project returns to the project, with and
    without live lanes;
  - Continue restores the project and tab;
  - auto-resume on starts lanes without leaving the overview.
- Before the restore applies there is one render using the `operator.activeProjectId` localStorage
  seed. At launch the window is still hidden behind the ~1s splash while the restore settles (one
  IPC round trip plus hydration), so a flash of the old project is not expected. That is
  unmeasured.
