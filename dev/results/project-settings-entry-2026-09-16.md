# Project settings entry — 2026-09-16

Lane: Design. Branch `operator/project-settings-entry` off `main` (c463d90), in worktree
`~/.operator/worktrees/operator-666300`. Commit: `9f82fde`.

## Problem

The only way into a project's settings (`FolderPreferencesView`: Instructions, Permissions, General,
Hooks, Plugins, Environment, Skills, Worktrees) was a rail foot item labelled `.claude`, with a folder
glyph, folded behind the foot's disclosure. The user looked for where to set a project's
`RAILWAY_TOKEN` and did not find the Environment tab. `.claude` names a folder, not what is inside
it, and Environment is not in `.claude` at all: it is Operator's own per-project record in
`projects.json`.

## Changes

### Rail foot (`ProjectRail.tsx`)

| | Before | After |
|---|---|---|
| Project label | `.claude` (mono) | `Project settings` |
| Project glyph | folder | sliders (three tracks with hollow knobs) |
| Project tooltip / accessible name | `operator Claude files (.claude) (this project)` | `Settings for operator (.claude, environment, worktrees)` |
| Global label | `~/.claude` (mono) | `Global settings` |
| Global glyph | globe | globe (unchanged) |
| Global tooltip | `Global Claude files (~/.claude) (every project)` | `Global settings (~/.claude, every project)` |

- **Why `Global settings` and not `Settings · all projects`.** `All projects` is already the label of
  the gallery item two rows up in the same foot. Two foot items sharing words for different verbs is
  the confusion this change is meant to remove. `Project settings` / `Global settings` read as the
  same thing at two scopes, and the path `~/.claude` stays in the tooltip for people who know it.
- **Why sliders.** The gear is already `Preferences` (Operator's own settings) in the next row, and
  the folder reads as "open folder". Two verbs never share a glyph. The knobs are hollow, with the
  track broken around them rather than filled with `--bg-sidebar`, so the hover tint cannot show a
  filled disc.
- **Fit.** Labels were measured in Archivo (the bundled `archivo-latin.woff2`, default weight) at 11px:
  `Project settings` 79.2px, `Global settings` 76.4px. The label slot of an expanded foot cell is
  264 − 2×9 padding − 4 gap = 246 / 2 = 123 per cell, minus the 24px glyph box and 6px gap, which is
  about 91px. Neither label ellipsises. For comparison, `Preferences` measures 61.8px.
- **Collapsed rail.** There are no labels there; the cell is the glyph. The tooltip and accessible
  name carry the words above, so the collapsed strip reads "Settings for <project>" on hover.
- The two items are still folded behind the foot's disclosure. Moving them to the resting tier is a
  separate decision about `lib/rail-foot.ts`'s tiering, which I did not change. The ⌘K route and the
  project menus below are what make settings findable without unfolding.

### Page header (`FolderPreferencesView.tsx`)

- Project title: `Project settings · <name>`, built by `folderPrefsTitle()`. The `·` is bound to both
  neighbours with non-breaking spaces, so a narrow pane cannot leave the project name alone on a second
  line.
- Global title: `Global settings`. Subtitle: `~/.claude · applies to every project`, with the last two
  words bound. The project subtitle stays the project path.
- `EnvironmentSection`'s note in the global view now says "Open a project's settings to edit its
  variables" (was "Claude files").

### Menus and ⌘K

- The rail project context menu (`railMenuItems` in `DashboardView.tsx`) says `Project settings…`
  (was `Project Claude files`).
- The gallery card menu and the Previous-row menu (`ProjectGallery.tsx`, 2 places) say
  `Project settings…`.
- ⌘K: `Edit settings for <name>` → `Project settings · <name>`; `Global Claude files` →
  `Global settings (~/.claude)`.

### Opening on a tab (for later deep links)

- `FolderPreferencesView` takes `initialTab?: FolderPrefsTab`. It is used as the starting tab and
  applied again when a different tab or project is asked for. `FOLDER_PREFS_TABS` and
  `FolderPrefsTab` are exported.
- `handleOpenFolderPrefs(projectPath, projectName, tab?)` stores the tab with the active view and
  passes it through.
- Nothing passes a tab yet, as asked. A later "set env for this project" link would call
  `handleOpenFolderPrefs(path, name, 'Environment')`.

### Dev drivers

`drive-settings-template.mjs` and `drive-theme-pass.mjs` located these controls by `button[title=…]`
with the old titles. Those were already stale, because a FootItem's title is `<name> (<hint>)`. They
now use `[data-rail-folder-prefs]` / `[data-rail-global-prefs]` / `[data-rail-prefs]`.
`drive-rail-invariant.mjs` has its display names updated. `drive-app-menu.mjs` still targets the
retired `data-sidebar-foot-btn` sidebar and was left alone.

## Verification

- Renderer suite: 85 files, 1311 tests passed, 0 failed (4 new in
  `components/preferences/folder-prefs-title.test.ts`: the project title and its binding, the nameless
  and global titles, the subtitles, and that an Environment tab exists).
- `tsc --noEmit` passes.
- Not verified in the GUI and the drivers were not run. Still to check in the app: the sliders glyph
  beside the globe and the gear at 12px in both themes, the expanded labels not ellipsising, the
  collapsed tooltips, and the page title at a narrow pane width.
