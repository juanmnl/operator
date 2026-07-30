# RESULT — remove ALSO ACTIVE

Gone, including its collapse state and its localStorage key. The `previous` chip stays.

## Removed — `components/sidebar/Sidebar.tsx`

- `<AmbientProjects>` from the render tree.
- The `AmbientProjects` and `AmbientRow` components, and the `AMBIENT_ROW_H` /
  `AMBIENT_MAX_ROWS` constants (~150 lines).
- The `ambientCollapsed` state, its `toggleAmbient` setter, and **both reads and writes of
  `localStorage['operator.ambientCollapsed']`** — the key is now written by nothing. Any value
  left in a user's localStorage is inert; I did not add cleanup code for it, since a stray key
  costs nothing and a migration that only deletes is more code than the problem.
- The now-unused imports (`projectActivityLabel`, `otherActiveProjects`); `ProjectActivity` is
  still needed for the switcher's prop type, so it became a type-only import.
- The file header comment now says the section was removed and why, so it doesn't read as an
  oversight: cross-project orientation is `ProjectRail`'s job, in 44px and in every state.

## Also removed — `lib/project-shelf.ts`

`otherActiveProjects()` and its three tests. It had exactly two callers — this section and the
`SidebarRail` cluster deleted in shelf-5 — and after this change **nothing referenced it**; its
own docstring named both dead consumers. This is slightly wider than the literal ask, so:
**flagging it explicitly** — one `git revert` away if you want the helper kept as a utility.
`isActiveProject`, `byActivityThenRecency`, `partitionProjects`, `matchProject` and
`staleProjects` are untouched and still in use.

## Kept

The `previous` chip in the switcher header row, exactly as it was. It isn't orientation — it's
the only way to un-shelve a project you've navigated into, and there's nowhere else to put it.

## Harness changes

- **Deleted `dev/drive-sidebar-ambient.mjs`.** Six of its seven scenarios tested the removed
  section. Its two survivors moved: the `previous` chip to a new
  **`dev/drive-sidebar-chip.mjs`**, and "no duplicate cluster in the 64px rail" already lives
  in `drive-project-rail.mjs` step 3.
- **`dev/drive-sidebar-chip.mjs` (new)** — chip absent on an active project → present inside a
  shelved one → clicking it clears `archivedAt` in the durable store. It also asserts the
  section is gone (`[data-ambient-*]` count 0) and that the localStorage key reads `null`, so
  the removal itself is pinned.
- **`dev/drive-sidebar.mjs`** — the footer check used `[data-ambient-header]` as the lower
  bound for "the active count sits with the lanes". Re-anchored to the last lane row: the count
  must sit within a row's height of it. Same intent, no dependency on the deleted section.
- **`dev/drive-theme-pass.mjs`** — dropped the four ambient probes (`ambient header`,
  `ambient project name`, `ambient state (quiet)`, `ambient collapsed tail`) and the
  collapsed-state screenshot. The shelve/restore step in the gallery section stays, but its
  comment no longer claims it exists to feed those probes.

## Verification

- `npm test` — **268 passed / 34 files** (was 271; the three `otherActiveProjects` cases went
  with the function).
- `npm run build` — clean, no unused-import errors.
- `node dev/drive-sidebar-chip.mjs` — all four checks pass.
- `node dev/drive-sidebar.mjs` — passes, including `nothing overflows the 220px sidebar` and
  the re-anchored footer checks (`active count hugs the last lane: true`, `identity shares the
  icon row: true`).
- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**.
- `node dev/drive-project-rail.mjs`, `dev/drive-navigation.mjs` — pass.

## One consequence worth knowing

The sidebar now shows **one project and nothing else**. With a short roster that leaves a large
empty column between the last lane and the footer — the same gap I flagged in the footer-fix
result, now bigger, because the section that used to occupy the bottom is gone. Nothing is
broken; it's just emptier. If that reads badly, the lever is the sidebar's vertical rhythm
(or letting the lane list stop being `flex: 1`), not bringing the section back.
