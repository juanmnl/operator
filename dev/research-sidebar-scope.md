# How the sidebar scopes to `activeProjectId`

Research only — no code changed. Answers "map how the sidebar scopes to
`activeProjectId` today."

## Where scope lives

`activeProjectId: string | null` is state in `DashboardView`
(`src/renderer/views/DashboardView.tsx:133-135`), seeded synchronously from
`localStorage['operator.activeProjectId']`. `null` means "at the gallery,
outside every project"; a set id means "inside that project."

Persistence is a one-way mirror effect (`DashboardView.tsx:862-867`): every
change to `activeProjectId` is written back to the same localStorage key (or
the key is removed when it goes `null`). So the app reopens at whatever
project you were last scoped to.

## Who is allowed to change it

Exactly four call sites touch `setActiveProjectId`, each with a distinct
meaning:

| Setter | Where | Effect |
|---|---|---|
| `handleOpenProject(projectId)` | `DashboardView.tsx:385-396` | Enter a project: sets scope, resets `projectTab` to `'roster'` **only if the id actually changed** (re-entering the project you're already in keeps whatever tab you left on), clears every overlay flag (`prefsViewActive`, `agentsViewActive`, `globalPrefsActive`, `activeFolderPrefs`) and drops `activeSessionId`/`activeTerminalId` so Project Home can surface. |
| `handleShowGallery()` | `DashboardView.tsx:400-412` | The **only** path that clears scope (`setActiveProjectId(null)`). Also clears overlays/session and resets `galleryTab` to `'projects'`. Triggered by: the sidebar logo, the switcher's "All projects" row, and ⌘⇧O. |
| Validation effect | `DashboardView.tsx:872-875` | Backstop: once `savedHydrated`, if the restored `activeProjectId` no longer matches any project in `projects`, it's nulled back to the gallery. Gated on hydration specifically because `projects.json` loads async and checking earlier would drop a *valid* scope while `projects` is still the (possibly empty) localStorage seed. |
| Focus-implies-scope backstop | `DashboardView.tsx:881-891` | If a terminal gets focused (`activeTerminalId` changes) whose tab carries a `projectId` different from current scope, scope is force-adopted from the tab — but **only** if that project id still exists in `projects` (an `if (!projects.some(...)) return` guard prevents ping-ponging against the validation effect above when a tab is stamped with a forgotten project id). This exists because the pty re-attach after a webview reload can focus a session without going through any handler at all, which would otherwise leave scope disagreeing with the visible session. |

Notably, overlay-opening handlers (`handleOpenAgents`, `handleOpenPrefs`,
`handleOpenGlobalPrefs`, folder-prefs) explicitly do **not** touch
`activeProjectId` — the comment at `DashboardView.tsx:378-379` states this
is deliberate: those are views you visit *from* a project, so leaving them
returns you there.

## How scope turns into what the sidebar renders

Two memos derive the scoped world from `activeProjectId` + the raw
`projects`/session lists (`DashboardView.tsx:1425-1432`):

```
activeProject   = activeProjectId ? projects.find(p => p.id === activeProjectId) ?? null : null
scopedSessions  = activeProjectId ? allSidebarSessions.filter(s => s.projectId === activeProjectId) : []
```

These two values are what get passed as `project` / `sessions` to both
`<Sidebar>` (`DashboardView.tsx:2123-2162`) and the collapsed `<SidebarRail>`
(`DashboardView.tsx:2107-2121`) — same scoping, same source, so the two
sidebar presentations can't drift.

Two more derived values ride the same `activeProjectId` dependency:

- `shortcutTerminals`/`shortcutIndices` (`DashboardView.tsx:1507-1524`) —
  ⌘1-9 walks the *scoped* terminal list in the order the sidebar draws it
  (roster order for lanes, then ad-hoc), so the number shown on a row is the
  chord that reaches it.
- `projectActivities` (`DashboardView.tsx:1435-1444`) is **not** scoped — it
  rolls up *every* project's sessions (keyed by `projectId`) for the
  switcher popover's per-row orb/label, independent of which project is
  currently active.

`contentMode` (`DashboardView.tsx:1884-1898`) is the single router deciding
what fills the content area; `activeProjectId` is its lowest-priority
positive case: `'project'` (→ Project Home) fires only if nothing else
(prefs/agents/globalPrefs/folderPrefs/a live focused terminal) claims
priority AND `activeProjectId` still resolves in `projects`. With no scope
and nothing else active, it falls through to `'gallery'`.

## Sidebar itself is a pure view over scope

`Sidebar.tsx` (`src/renderer/components/sidebar/Sidebar.tsx`) takes
`project: Project | null` and `sessions: AgentSession[]` as already-scoped
props — it does no filtering by `activeProjectId` itself (there is no such
prop). Per its header comment (lines 14-22), this is intentional: the
sidebar is a project-scoped *view*, never a cross-project accordion (that
was the old `FolderGroup`/"Recent" list, since removed). Its list is:

- **Lane rows**: `project.roster` roped 1:1 against any live session
  matching `roleId` (`byRole` map keyed off `sessions`), so a lane renders
  live (`SessionItem`) or idle (`LaneRow`, click = launch).
- **Ad-hoc rows**: any scoped session with no `roleId`, listed underneath
  under an "Other" divider — sessions launched outside any lane.

The switcher popover (`ProjectSwitcher.tsx`) is the one place inside the
sidebar that sees *all* projects (`projects: Project[]` prop) — it's how you
jump scope without detouring through the gallery. It marks the current row
(`p.id === activeProjectId`) with an accent name + "home" tag and sorts
live-first-then-recent.

## Legacy / unscoped sessions

Sessions launched before a `projectId` existed on the session shape carry no
`projectId` and are therefore invisible to `scopedSessions` no matter what
`activeProjectId` is — they belong to no scope. `DashboardView.tsx:893-916`
resolves each such terminal's cwd to a canonical project once
(`resolveProject`, deduped via `resolvingCwdsRef`), registers/upserts that
project, and stamps the tab with the resolved `projectId` — after which it
naturally starts appearing under that project's scope like any other
session. If the cwd is unresolvable (folder gone) or the project was
explicitly "forgotten" this run, it's left unscoped and stays reachable only
from the gallery's cross-project activity view.

## Summary / trap list (for anyone editing this area)

1. **One state, one localStorage mirror, four writers** — don't add a fifth
   ad hoc `setActiveProjectId` call; route through `handleOpenProject` /
   `handleShowGallery` or extend the two backstop effects.
2. **Validate only after `savedHydrated`** — checking earlier drops a valid
   restored scope against the still-empty seed.
3. **The focus-backstop and the validation effect are two halves of one
   guard** — both anchor to "is this id currently in `projects`" so neither
   fights the other forever.
4. **Overlay views deliberately preserve scope** — don't "helpfully" clear
   `activeProjectId` when wiring a new overlay/settings surface.
5. **`Sidebar`/`SidebarRail` have no scoping logic of their own** — they
   render whatever `project`/`sessions` they're handed; all scoping lives in
   `DashboardView`'s `activeProject`/`scopedSessions` memos. If the sidebar
   ever shows the wrong project's rows, look upstream at those memos and at
   `activeProjectId`, not inside `Sidebar.tsx`.
6. **`projectActivities` is intentionally unscoped** (all projects) — don't
   confuse it with `scopedSessions` when debugging a wrong-looking orb.

## Files read

- `src/renderer/views/DashboardView.tsx` (state decl, persistence effect,
  validation effect, focus backstop, legacy-session resolution,
  `activeProject`/`scopedSessions`/`shortcutTerminals`/`projectActivities`
  memos, `contentMode`, `<Sidebar>`/`<SidebarRail>` render call sites)
- `src/renderer/components/sidebar/Sidebar.tsx` (props contract, roster vs
  ad-hoc row derivation)
- `src/renderer/components/sidebar/ProjectSwitcher.tsx` (cross-project list,
  current-row marking)
- Memory: `project_project_first_navigation.md` (prior design decisions,
  confirmed still accurate against current code)
