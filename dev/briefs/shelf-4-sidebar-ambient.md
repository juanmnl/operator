# Brief — Shelf steps 4+5: the sidebar `ALSO ACTIVE` section, and the rail cluster

Full approved plan: `/Users/juanmnl/.claude/plans/operator-the-research-lane-crispy-fox.md` §5.
Depends on steps 1-3, which are **merged**: `lib/project-shelf.ts`, `Project.archivedAt`,
`partitionProjects`, and the gallery split all exist.

This is the thing the user actually asked for: *"I liked it better when I could see all my active
projects on the sidenav."* Everything before it was the precondition.

## Why this is not the design they already rejected

Three sidebar-list options were put to the user and turned down. Read this before building:

- The rejected "peek list" derived membership from **liveness**, so it churned — an alarm panel.
  This one derives membership from `archivedAt`, a user **decision**, so it's stable — a map.
- **Therefore: include the QUIET active projects.** A project with nothing running still gets a
  row. A row that says nothing today is exactly the row that provides orientation. Do not filter
  to "busy" — that rebuilds the rejected design.
- No nesting, no session rows, no drag, one boolean of persisted state. **You cannot act on a
  session from here — only enter its project.** That constraint is what keeps this a view rather
  than a second navigation tree.

## Step 4 — `Sidebar.tsx`

**Zero new props.** `projects`, `activities` and `onOpenProject` are already passed (`:29-33`, `:53`).

```
│ AGENTS                +  │   ← current project's lanes, unchanged, flex:1, scrolls
│  ◉ OPERATOR      running │
├──────────────────────────┤
│ ALSO ACTIVE · 3       ⌄  │   ← NEW
│  ◉ el-encanto 1 needs you│
│  ○ mantel         3 lanes│   ← quiet projects included — this is the orientation
├──────────────────────────┤
│ 3 active      Operator…  │   ← existing stats row
```

- **Membership:** `projects.filter(p => isActiveProject(p, activities[p.id]))` minus the current
  project. Complete over the active set. **No `+N more`** — a partial list reintroduces "what am I
  not seeing", which is the anxiety being fixed.
- **Position:** below the AGENTS scroller, above the stats row. `flexShrink: 0`,
  `maxHeight: 5 * 26` with its own internal scroll, so it can never push a lane out of view.
- **Row, h26** (deliberately tighter than the 32px lane row so it can't compete): rolled-up
  `<StatusWave status={a.status} seed={p.id} size={13} />` · name 11.5px at
  `color-mix(in srgb, var(--fg) 80%, transparent)` · right-aligned `projectActivityLabel(a).text`
  at 9.5 mono, **accent ink only when `label.accent` is true**. Click = `onOpenProject(p.id)`.
  Hover = background only. This is the `ProjectSwitcher` row (`:99-162`) minus the path line —
  correct, because this is a glance, not a chooser.
- **Header:** `ALSO ACTIVE · 3` in the same 9.5 mono / uppercase / 0.16em `--fg-muted` as `AGENTS`
  (`:304-309`), with a `⌄` disclosure. Persist collapse to
  `localStorage['operator.ambientCollapsed']`.
  **While collapsed the header still carries the signal:** if any other project has `waiting > 0`
  or `live > 0`, it reads `ALSO ACTIVE · 3 — 2 running` with the tail in accent ink. Collapsing
  hides the rows, never the fact.
  Do **not** reuse `operator.collapsedGroups` / `operator.recentCollapsed` — they're orphaned keys
  from the deleted accordion and a stale value would confuse the first render.
- **Set size 1 (only the current project) → render NOTHING.** No header, no empty-state row. This
  is the common case for a focused user and it must cost zero pixels.
- **Inside an archived project** (reachable from the gallery's Previous shelf): the switcher header
  row (`:249-269`) grows a small right-aligned `previous` chip — transparent, `1px var(--border)`,
  9px tracked uppercase, the `lost`-chip treatment from `ProjectGallery.tsx:431-437` — whose click
  calls `onRestoreProject`. One control, in the one place you'd look for it.

## Step 5 — `SidebarRail.tsx` (the 64px collapsed variant)

Its cross-project job is weaker **by design**: say something is happening elsewhere, not where.

Append below the session icons, above the `+`: a 1px `var(--border)` seam, then one bare
`<StatusWave size={16} />` per other active project **that is live or waiting** — not the whole
active set; at 64px there's no room for a name, and a dot with no signal has no meaning. Each uses
the existing `useHoverCard` (`lib/use-hover-card.ts`, same as `RailRow`) showing
`el-encanto — 1 needs you`; click = `onOpenProject`. If none qualify, render neither seam nor cluster.

**No initials glyph** — that vocabulary belongs to sessions (`RailRow:266-281`); reusing it would
make a project read as an agent.

New props: `otherActive: Array<{ project: Project; activity: ProjectActivity }>`,
`onOpenProject: (id: string) => void`. Both trivially derived in `DashboardView` from `projects` +
`projectActivities` (already computed at `:1433-1444`).

## Known sequencing wrinkle — read this

The user currently has **19 projects and 0 archived**, so on their machine `ALSO ACTIVE` will list
**18 rows** in a 130px scroller on first run. That is the design behaving correctly (it scrolls,
it never eats a lane), but it will not *feel* like the win until they curate. The stale-tidy bar
is being built in parallel to solve exactly that. **Do not "fix" this by capping the list or
filtering to busy projects** — both re-create the rejected design. If it looks wrong at 18, say so
in your result file and let the user decide; don't unilaterally add a cap.

## Traps

- Never stack opacity on `--fg-muted` — the token IS the recede. The guard test
  (`lib/muted-opacity.guard.test.ts`) fails the build. Hover reveals go `0 → 1`.
- No colour-CHANGING border on a border-radius element (WKWebView freeze) — background-only hover.
- Motion is the busy signal: only running/compacting animate. Don't animate the rolled-up orb for
  waiting/idle.
- **Never a coloured left-border marker stripe** — house rule. Use the dot / coloured text.
- The sidebar footer's `stats.activeSessions` counts *scoped* sessions while this section shows
  other projects' counts, ~40px apart. The wording differs enough — but do NOT "helpfully" make
  the footer count everything.
- `SidebarRail` renders live sessions only, whereas `Sidebar` renders roster lanes ∪ ad-hoc
  sessions. They are not the same list; don't unify them here.

## Done when

- `npm test` + `npm run build` green, muted-opacity guard included.
- `node dev/drive-sidebar.mjs` passes.
- `node dev/drive-theme-pass.mjs` — all 6 palettes + contrast table for the new rows, the section
  header, and the collapsed-header accent tail.
- Set size 1 renders zero pixels; set size 0 while inside an archived project renders the full list
  plus the `previous` chip.

## Write your result to

`dev/briefs/shelf-4-sidebar-ambient-RESULT.md` — what landed, how it looks at 18 rows, and anything
you'd push back on. There is no other way for me to see your output.
