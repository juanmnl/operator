# Project-first navigation — design spec

**Status:** design agreed 2026-07-27, not yet implemented. Code implements from this doc.
**Goal (user's words):** *"I open Operator, projects sit there, I select one, select the team, open the session(s)"* — instead of piling sessions from every project into one permanent sidebar accordion.

**What this is not:** new data plumbing. Projects are already durable (`roster`/`tasks`/`dispatches` on `Project`, `~/.operator/projects.json`; moodboard on disk). This is an IA/navigation rework on top of what exists. `ProjectView` + `RosterPanel` are **reused as-is**, not rebuilt.

---

## 1. The state model (the whole change in one idea)

Today `projectView: {id, tab} | null` does two jobs at once: *which project's workspace is open* **and** *show the workspace instead of a session*. Every view-switch handler nulls it, so scope is destroyed whenever you open Preferences or focus a session. Split it:

```ts
// DashboardView.tsx
const [activeProjectId, setActiveProjectId] = useState<string | null>(…)  // WHERE YOU ARE. Durable.
const [projectTab, setProjectTab] = useState<'roster' | 'moodboard'>('roster')
```

* `activeProjectId === null` → you are **at the gallery** (outside every project).
* `activeProjectId` set → you are **inside that project**; the sidebar is scoped to it, and it stays set while you visit Preferences / Usage / Agents / a session. Only three things clear it: the switcher's "All projects", the logo, and `⌘⇧O`.
* Persist to `localStorage['operator.activeProjectId']`; on launch, restore it (falling back to the gallery if the project id is gone from the store). **Relaunch lands you back inside your last project, at Project Home.**

`contentMode` (currently `DashboardView.tsx:1692`) gains `gallery` and loses the session-vs-project coupling:

| condition | contentMode |
|---|---|
| prefs / usage / agents / folderPrefs / globalPrefs active | unchanged (those win) |
| `activeTerminalId` set | `localTerminal` |
| `activeProjectId` set | `project` |
| otherwise | `gallery` |

The old `splash` mode disappears: with no project it becomes `gallery`, and with a project it becomes `project`.

**Handler changes (`DashboardView.tsx:371-409`):** `handleOpenPrefs`/`handleOpenAgents`/`handleOpenUsage`/`handleOpenGlobalPrefs`/`handleOpenFolderPrefs` must **stop calling `setProjectView(null)`** — they keep the scope so closing them returns you inside your project. `handleShowDashboard` becomes `handleShowGallery` (`setActiveProjectId(null)` + clear everything else).

---

## 2. Three surfaces

### A. Gallery (launcher) — `contentMode === 'gallery'`

Full-bleed inside the content card; **no sidebar and no rail**. This is what makes "outside a project" unmistakable.

> ⚠️ The rail is what currently keeps content clear of the macOS traffic lights. With it gone, the gallery's own header row must reserve that space: `DragRegion`, height 52, `paddingLeft: 84`, so the title starts right of the lights.

```
╭──────────────────────────────────────────────────────────────────╮
│        Projects · 4          [ 5 agents at work ]   + Open folder│  ← DragRegion h52, padL 84
├──────────────────────────────────────────────────────────────────┤
│ ┌───────────────────────┐ ┌───────────────────────┐ ┌──────────┐ │
│ │ operator          3 ● │ │ operator-landing      │ │ vault    │ │
│ │ ~/Developer/operator  │ │ ~/Developer/landing   │ │ ~/Notes  │ │
│ │                       │ │                       │ │          │ │
│ │ ◉ ◐ ◉ ○ ○ ○           │ │ ○ ○ ○ ○               │ │ ○ ○ ○    │ │
│ │ 2 queued · 4m ago     │ │ 3 queued · 2d ago     │ │ 3w ago   │ │
│ └───────────────────────┘ └───────────────────────┘ └──────────┘ │
╰──────────────────────────────────────────────────────────────────╯
```

* **Grid:** `repeat(auto-fill, minmax(300px, 1fr))`, `gap: 14`, page `padding: 4px 24px 28px`, `maxWidth: 1100`, `margin: 0 auto`. (Was 260/10 — too narrow a measure for a description, and cards 10px apart read as one grey mass.) Card `padding: 15px 17px`.
* **Card:** `border: 1px solid var(--border)`, `borderRadius: var(--radius-md)`, `background: var(--overlay-subtle)`, `padding: 12px 14px`, `cursor: pointer`. Hover changes **background only** → `var(--overlay-medium)`. *Never animate/change the border colour on a radiused element (WKWebView freeze rule).*
* **Card = three blocks** (recomposed 2026-07-27 — it was five near-equal rows at `gap: 7`, a flat stack with no entry point). The card's `gap: 12` separates the blocks:
  1. **Headline** — the name (`14px/600 --fg`, ellipsis + `title`) and *what it's doing*, nothing else, so the eye lands on the name when scanning a grid. State is in WORDS via `projectActivityLabel`: `1 needs you` › `3 running` › `6 lanes`. **"Needs you" outranks "running"** — if a lane is waiting on the user that's the thing to say, even while others work, and the old bare `3 ●` couldn't say it at all. Accent ink is reserved for activity; a merely-existing roster stays muted. `⋯` menu on hover.
  2. **Description** — `project.contextNotes`, `11.5px/1.5` in the body face (prose, not meta) at `color-mix(in srgb, var(--fg) 72%, transparent)`; plain `--fg-muted` measured 3.7–4.1:1 on the light palettes, under the 4.5:1 body bar. Clamped to 2 lines so one long note can't set the height of every card in its grid row. When absent the slot holds a hover-only `+ Add a description` — the footer's `marginTop: auto` has already reserved that height, so the prompt costs no layout shift and turns a conspicuous void into an invitation (invisible at rest: a gallery of placeholders would be noise).
  3. **Footer** — above a hairline, `marginTop: auto` so footers align across cards of differing content. Two tiers: the **team** (lane orbs left — one `StatusWave size={14}` per roster lane, live ones carrying their `sessionWaveStatus`, cap 8 + `+N` — with `N queued` right), then the quiet **reference line**: `~/path · 4m ago`.

* **The path moved down** into that reference line. `~/operator` under `operator` restated the title in mono and spent the card's best row doing it; the description earns that slot instead. The `lost` chip takes the path's place in the reference line.

* **Editing the description:** `⋯` → *Add/Edit description* swaps the block for a 3-row textarea in place. ⌘/Ctrl+Enter or blur commits (trimmed — whitespace-only clears the field), Escape reverts. `editingNotes` is held by the gallery, not the card, so opening a second editor closes the first; while it's open the card's own click/Enter must not open the project.
* **Ordering:** projects with live sessions first, then `lastActiveAt` desc.
* **Rollup chip** (header, only when >0 live): reuses `RollupChip` styling from `AgentsHubView.tsx:176`. Click → the existing **`ActivityDashboard`** unchanged, as a `gallery`-level sub-view (`galleryTab: 'projects' | 'activity'`). It stays the one legitimate cross-project read — you're at launcher level, not inside a project.
* **`+ Open folder…`** → `pickFolder()` → `openFolderAsProject()` (already exists, `DashboardView.tsx:480`) → enters the new project.
* **Card context menu / `⋯` on hover:** Rename, Reveal in Finder, Project Claude files (`onOpenFolderPrefs`), Forget project.

### B. Project Home — `contentMode === 'project'`

`ProjectView` (Agents tab = `RosterPanel` + `TaskQueue` + `DispatchLog`; Moodboard tab).

**The Agents board splits by liveness** (2026-07-27). A full `RoleCard` is how the board answers *"who's working right now"*, so only a **live** lane earns one. Every project is seeded with `defaultRoster()`, so rendering all six as cards meant a brand-new project opened on a wall of identical idle boxes — the team reading as dormant rather than ready.

* **`Live · N`** — the existing card grid, live lanes only.
* **`Ready · N`** — one `LaneRow` per idle lane (`ROW_H` 34): grip · accent dot · name · **pinned `Model · Effort` (+ `worktree`)** · queued chip · `⌄` · `Launch →`. The config stays visible because "what is this lane" is the reason to pick one when they're all just rows. Six idle lanes cost ~230px instead of ~400px+ of cards.
* The list ends with **`+ Add agent`** at the *same height and weight* — the low-emphasis pattern these rows extend, rather than a new vocabulary.
* `⌄` swaps the row for the **same `RoleCard`** in place (`onCollapse` returns it), so editing a lane has exactly one implementation — no parallel compact editor to keep in sync. One expanded at a time.
* Everything the card carried survives: click-row-to-select still drives the header's `Launch N →`, drag still reorders the one linear roster (vertical midpoint in the list, horizontal in the grid), right-click the dot still recolours.

> Naming: **"Ready"**, not "Idle" — these are launchable lanes, and framing them as dormant is the exact complaint this change answers.

Two small edits to `ProjectView` itself:

* Its header gains a leading **‹ back-to-gallery** chevron before the project name (12px, `var(--fg-muted)`), so the drill-in has a visible way out even when the sidebar is collapsed.
* `onSelectTab` writes `projectTab` instead of patching `projectView`.

This *is* the "select the team" step the user already has. Do not rebuild it.

### C. Session — `contentMode === 'localTerminal'`

Unchanged (`SessionToolbar` + Console·Chat·Preview overlay + Plan·Diff panel). The only difference is the sidebar beside it.

---

## 3. The scoped sidebar

`Sidebar.tsx` is filtered to `activeProjectId` and loses its accordion. **`FolderGroup` is deleted** — with one project in view, the group wrapper, its disclosure, its drag-reorder-between-groups and its "Recent" section all have no job left. That's a real simplification, not just a filter.

```
╭──────────────────────────╮
│ ◉  operator          ⌄   │  ← switcher (h≈44, paddingTop 40 for traffic lights)
│    ~/Developer/operator  │
├──────────────────────────┤
│ AGENTS                +  │
│  ◉ OPERATOR      running │  live  → focus session
│  ◐ RESEARCH   compacting │
│  ◉ DESIGN      your turn │
│  ○ Code            idle  │  idle lane → launch it
│  ○ Review          idle  │
│  ○ QA              idle  │
├──────────────────────────┤
│ 3 active                 │
│ ＋  🤖  📊  ⚙︎  ☾          │  footer unchanged
╰──────────────────────────╯
```

**Header = project switcher.** `LogoMark size={16}` (click → gallery, `title="All projects"`) + project name `13px/500 var(--fg)` + `⌄`. Whole row opens the switcher popover. The app name + version move to the footer row beside the stats (`Operator v0.9.1`, `10px`, `--fg-muted`) — they no longer earn the header now that the header carries *where you are*. Path line `9px mono muted`, ellipsis, `title` = full path.

**AGENTS list = roster lanes ∪ live sessions**, in roster order:
* A lane **with** a live session → `StatusWave` from `sessionWaveStatus(session)`, name in `laneTextColor(role.accent)` uppercase/tracked (existing `SessionItem` treatment), phase word per the current `showPhase` rules. Click = focus. Reuse `SessionItem` verbatim.
* A lane **without** one → hollow/static orb (`StatusWave status="idle" accent={role.accent}`), name `12px` in `color-mix(in srgb, var(--fg) 80%, transparent)` **not uppercase-accented** (matches `PassiveCard`, `AgentsHubView.tsx:235`), trailing `idle`. Click = `onLaunchRole(project, role)`. Never recede the row with group `opacity`.
* Sessions with **no `roleId`** (ad-hoc launches) list below the roster under a thin `SubHead` rule, live-only.
* `+` in the section header → Project Home's roster (where lanes are added/edited).

Keep per-session drag-reorder within the list; drop cross-group drag entirely.

**Switcher popover** (anchored under the header, `var(--radius-md)`, `--bg-surface`, `1px --border`, `maxHeight: 320`, scroll). It's the fast way to move between projects, so it carries the same read as a gallery card — switching shouldn't mean knowing less than browsing:
```
  ◉ operator          1 needs you    ← current: faint tint + accent name
    ~/operator             just now
  ◐ el-encanto          1 running
    ~/el-encanto           just now
  ○ uwazi_app             2 lanes
    ~/uwazi_app              1h ago
  ────────────────────────────────
  All projects…               ⌘⇧O
  Open folder…                 ⌘N
```
Each row: the project's **rolled-up `StatusWave` orb** (not a decorative dot — it twinkles when something in there is actually working, which is the whole reason to glance before switching), name, the same `projectActivityLabel` the card uses, and a reference line of `path · lastActive`. "You are here" is a faint `--overlay-subtle` tint plus accent ink on the name — never a fill, never a left-edge stripe. Type-to-filter appears once >8 projects.

Both surfaces read a project through **`lib/project-status.ts`** (`projectActivity` / `projectActivityLabel`, unit-tested) so the two can't drift on what "busy" means. Busiest-wins for the orb; `waiting` is counted separately because since the waiting pulse was removed the orb can no longer say "your turn" — the label has to.

**Collapsed rail (`SidebarRail`)**: same scoping — drop its project clustering (`SidebarRail.tsx:69-80`, now always one project), and put the project's 1–2 char badge (`shortNameOf`) at the top as the switcher target.

---

## 4. Navigation rules & edge cases

1. **Selecting any session sets `activeProjectId` to that session's `projectId`.** This is the single rule that keeps every existing entry point honest — `⌘1-9`, `⌘K` palette, a toast click, `handleRestoreSession`, `AgentsHubView`'s focus action. You can never end up with a focused session that isn't in the sidebar.
2. **Launching a lane** already switches to the new session's console (`DashboardView.tsx:926`); it now also implies its project scope (same project — no-op in practice, but assert it).
3. **Back to gallery kills nothing.** Live agents keep running; their project's card shows the count and lit orbs. Say so in the switcher's `title`.
4. `shortcutIndices` (`⌘1-9`) are computed over the **scoped** list, so the numbers match what you see.
5. **Overlay views** (Agents hub, Usage, Prefs, Claude files) do not clear scope; leaving them returns to `project` or `localTerminal`.
6. `⌘K` keeps its cross-project "Open project X" actions — the palette is a power path and is allowed to cross scope (it sets scope, per rule 1).
7. **New shortcuts:** `⌘⇧O` → gallery. `⌘⇧P` → switcher popover. `Esc` inside the popover closes it (does not leave the project).
8. **Closing the last session in a project** leaves you at Project Home, not the gallery.
9. **Legacy sessions with no `projectId`** (the old `name:` group key) can't be scoped. Resolve them to a project via `workingDirectory` on hydrate; anything still unresolved is reachable from the gallery's activity view only.

---

## 5. States to build and verify

Verify each in **all four themes** (Mission Control, Mr Pink, Light, 1984) — every value from tokens, no hardcoded colours.

| surface | empty | loading | overflow |
|---|---|---|---|
| Gallery | no projects → keep today's welcome splash copy + `LogoMark size={96}`, CTA becomes **"Open a folder"** | projects seed from localStorage → first paint is instant, **no spinner**; reconcile silently on hydrate | grid scrolls; long names ellipsis + `title`; >8 lanes → `+N` orb |
| Gallery card | project with no roster → orb strip omitted, footer shows only relative time | — | missing path (folder deleted) → card dimmed via **muted ink, not group opacity**, `title` explains; still openable |
| Project Home | rosterless project → `RosterPanel` already seeds `defaultRoster()` | — | existing |
| Sidebar | project with zero lanes *and* zero sessions (only if the roster was emptied) → one muted line "No agents yet — add one on the roster" | — | many lanes → list scrolls, header + footer pinned |
| Switcher | one project → still opens, shows "All projects…" | — | >8 → filter field + scroll |

**Style rules that bind here** (from the global UI-style memory): transparent badges only, no solid accent fills for state, no browser focus rings, **never a coloured left-border marker stripe** (use the orb / coloured text / faint tint), no colour-*changing* border on a radiused element, and never recede a card with group `opacity`.

---

## 6. Build order

1. **State split** — `activeProjectId` + `projectTab`, persistence, `contentMode` gains `gallery`, handlers stop nulling scope. No visual change yet except the old splash becoming the gallery placeholder.
2. **`ProjectGallery.tsx`** (new, `components/dashboard/`) — header + grid + card, and `galleryTab` hosting the untouched `ActivityDashboard` behind the rollup chip.
3. **Sidebar scoping** — filter to `activeProjectId`, delete `FolderGroup` + Recent, flat roster∪live list, new header.
4. **`ProjectSwitcher.tsx`** (new, `components/sidebar/`) — popover + shortcuts.
5. **Rail scoping** + `ProjectView` back-chevron + `⌘⇧O`/`⌘⇧P`.

Steps 1–3 are the substance; 4–5 are the polish that makes it navigable without the palette.
