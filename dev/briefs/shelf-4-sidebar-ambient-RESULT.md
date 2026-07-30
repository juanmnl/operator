# RESULT — Shelf steps 4+5: `ALSO ACTIVE`, and the rail cluster

Both steps landed. The thing the user actually asked for is in.

---

## Step 4 — `Sidebar.tsx`

**Zero new props for the section**, as specified. Membership comes from a new export in
`lib/project-shelf.ts` rather than being inlined:

```ts
otherActiveProjects(projects, activities, currentProjectId)
  → Array<{ project: Project; activity: ProjectActivity }>
```

Every active project except the one you're in, ordered live-first-then-last-run, each paired
with its rolled-up state (idle stand-in when the activity map hasn't reached it yet). The
sidebar and the rail are two renderings of **one** definition, so they cannot disagree about
who's in the set — which matters more here than saving three lines, because the two lists sit
40px apart when you collapse.

- **Quiet projects included.** Driver-pinned (`uwazi_app`, 0 live, still gets a row reading
  `2 lanes`) because it's the assertion that looks like a bug if you don't know the design.
- **Position/size:** below the AGENTS scroller, above the stats row; `flexShrink: 0`,
  `maxHeight: 5 × 26` with its own scroll, hairline above and below. Measured: 160px total
  with 17 rows, and the AGENTS list is untouched at any count.
- **Row h26:** rolled-up `StatusWave size={13}` · name 11.5 at `color-mix(--fg 80%)` ·
  right-aligned `projectActivityLabel().text` 9.5 mono, accent only when `label.accent`.
  Background-only hover, no radiused colour-changing border. Click = `onOpenProject`.
- **Header** `ALSO ACTIVE · N` in the AGENTS treatment, with `⌄`/`›`, persisted to
  `localStorage['operator.ambientCollapsed']` (a new key — the orphaned accordion ones are
  untouched). Collapsed it reads `ALSO ACTIVE · 2 — 1 running`, "needs you" outranking
  "running" the same way `projectActivityLabel` does per project.
- **Set of one → returns `null`.** No header, no empty state, zero pixels.
- **`previous` chip** on the switcher header row when `project.archivedAt` is set — the
  `lost`-chip treatment; click calls the new optional `onRestoreProject` prop (the section
  itself needed no props; the chip did).

## Step 5 — `SidebarRail.tsx`

New props `otherActive` / `onOpenProject`, both derived in `DashboardView` from the same
helper. Below the session icons and above the `+`: a 1px seam, then one bare
`StatusWave size={16}` per other project **with something running**, each on the shared
`useHoverCard` (`el-encanto — 1 running`), click = enter. Nothing running elsewhere → no seam,
no cluster. **No initials glyph** — that vocabulary stays with sessions.

The brief says "live or waiting"; the filter is `activity.live > 0`, because a waiting session
is an open session (`projectActivity` counts `waiting` as a subset of `live`), so the second
clause can never add a row. Commented in place rather than written as dead redundancy.

---

## How it looks at 18 rows — you asked

Screenshot: `/tmp/operator-shots/ambient-18.png`. It behaves exactly as designed and I did
**not** cap it.

`ALSO ACTIVE · 17` with five rows visible in a 130px scroller, pinned between the roster and
the stats row. Nothing overflows the 220px sidebar (asserted). It reads as orderly rather than
overwhelming — the header count is honest about the total, and the roster above is untouched.

My honest read: at 17 it is a **scroll-box, not a glance**. The design's premise — "see all my
active projects" — is delivered literally (the list is complete, no `+N more`), but you'd have
to scroll to use the bottom two-thirds. That's the curation problem, not a layout problem, and
the tidy pass shipped in step 6 is the answer: on the real store, 10 of 19 are >2wk stale, so
one review sheet takes this to ~7 rows and the whole section fits without scrolling. **I'd
suggest running the tidy pass before judging this section** — that's the state it was designed
for. If it still feels long afterwards, the lever I'd reach for is `AMBIENT_MAX_ROWS` (one
constant, currently 5), not a cap on membership.

## What I'd push back on — one thing, and I fixed it rather than shipping it

The brief specifies the collapsed tail "in accent ink". Probed across six palettes, bare
`var(--accent)` at 9.5px measured **2.69:1 on Mission Control light and 2.22:1 on 1984 light**
— under even the 3:1 meta floor, i.e. the signal that's meant to survive collapsing was the
least readable thing in the section on two palettes. It now uses
`color-mix(in srgb, var(--accent) 70%, var(--fg))`: same hue, 3.74–13.02 across all six.

Worth knowing: this is **not** unique to my code. The card's `1 running` state label and the
switcher's accent state word use bare `var(--accent)` at 10/9.5px and have never been probed.
I didn't touch them — out of scope, and they sit on different backdrops — but if the tail
measured 2.2 those probably do too. Worth a separate sweep.

## Decisions

1. **`otherActiveProjects` in `lib/project-shelf`, not inlined twice.** The brief has the
   sidebar deriving internally and the rail taking a prop; both go through the one function.
2. **The chip is a `<button>` inside the switcher trigger** (a `role="button"` div), so it
   stops propagation — clicking `previous` restores without also opening the switcher.
3. **A shelved project you're standing in still shows the chip even though the gallery lists it
   as ACTIVE** (auto-lift, because it's live). The chip reads the record; the shelf reads the
   lift. Same asymmetry as the card menu's `Restore to active`, and it's the honest one — the
   record is what the chip changes.

## Verification

- `npm test` — **261 passed / 34 files** (3 new `otherActiveProjects` cases: drops current +
  shelved and keeps the quiet ones; idle stand-in; no-current-project).
- `npm run build` — clean.
- `node dev/drive-sidebar.mjs` — passes; **nothing overflows the 220px sidebar**, which is the
  assertion that mattered for new content in that box. (It hardcoded port 1440; I gave it the
  `MOCK_PORT` support its siblings have.)
- **`node dev/drive-sidebar-ambient.mjs` (new)** — 7 scenarios, all green: quiet project gets a
  row · h26 · click enters · collapsed hides rows but not the fact, and survives a reload · 17
  rows stay capped at 160px with the roster untouched and no overflow · set of one renders
  nothing · `previous` chip appears, restores, and clears the record · rail shows exactly one
  dot (the running project, not the idle one), its hover card reads `el-encanto 1 running`, and
  clicking it enters.
- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**, with four new probes:
  `ambient header` 3.80–7.38, `ambient project name` 6.58–11.22, `ambient state (quiet)`
  3.80–7.38, `ambient collapsed tail` 3.74–13.02. (The pass now restores the project it shelves
  earlier in the run — otherwise the only quiet ambient row didn't exist and two probes
  silently reported "missing", which is how a probe passes vacuously.)
- `node dev/drive-navigation.mjs` — all 11 checkpoints unchanged.

## Pre-existing breakage I did not fix

`dev/drive-rail.mjs` reports `tags: []` and `railWidth: 1440`. It verifies the rail's **old
project clustering** (seam + `shortNameOf` tag), which project-first navigation deleted — the
code says so out loud (`SidebarRail.tsx`: "No project clustering any more"). It has been dead
since that landed, not since this change; the new cluster is covered by
`drive-sidebar-ambient.mjs` step 7. Flagging rather than deleting — that's your call.
