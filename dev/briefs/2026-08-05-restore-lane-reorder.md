# REGRESSION: agents can no longer be reordered. Restore it.

User, 2026-08-05: *"we lost the ability to reorder agents."* Confirmed, with the cause and the
deleted code both located.

## What happened

The v0.13.7 rail/sidebar join (`c978198`, *"One left surface at two widths"*) merged `Sidebar.tsx`
and `SidebarRail.tsx` into `ProjectRail.tsx` and **dropped the lane-reordering path entirely**.

**Before** — `Sidebar.tsx` made BOTH kinds of row draggable, through two separate handlers:

```tsx
draggable={row.kind === 'lane' ? !!onReorderLane && laneRows.length > 1
                               : !!onReorderSession && adHocRows.length > 1}
```

**After** — `ProjectRail.tsx:428` keeps only the ad-hoc half and gates lanes out:

```tsx
reorderable={!s.roleId && !!onReorderSession}
```

`onReorderLane` no longer exists anywhere in `src/` — prop, call site and handler were all removed.
A lane row (any agent with a `roleId`) is therefore undraggable, and since agents are exactly the
rows that have a `roleId`, "reorder agents" is gone. Ad-hoc sessions can still be dragged, which is
why it looks half-working.

## The deleted handler, recovered

From `git show c978198^:src/renderer/views/DashboardView.tsx`:

```ts
const handleReorderLane = useCallback((draggedRoleId: string, targetRoleId: string, edge: 'before' | 'after') => {
  if (!activeProjectId) return
  updateProject(activeProjectId, (p) => ({ roster: reorderRoles(p.roster ?? [], draggedRoleId, targetRoleId, edge) }))
}, [activeProjectId, updateProject])
```

It reorders the **roster**, which is the durable source of truth for lane order and is already
persisted by `updateProject`. `reorderRoles` still exists in `lib/roster` and is still used by
`RosterPanel` (which kept its own drag-to-reorder — so the model is intact, only the rail lost its
handle). Restoring this is re-wiring, not redesign.

## Build this

1. Reinstate `handleReorderLane` in `DashboardView.tsx` exactly as above, and pass it to
   `ProjectRail` as `onReorderLane`.
2. Add the `onReorderLane` prop to `ProjectRail` and make lane rows draggable in `MemberRow` —
   keyed on `session.roleId`, not `session.id`, since the roster is ordered by role.
3. **Keep the same-kind rule that is already documented there.** The existing comment is right and
   should survive: lane rows are ordered by the roster, ad-hoc rows by session order, and there is
   no sensible merge. So a lane→lane drag calls `onReorderLane`, an adhoc→adhoc drag calls
   `onReorderSession`, and a cross-kind drag is a no-op (don't just drop it silently if it looks
   droppable — either refuse the drop target or don't show a drop line for it).
4. Guard the trivial cases as the old code did: no drag unless there is more than one row of that
   kind.

## Decide and say which you did: the collapsed width

At 68px the group renders `RailOrb`, which has **no drag at all** — it never did in the joined
component. Pre-join, reordering lived in the expanded sidebar only, so restoring expanded-only is
true parity. Orb dragging would be new capability. The user's screenshot of this problem was the
**collapsed** rail, so they may well expect it there too. Restore expanded first (that is the
regression), then say explicitly whether you added it to orbs and why.

## Traps

- **A draggable row breaks `closest('[draggable]')` click predicates** — this bit this project
  before. Check any click handler on or above these rows that uses that pattern.
- **The row IS the handle.** Do not add a hover-only grip that reserves space at rest; grips belong
  on cards, not compact rows. Align ink, not boxes.
- Do not regress the ad-hoc path that still works.
- House rules: no browser focus rings, colours via CSS vars, no colour-changing border on a radiused
  element, never recede with group `opacity`.

## Verify

- Two or more lanes in a project, expanded width: drag one above another — the order changes, and it
  **survives a restart** (it is roster state, so this is the real check).
- The reordered lane order agrees with what `RosterPanel` shows — one order, two surfaces.
- Ad-hoc sessions still reorder among themselves.
- A lane dragged onto an ad-hoc row (and the reverse) does nothing and shows no misleading drop line.
- Clicking a row still selects it; right-click still opens the menu.
- `npm test` green (619 on `main` = `40db2eb`), `npm run build` clean.

## Output

Write `/Users/juanmnl/.operator/worktrees/operator-3b4cb8/dev/briefs/2026-08-05-restore-lane-reorder-RESULT.md`
(absolute path): what you restored, the collapsed-width decision, and how each verify bullet went.
