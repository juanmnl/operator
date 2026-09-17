# The global Environment tab is a doorway, not a dead end

2026-09-17 · branch `operator/eda0c0`

## What was wrong

`FolderPreferencesView` renders one tab list (`FOLDER_PREFS_TABS`) for both the project page and the
global page. In global mode `project` is `null`, so `EnvironmentSection` hit its early return and
printed:

> This view isn't scoped to a project, so there is no environment to set. Open a project's settings
> to edit its variables.

It named the next action and gave no way to take it. That sentence is what made per-project env look
like it wasn't per-project.

## What changed

Three files. No storage change, no resolution-chain change.

### `src/renderer/components/preferences/EnvironmentSection.tsx`

- Two optional props: `projects?: Project[]` and
  `onOpenFolderPrefs?: (path, name, tab?) => void`. Optional is the point — a project's own page
  passes neither and behaves exactly as before.
- The `project === null` branch now returns `<EnvironmentDoorway>` instead of the sentence.
- `EnvironmentDoorway` renders the `Environment` heading, one line of explanation ("Variables are
  set per project, and this page is not a project. Open one to edit what its lanes launch with." —
  with ` ` after the full stop and on the last pair), then a row per project inside the same
  bordered, radiused box the editor uses.
- Each row is a full-width `<button>` built from this file's `rowStyle`, `nameStyle` and
  `valueStyle`: project name, `tildePath(project.path)`, and the count on the right. Clicking it
  calls `onOpenFolderPrefs(project.path, project.name, 'Environment')`. Hover changes the
  background only (`--overlay-subtle`) — no border colour change on a radiused element.
- The count column reads `3 variables` / `1 variable`, or `none set` in `--fg-muted` when the
  project sets nothing. Flat tokens throughout; no opacity stacked on `--fg-muted`, no group
  opacity.
- `envDoorwayRows(projects)` is exported and pure: it maps each project to its entry count and
  sorts by count descending. `Array.prototype.sort` is stable, so projects with equal counts keep
  store order. Tombstone entries (`unset`) count — removing a variable for a project is something
  set there.
- No projects in the store = one line ("No projects yet. Open a folder in Operator and it gets an
  Environment tab of its own."), no framed empty box.

### `src/renderer/components/preferences/FolderPreferencesView.tsx`

Accepts the same two props as optional and forwards them to `EnvironmentSection`. Nothing else in
the view changed; `initialTab` already re-applies on `projectPath` change, so the deep link needed
no work.

### `src/renderer/views/DashboardView.tsx`

One render site (the `contentMode === 'globalPrefs'` branch, ~line 5000): added
`projects={projects}` and `onOpenFolderPrefs={handleOpenFolderPrefs}`. That is the only edit in this
file.

## Tests

`src/renderer/components/preferences/environment-doorway.test.ts`, 7 tests. It renders the real
component with `createRoot` + `act` and `createElement` (the suite collects `*.test.ts` only) —
the pattern already used by `src/renderer/components/session/preview-toolbar-icons.test.ts`.

- Global mode lists every project, and the old "isn't scoped to a project" sentence is gone.
- Clicking a row calls `onOpenFolderPrefs` with exactly that project's path, its name, and
  `'Environment'`.
- Counts render (`1 variable`, `none set`), the project that sets something sorts first, and a
  project with nothing set still opens when clicked.
- An empty store renders no rows and the one-line message.
- **Project-scoped mode is unchanged**: with `project` set, no doorway rows render, the variable
  editor and its `+ variable` control are there, the `~/.operator/projects.json` line is there, and
  a second project passed in `projects` does not appear on the page.
- `envDoorwayRows` directly: ordering, stability among equal counts, and that a tombstone counts.

`npx tsc --noEmit` clean. `npm test`: 100 files, 1462 tests, all passing.

## Left out, deliberately

- **GUI verification.** Not mine. The dev server on 1421 runs from the main checkout, not this
  worktree, so it would not show these changes anyway; I did not start a second one.
- **The stale comment above `handleOpenFolderPrefs`** in `DashboardView.tsx` (~line 3403) still says
  "Nothing passes it yet" about the `tab` argument. Something does now. I left it because the brief
  limited my DashboardView edit to the one globalPrefs render site, and Design is concurrently
  editing this file around origin tracking. Worth a one-line fix on whichever branch lands second.
- `PageShell.tsx` untouched, per the note about the parallel Design lane.
- `env-policy.ts`, the `EnvEntry` shape, and everything under `electron/src/main` untouched.
- Archived/shelved projects (`archivedAt`) are listed like any other. The brief asked for the user's
  projects, and hiding a shelved project from a list whose whole purpose is reachability would
  reintroduce the defect in a smaller form.
