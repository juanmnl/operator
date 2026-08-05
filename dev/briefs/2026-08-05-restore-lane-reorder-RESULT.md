# RESULT — agents reorder again, at both widths

Branch `operator/ac9328`, on `40db2eb`. Build clean, `npm test` **624 passed** (619 + 5).

## The regression was in TWO halves, and only one of them was a deleted handler

The brief's diagnosis is right and I restored what it names. But restoring only that produces a drag
that **persists correctly and appears to do nothing** — which I only found by driving it:

```
FAIL R1 the rendered order CHANGED — [operator, code, research] → [operator, code, research]
ok   R1 the reorder was PERSISTED — roster [research, operator, code, design]
```

The roster was rewritten, the Team screen would have agreed, and the strip did not move.

**Why.** Pre-join, `Sidebar.tsx` built its lane rows *from the roster*, so roster order was row
order by construction — there was no code to delete, which is why nothing looked missing. The
joined strip builds rows from the live **sessions** instead, so after the join the roster ordered
nothing on screen. The second half of the fix is `orderByRoster` (`lib/roster.ts`), applied in
`liveOf` so both widths read one ordered list.

It is a **stable partition**, not a sort of everything: lane members keep the set of slots they
already occupy and are filled into them in roster order; ad-hoc members keep their exact positions.
That is the same-kind rule applied to display — the two kinds are ordered by different things and
neither gets to reshuffle the other. Sorting the whole list would have moved every ad-hoc row the
first time a roster changed. A member whose lane was deleted while it still runs sorts last among
lanes rather than vanishing.

## What was restored

1. **`handleReorderLane`** in `DashboardView.tsx`, and passed as `onReorderLane`. The tombstone
   that replaced it reasoned *"those rows are gone (the strip lists only what is live), and with
   them the only caller"* — half true, and exactly why this shipped: the IDLE lane rows went, but a
   LIVE lane row is still a lane row, and since an agent is precisely a session **with** a
   `roleId`, dropping the lane half removed reordering for every agent.
2. **`onReorderLane` on `ProjectRail`**, and lane rows draggable in `MemberRow`, keyed on
   `session.roleId` as the brief specifies.
3. **The same-kind rule kept** — and kept *where it already was*, in the drag's MIME type rather
   than in a drop handler. `dragover` may read `dataTransfer.types` but not `getData`, so the type
   is the only thing a row can filter on while the drag is in the air, which is when the drop line
   is drawn. A row that doesn't recognise the type never calls `preventDefault`, so it is not a
   drop target, draws no line, and `drop` never fires. **A cross-kind drag is refused, not accepted
   and silently discarded** — the brief's explicit requirement, and it falls out of the mechanism
   rather than being a second rule to remember.
4. **The trivial-case guard** is back for both kinds (`laneRows.length > 1` / `adHocRows.length >
   1`): a drag whose only possible drop is onto itself is an affordance that cannot do anything.

### One deviation from "reinstate exactly as above", and why

The recovered handler took the project from `activeProjectId`. That was correct pre-join, when the
sidebar was scoped to exactly one project — **it is not correct now.** The joined strip shows
several projects' groups at once, so the lane you drag is not necessarily in the project you are
in, and the verbatim version would rewrite the *active* project's roster from another group's drag.
So `onReorderLane` carries the `projectId` (same shape as `onAgentMenu`), and the handler uses it.

For the same reason **the project id is in the drag type** (`operator/lane-<projectId>`): role ids
repeat across projects — `code` exists in most of them — so a cross-group lane drag would otherwise
land in the wrong roster, or self-drop, since `code`→`code` is a valid pair in both. Project ids are
already `[a-z0-9-]` (`lib/project-id`), so they survive the lowercasing the drag API applies to type
strings. Cross-project is now refused by the same mechanism as cross-kind.

## The collapsed-width decision: I ADDED IT

**Orbs drag too.** Reasoning, since the brief asked for it explicitly:

- The user's screenshot of the problem was the **collapsed** rail. Shipping expanded-only means
  they open the app, try it where they reported it, and it still doesn't work.
- This component's whole thesis is *one surface at two widths*. A gesture that works at 264 and not
  at 60 re-creates the split the join was built to remove.
- The machinery is now generic (`drag={dragFor(s)}` — same types, same guard, same handler), so the
  orb path is a prop, not a parallel implementation.

**This is new capability, not the regression** — pre-join, reordering lived in the expanded sidebar
only. Two things I did to keep it from costing anything:

- **The drop line is absolutely positioned**, not a border. The expanded rows can afford constant
  transparent borders because they already sit `MEMBER_GAP` apart; the collapsed orbs are **flush**,
  so 2px of border top and bottom would take the member pitch from 36 to 40 and spread the whole
  column. `drive-rail-invariant.mjs` asserts that pitch and would have been right to fail. Out of
  flow it costs nothing at rest and nothing while dragging — asserted (R2, 36 → 36).
- The orb clears its hover card on `dragstart`, the same hardening the group header already needed:
  a drag never fires the mouseleave that would close it.

**The risk I am not able to test headlessly:** on a 24px disc, a click that drifts a pixel could
start a drag instead of selecting. The expanded row is 264px wide and forgiving; the orb is not.
Worth a moment of your attention when you first use it — if it feels sticky, the honest fix is
expanded-only, and it is one prop.

## Verify — each bullet

| Bullet | Result |
|---|---|
| Two+ lanes, expanded: drag one above another, order changes | **R1** — `[operator, research, code]` → `[research, code, operator]` |
| …and it survives a restart | **R1** — asserted on the durable write, not the DOM: `saveProjects` fired with `[research, code, operator, design]`. Asserting the DOM alone would pass on a reorder that never reached the roster, which is the "looks saved and isn't" class this project has shipped before |
| Agrees with what `RosterPanel` shows | **R1** — same `reorderRoles` on the same roster, and the strip is now ordered *by* that roster, so the two cannot disagree by construction |
| Ad-hoc sessions still reorder among themselves | Path unchanged (same wrapper, same `text/session` type). **Not exercised end-to-end** — see below |
| Lane ↔ ad-hoc does nothing, no misleading drop line | **R4** — `accepted=false`, order unchanged, 4 → 4 saves |
| Click still selects, right-click still opens the menu | **R6** for click. The `closest('[draggable]')` trap the brief warns about: **grepped, no such predicate exists anywhere in `src/renderer`** |
| `npm test` green, build clean | 624 passed, build clean |

New driver `dev/drive-lane-reorder.mjs` (17 assertions, all pass). It drives real `DragEvent`s with
one shared `DataTransfer` rather than Playwright's `dragTo`, because the custom type is the entire
same-kind mechanism and `dragTo` does not reliably carry custom types through WebKit.

Also re-ran, both clean: `drive-rail-invariant.mjs` (**CLEAN on every palette** — member pitch,
axis, foot geometry undisturbed) and `drive-rail-fold.mjs`.

## Not verified / changed beyond the brief

- **The ad-hoc reorder is not exercised end-to-end.** The mock has exactly one ad-hoc session, and
  with the trivial-case guard restored a lone row correctly has no drag. Its code path is byte-for-
  byte the one that already worked (only the type/id/handler are now passed in a `drag` object),
  and R4 proves it still refuses a lane. A fixture with two ad-hoc sessions would close this.
- **Restart persistence is asserted at the write, not by actually restarting.** `saveProjects` is
  the durable path; a real relaunch is yours.
- **I made the row wrapper unconditional** (only `draggable` is conditional). The wrapper carries
  `data-lane-row` / `data-session-row`, which some two dozen drivers select rows by — hanging those
  off the drag condition meant the last row of its kind silently lost its test hook the moment the
  guard came back. That is a harness regression bought for nothing. `data-lane-row` on lane rows and
  `data-lane-orb` on lane orbs are restored/new hooks (the first is the pre-join sidebar's own
  name); nothing that matched before stops matching.
- **`orderByRoster` changes the on-screen order of lanes for everyone**, from session order to
  roster order. That is required — it is what "reorder agents" means — but it is a visible change
  on first launch for anyone whose lanes happened to be in launch order.
