# Brief — Sidenav option B: the persistent project rail

User picked **A and B** from the layout options
(`https://claude.ai/code/artifact/a3dd9bc1-905d-4d4f-9bec-d138654431c0`).
A (`ALSO ACTIVE` list) is built. This adds B **alongside** it — additive, nothing to undo.

Plan: `/Users/juanmnl/.claude/plans/operator-the-research-lane-crispy-fox.md`.
Depends on merged steps 1-4: `lib/project-shelf.ts`, `archivedAt`, `partitionProjects`,
`isActiveProject`, the gallery split, the tidy bar, and the `ALSO ACTIVE` section.

## The shape

A **44px strip, outboard of (to the left of) the sidebar, full height** — a peer of the sidebar,
not a section inside it. One orb per ACTIVE project, current one ringed.

```
┌────┬──────────────────────────┐
│ ◉  │ operator            ⌄    │   ← 44px rail │ 220px sidebar
│ ◉  │ AGENTS                +  │
│ ◐  │  ◉ Code        running   │
│ ○  │  ◉ Research   your turn  │
│ ──  │  ○ Review                │
│ ○  │ ALSO ACTIVE · 3      ⌄   │
│    │  ◉ el-encanto 1 needs you│
│ +  │ 2 active          0.10.1 │
└────┴──────────────────────────┘
```

**It persists in EVERY state** — sidebar expanded, sidebar collapsed to the 64px `SidebarRail`,
and at the gallery (where the sidebar strip animates to width 0, `DashboardView.tsx:2099-2107`).
That permanence is the entire point of the option: it is the one surface that never goes away.

## Rail items are TILES — colour + acronym, not orbs

**Decided by the user, and it supersedes the "no initials glyph" rule in the first draft.** An orb
can only carry colour, and colour alone cannot separate `fastrack` / `Fastrack-landing` /
`FastTrack`. A tile carries both.

The thing that keeps a project from reading as an agent is **shape, not the glyph**:

| | Shape | Carries |
|---|---|---|
| Session / lane | circle (`StatusWave` orb) | lane accent + live state |
| Project (rail) | **rounded square, `border-radius: 7px`** | identity colour + acronym |

Never render a project as a circle or a session as a square. That contrast is the whole grammar.

### The tile

28×28, `border-radius: 7px`, centred acronym at 10px / 600 / `letter-spacing: 0.02em`.
House style is transparent badges and no solid accent fills, so:

- background `color-mix(in srgb, <accent> 16%, transparent)`
- border `1px solid color-mix(in srgb, <accent> 38%, transparent)`
- text `laneTextColor(<accent>)` — **use the existing helper** (`lib/lane-color.ts`), it applies
  each theme's `--lane-ink-blend` so the acronym stays ≥4.5:1 on the three LIGHT palettes, where
  raw accents collapse to ~1.4:1.

The border is per-project identity and therefore **static** — it never changes colour, so it does
not trip the WKWebView "no colour-changing border on a radiused element" rule. Do not animate it
or swap it on status change.

### Identity colour

`Project` has no accent field (only `Role` does). Derive one: `projectAccent(id: string): string`
in a small `lib/project-accent.ts` — a pure hash of `project.id` into the same default palette the
role presets draw from (`lib/roster.ts` `rolePresets`). Deterministic, unit-testable, **not
persisted** (deriving means no migration, no new field). Hash the **id, never the array index** —
projects reorder.

### Acronym

`projectInitials(name: string): string` in the same module. Split on separators (`-`, `_`, space,
`.`) **and camelCase boundaries**, then:
- 2+ parts → first letter of the first two parts
- 1 part → first two letters

Uppercase the result. Against the real store this gives `operator→OP`, `el-encanto→EE`,
`mantel→MA`, `mantel-landing→ML`, `uwazi_app→UA`, `visual language→VL`, `web27→WE`,
`fastrack→FA`, `Fastrack-landing→FL`, `FastTrack→FT` — the camelCase split is what keeps the
three fastrack variants apart. Collisions are tolerable since colour differs too; do not build a
uniquing scheme.

### Status still has to read

The tile carries identity, so state needs its own channel: a **corner pip**, bottom-right,
overlapping the tile edge — a small `StatusWave` (`size={9}`, `seed={project.id}`,
`accent={projectAccent(id)}`). This preserves the app's one motion rule for free: only
`running`/`compacting` animate; `waiting`/`idle` rest static at their `staticOp`
(`StatusWave.tsx:27-36`). Render **no pip at all** when the rolled-up status is `idle` — an
always-present grey dot is noise.

Result: acronym + colour = which, pip = what.

## Details

- **Order:** `byActivityThenRecency(activities)` — the same comparator as the gallery and switcher.
  Never invent a third ordering.
- **Membership: OPEN projects only** — `activities[p.id].live > 0`, i.e. projects that currently
  have at least one non-ended session. **Plus the current project always**, even with nothing
  running, so the rail is never empty while you're inside a project. Archived projects can still
  appear if something is live in them (a running agent must never be hidden).

  This is a deliberate change from the first draft, decided by the user: the rail is *"what I have
  open right now"*, NOT the full active set. It is what stops the rail and `ALSO ACTIVE` from being
  the same list twice — `ALSO ACTIVE` remains the complete map including quiet projects, the rail
  is the short working set. Do not "restore" quiet projects to the rail.

  At the gallery with nothing open, the rail shows only the all-projects control at its foot.
- **Current project:** ring it with `box-shadow: 0 0 0 2px var(--accent)`.
  **Must be `box-shadow`, not `border`** — the house rule forbids a colour-CHANGING border on a
  border-radius element (WKWebView freeze). A box-shadow is not a border and is safe.
- **Hover:** reuse `useHoverCard` (`lib/use-hover-card.ts`, as `RailRow` does) showing
  `el-encanto — 1 needs you` from `projectActivityLabel`. **Harden for the cursor leaving the
  window**, not just for rows moving under it — that gap is a known live defect
  (`project_hover_card_stuck`), and this is a new card; don't ship the same bug.
- **Click:** `onOpenProject(p.id)`.
- **Bottom of the rail:** a 1px `var(--border)` seam, then an "all projects" control → the gallery
  (`onShowGallery`, ⌘⇧O). It is the natural home for it and the rail is the only always-present strip.
- **Tiles are square, session orbs are round** — see the grammar table above. `RailRow`
  (`:266-281`) keeps its own treatment untouched; don't unify them.
- **Overflow:** the rail scrolls internally. No `+N` truncation — same reasoning as `ALSO ACTIVE`.

## Remove what this makes redundant

Step 5 of the original plan put a small cross-project orb cluster **inside** `SidebarRail` (the
64px collapsed variant). With a persistent outboard rail that cluster is a duplicate of its
neighbour, 44px away. **Delete it** if it was built (`SidebarRail.tsx` currently shows +87 lines).
Keep everything else in `SidebarRail` untouched.

Keep the `previous` chip on the switcher header (from step 4) — still the right place to restore
an archived project you've navigated into.

## The rail vs ALSO ACTIVE — now cleanly separated

The two surfaces no longer show the same list, so the earlier duplication concern is resolved by
membership rather than by hiding anything:

| | Rail (outboard, 44px) | `ALSO ACTIVE` (in sidebar) |
|---|---|---|
| Shows | OPEN projects (`live > 0`) + current | ALL active projects, quiet ones included |
| Carries | identity + permanence | names + status phrases |
| Present | always — expanded, collapsed, gallery | expanded sidebar only |
| Typical size | 1-3 | 18 today, ~5 after archiving |

**Do not auto-hide one when the other is visible** — that couples two independent surfaces and
makes both unpredictable. They overlap only on projects that are both open and active, which is
correct: that's where you are.

## Traps

- Never stack opacity on `--fg-muted`; the guard test fails the build.
- Motion is the only busy signal — don't animate idle/waiting orbs.
- Never a coloured left-border marker stripe.
- The rail is a new always-present strip: check it doesn't break the gallery's width-0 sidebar
  animation, and that the window drag region (`DragRegion.tsx`) still works at the top-left.
- `projectAccent` must be stable across restarts — hash the id, never the array index (projects
  reorder).

## Done when

- `npm test` + `npm run build` green, including `project-accent.test.ts`: `projectAccent` is
  deterministic and stable across calls; `projectInitials` splits camelCase and separators, and
  yields `FA`/`FL`/`FT` for the three fastrack variants and `OP`/`EE`/`ML`/`UA`/`VL` for the rest.
- `node dev/drive-sidebar.mjs` and `dev/drive-navigation.mjs` pass.
- `node dev/drive-theme-pass.mjs` — all 6 palettes; the identity colours must stay distinguishable
  on the three light palettes, not just the dark ones.
- Rail renders identically at the gallery, expanded, and collapsed.

## Write your result to

`dev/briefs/shelf-5-project-rail-RESULT.md` — what landed, how the identity palette reads at 19
projects, and whether the rail + list duplication looks wrong to you.
