# Home overview: projects and their worktrees — 2026-09-16

Lane: Design. Branch `operator/home-overview` off `main` @ `bb58059`, in worktree
`~/.operator/worktrees/operator-666300`. Commits: `0eb483d` (overview), `a58c78d` (chip hidden
until there is a worktree).

## Verification

- Renderer suite: 93 files, 1393 tests passed, 0 failed.
- Electron suite: 35 files, 646 tests passed, 0 failed.
- `tsc --noEmit` passes for the renderer project and `electron` `npm run typecheck`.
- Not verified in the GUI. Still to check in the app: the chip, the table in both themes, a narrow
  window (rows wrap), the skeleton on a cold start, and the Worktrees deep links.

## What launch shows today, and where this goes

`DashboardView`'s `contentMode` falls through to `gallery` when no lane is focused and no project is
in scope. That is `ProjectGallery`, the launcher, with a `Projects` view (cards) and an `Activity`
view opened from the "N agents at work" chip. Relaunch restores the last project when there was one
(workspace snapshot), and in that case the gallery is not the first screen.

The overview is added to that surface, not beside it:

- **Header chip** next to "agents at work": `55 WORKTREES · 34.0 GB`, with a small filled warning dot
  when any folder has unsaved work. It is hidden while there are no worktree folders. It toggles the
  new tab and sits in the same place and style as the existing rollup chip.
- **Third gallery tab `overview`** (`GalleryTab = 'projects' | 'activity' | 'overview'`). The header's
  back button ("‹ Projects · N") works for it like it does for Activity. The tab resets to `projects`
  at the same point it already did.

## The overview (`components/dashboard/WorktreeOverview.tsx`)

- **Total line:** "On this machine: 55 worktrees · 34.0 GB · 6 outside any project", then the flag
  chips for the whole machine, a status ("Reading folders…" / "Checking git in each folder…" /
  "Sizes are from the last measurement."), and **Refresh**.
- **One row per project** that has worktrees, running lanes or suspended sessions, largest first
  (size, then worktree count, then name). Projects with none of those are summed in one closing line
  ("3 other projects have no worktrees and no lanes").
  - Name, plus the tilde path (or "folder not on record" for a project with no path).
  - Lanes: `2 running · 1 suspended`, or `No lanes`.
  - Worktrees: `5 worktrees · 1.2 GB`; `≥` when some sizes are not measured yet, `size pending` when
    none are.
  - Flags, as transparent bordered chips with the colour on the text only:

    | Flag | Colour |
    |---|---|
    | `N unsaved` | warning mixed 50% into `--fg` |
    | `N unreadable` (git could not tell) | control ink |
    | `N auto` (would be removed automatically) | control ink |
    | `N source repo gone` | error mixed 50% into `--fg` |

    The total line spells `auto` out as "would be removed automatically". Every chip has a tooltip
    sentence.
  - Actions: **Open** (enters the project), **Settings** (Project settings), **Worktrees** (Project
    settings opened on the `Worktrees` tab through `handleOpenFolderPrefs(path, name, 'Worktrees')`).
    Settings and Worktrees are disabled when the project has no path, and Worktrees when it has no
    worktrees.
- **"Outside any project" row:** folders whose source repo matches no project, or which name none.
  Its line says how many repositories they come from (the paths are in the tooltip). **Worktrees**
  opens Global settings on the `Worktrees` tab: `handleOpenGlobalPrefs` now takes an optional tab,
  and the global view passes it as `initialTab`.
- **Read-only.** Nothing on this surface removes anything. Removal stays on the Worktrees page with
  its confirmations.
- **States:**
  - first load: three static skeleton rows (no motion, because motion means an agent is busy);
  - read error: a sentence with the error;
  - empty: "No projects and no worktrees on this machine yet." or "No worktrees and no lanes in any
    project right now.";
  - loading and refreshing: the status text and a disabled "Refreshing…".
- **Narrow window:** each row is a wrapping flex line (name 220px basis, two 150px stat columns,
  flags, actions pushed right), so it drops to two or three lines rather than scrolling sideways.
  The total line wraps too.
- **Words:** every sentence built in code binds its last two words with a non-breaking space
  (`bindLast`). Chips and stats are `nowrap`.
- **Tokens:** `--fg`, `--fg-muted` (never with opacity), `--border`, `--overlay-subtle/medium`,
  `--color-warning`, `--color-error`, and the 72% `--fg` control ink. Nothing hardcoded, so it works in
  both light and dark themes.

## Data: never waiting on git or du

| Step | Source | Cost | Gives |
|---|---|---|---|
| 1, at mount | new IPC `worktreeQuickList` → `quickWorktreeList()` in `worktree-reap.ts` | one `readdir`, `worktree-provenance.json`, `sessions.json`, `worktree-sizes.json`, one small `.git` file read and one `existsSync` per folder. No git, no `du`, no `stat`. | folder → source repo, repo exists, lane claim, cached size |
| 2, 1.5s later | existing `worktreeReapPlan({ refreshSizes: false })` | git per folder; `du` only for folders whose mtime moved (the existing cache) | unsaved work, unreadable, would-remove, fresh sizes |

- `lib/worktree-overview-data.ts` holds the reading at module level, so coming back to the launcher
  shows the last reading at once. A reading younger than 60s is not re-fetched on mount, and
  **Refresh** always re-fetches.
- A newer load supersedes an older one: late results are dropped.
- A refresh keeps the last git flags on screen while the folders are re-read, instead of blanking
  them.
- The 1.5s delay keeps step 2 from competing with the boot's own report-only auto-removal check,
  which runs the same git calls.
- The Tauri bridge and mocks without the call settle at once with nothing.
- The quick step's cached sizes are not re-checked against mtime (that is the plan's job). Until step
  2 lands the header says "Sizes are from the last measurement."

## Grouping (`src/shared/worktree-overview.ts`, pure)

- `fromQuick` / `fromPlan` normalise both sources to `OverviewWorktree`. `fromPlan` takes `repoExists`
  from the quick list, because the plan's `dead-source-repo` class depends on precedence (live and
  debris win).
- `summarizeOverview({ projects, worktrees, sessions, suspended, detailed })`:
  - A worktree belongs to the project whose `path` equals its source repo (provenance, else the
    `.git` pointer), with trailing slashes ignored.
  - Everything else goes to `unknown`, along with the distinct repos it names.
  - A project with no path never matches.
  - Running lanes: non-ended sessions by `projectId`.
  - Suspended: resumable saved sessions (`restorableSessions`, now carrying their `projectId`). They
    are matched by `projectId`, else by working directory being the project, inside it, or one of
    its worktrees.
  - Flag counts per project, unknown bucket, and total. A folder is counted unsaved or unreadable,
    never both. `bytesPartial` marks a floor.
  - `detailed` says whether the git flags are in, so the quick paint never shows "0 unsaved". Before
    step 2 only "source repo gone" is shown, because it needs no git.

## Tests

- `src/shared/worktree-overview.test.ts` (15):
  - grouping by source repo with trailing slashes;
  - the unknown bucket (unmatched repo, no repo, a lost project cannot absorb them, repo list, dead
    count, bytes);
  - row order;
  - every flag, and unsaved vs unreadable exclusivity;
  - partial sizes and `detailed` passing through;
  - running and suspended lanes (by path, inside, by worktree, by projectId);
  - `fromQuick` / `fromPlan`, cached size fallback, `formatBytes`.
- `src/renderer/lib/worktree-overview-data.test.ts` (5): quick paint first and git only after the
  delay; flags kept during a refresh; a stale plan is dropped; no bridge call settles empty; a read
  error is reported.
- `electron/src/main/worktree-quick-list.test.ts` (1): a real temp tree with a `.git` pointer to an
  existing repo, one to a deleted repo, a provenance-only folder, a bare folder and the trash dir.
  It checks the trash is skipped, and the repo, existence, lane claim and cached size of each.

## Open

- GUI check (above).
- When relaunch restores the last project, the gallery and therefore the overview are one click
  away ("All projects", ⌘⇧O), not the first screen. Changing the restore rule is outside this brief.
- The quick step trusts `sessions.json` for lane claims, the same floor the reaper already documents.
