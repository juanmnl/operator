# A way back out of every PageShell page

Branch `operator/ba0200`. `npm test` green (100 files, 1481 tests), `tsc --noEmit` clean,
`npm run build` clean. Not GUI-verified — that is the user's.

## The defect

The five full-page views (`folderPrefs`, `globalPrefs`, `prefs`, `agents`, `tuning`) wear
`PageShell` inside `AppShell`, whose 44px header carries only the sidebar toggle. No back control,
no breadcrumb. The launcher's worktree overview links straight into two of them — the per-project
"Worktrees" row action and the "Outside any project" row — and the overview is the screen every
launch opens on, so the Worktrees tab was a room with no door. The only escape was `ProjectRail`'s
"All projects" foot item, which is an icon at the bottom of a strip that may be collapsed to 60px,
and it lands on the projects list rather than on the tab you left.

## What the control is

Above the page title, sharing its left edge:

```
‹ Worktree overview
Global settings
~/.claude · applies to every project
```

The label is the origin's **own name**, never a fixed "All projects" and never a close ✕. Absent
origin renders **no control at all**.

## What changed

### `src/renderer/lib/nav-origin.ts` (new, pure)

The decision, testable without a renderer.

- `NavOrigin extends ContinueTarget` — reuses lib/workspace's "a view you can return to" rather
  than inventing a second one, plus the three facts a back control needs and a launch offer never
  did: `galleryTab`, `folderPrefs` (present = the per-project settings page; `mode` is `'prefs'`
  for both it and Operator preferences, so presence is what tells them apart), `globalPrefsTab`.
- `describeOrigin(viewState)` — the view on screen as a place, or `null`.
- `originLabel(origin, projects)` — the words, or `null` when the destination no longer exists.
- `originKey(origin)` — one string per place.
- `pushOrigin(stack, origin, targetKey)` — a short chain (max 8), not one slot.
- `isPageMode` / `PAGE_MODES` — the five modes that wear PageShell.

A **chain** rather than a single slot because the rail's foot reaches Preferences, Global settings
and Agents from any of them: `gallery → prefs → globals` is an ordinary path, and one slot would
leave those two pages each claiming to be the other's origin. `pushOrigin` handles the three cases
that keep it honest: no origin → the chain is dropped; re-entering the page you are on → nothing
moves; navigating to a page already in the chain → the chain unwinds to it instead of looping.

### `src/renderer/components/settings/PageShell.tsx`

- `PageBack { label, onBack }`, a `PageBackContext`, and `PageBackProvider`.
- `BackToOrigin` — `‹ <label>`, rendered from the shell's own header block above the `<h2>`, so
  all five pages inherit it. Not bolted onto FolderPreferencesView.
- Delivered by **context**, not a prop through four view components: the pages do not know where
  they were opened from, only the router does, and threading a prop through `PrefsView`,
  `AgentsHubView` and `TuningView` so each could forward it unread is four chances to forget one.
- A `back` prop overrides the context (`null` suppresses, `undefined` defers) — for tests and for
  a page that knows its own origin.

### `src/renderer/lib/chrome.ts`

`BACK_BTN` — the gallery header's back-button chrome, now a single definition. `ProjectGallery`
imports it (its local `backBtn` const is gone), so the two controls cannot drift.

### `src/renderer/views/DashboardView.tsx`

- `originStack` state + `currentViewRef` + `recordOrigin(targetKey)`, declared above the entry
  handlers. The ref is written from an effect on a `describeOrigin` memo, so a click handler reads
  where the user **was**, not where this render is taking them — and the five entry handlers stay
  the stable `useCallback`s they were built as.
- `recordOrigin(...)` called first in `handleOpenGlobalPrefs`, `handleOpenAgents`,
  `handleOpenTuning`, `handleOpenPrefs`, `handleOpenFolderPrefs` (keyed by path, so opening
  project B's settings from project A's is a step, not a re-entry).
- Cleared by an effect the moment `contentMode` is not a page mode — same shape as the existing
  `continueTarget` reset.
- `pageBack` memo → `PageBackProvider` wrapping the whole tree (one provider; a provider per mode
  branch is five places to forget one).
- **`applyView` extended and fixed.** It now takes a `NavOrigin`, restores `galleryTab` when the
  target names one, and clears `activeFolderPrefs`, `activeSessionId` and `activeTerminalId`.
  That last part was a real bug in the existing function: `activeFolderPrefs` outranks every flag
  it set in `contentMode`, so returning from the per-project settings page would have set six
  states and changed nothing on screen. A stale terminal id would likewise have pulled a
  `'project'` landing into `localTerminal`.

### `src/renderer/components/preferences/FolderPreferencesView.tsx`

The `!prefs` loading state now renders inside `PageShell` (title, subtitle, tabs, back control)
instead of a bare centred "Loading…". A loading state with no back control is the same door-less
room for as long as the read takes, and the header no longer jumps into place when the files land.

## Origins covered

| Origin | Label | Restores |
|---|---|---|
| Gallery, overview tab | `Worktree overview` | gallery + that tab |
| Gallery, projects tab | `All projects` | gallery + that tab |
| Gallery, activity tab | `Activity` | gallery + that tab |
| Project home | the project's name | project + the tab you were reading |
| Operator preferences | `Preferences` | the page |
| Global settings | `Global settings` | the page + the tab it was on |
| Per-project settings | `Project settings · <name>` | the page, that folder, that tab |
| Agents hub | `Agents` | the page |
| Tuning | `Tuning` | the page |

Gallery origins deliberately drop project scope: `activeProjectId` survives a visit to Preferences
by design, so it can still be set while the gallery is on screen, and returning there must not
re-enter a project the user had left.

## Not covered, and why

- **A focused lane (`localTerminal`) is never an origin.** Open a settings page from the rail while
  a lane is focused and that page renders no back control. A `NavOrigin` cannot name a pty, and
  falling back to "the project it belongs to" would be a guess: you would press a control labelled
  with a project name and land somewhere you had not been. Rule 5 says never a control that
  guesses, so: none. Covering it properly means teaching the origin record about terminal ids,
  which is a larger change than this brief.
- **A reload and a launch-plan restore have no origin** — by design, per rule 5.
- **Going back does not leave a forward trail.** Back from Global settings to Preferences pops the
  entry; Preferences then shows whatever is left under it (the gallery, in the common path).
- **The chain is capped at 8** and is in-memory only — it is not written to the workspace snapshot,
  so a reload starts clean.

## House rules checked

- No group opacity, no opacity stacked on `--fg-muted` (`muted-opacity.guard.test.ts` green).
- The back button's border colour is **fixed**; hover changes the background only — no
  colour-changing border on a radiused element.
- No orphaned word: the label cannot wrap (`white-space: nowrap`, ellipsis past 320px), and
  `Project settings · <name>` keeps the non-breaking spaces `folderPrefsTitle` uses.
  A new test holds `originLabel` and `folderPrefsTitle` to the same wording, so a back control can
  never rename its own destination.
- **Two verbs never share a glyph**: `‹` means "go back" in all four files that type it
  (`ProjectGallery`, `SessionToolbar`, `ProjectView`, `PageShell`) and nowhere else. A guard test
  asserts exactly that list, reading source with comments stripped.

## Tests added

`src/renderer/lib/nav-origin.test.ts` — 25 tests: `describeOrigin` per mode (including the three
nulls), `originLabel` per origin (including the forgotten-project null and the nbsp binding),
`pushOrigin` (record, chain, unwind, re-entry, no-origin, cap), `originKey`, plus a source-read
guard block for the wiring this repo has no renderer harness to exercise: PageShell owns the
control, `DashboardView` provides it exactly once, no page rolls its own, and the chevron guard.

`src/renderer/components/preferences/folder-prefs-title.test.ts` — one test tying `originLabel`'s
folder-settings wording to `folderPrefsTitle`.
