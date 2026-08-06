# IMPL — Close ends the agents; Shelve files; Forget destroys

Implements `2026-08-06-close-vs-forget-RESULT.md` (Design) as specified. Built on branch
`operator/808fe8` (worktree `~/.operator/worktrees/operator-808fe8`).
`npm test` 671 green (665 before, +6), `tsc --noEmit` clean, `npm run build` clean.

## The diff, spec item by spec item

**1. `isOnRail()` extracted** — `lib/project-shelf.ts`, beside `isActiveProject`, signature exactly
as the spec wrote it. `ProjectRail.tsx:266`'s inline filter now calls it (the only behavioural claim
here is that they were the same predicate, and now they are the same function). Third call site is
the gallery card menu's gate.

**2. `closeProject` no longer writes `archivedAt`** (`DashboardView.tsx:1021`). Removed: the
unconditional `setProjects(… archivedAt: at …)`, and the Undo action that reversed it. `archivedAt`
now has exactly one writer, `archiveProjects()`. The `closingProjects` add is skipped when
`plan.sessions.length === 0`, so an idle close does not flash the chip.

**3. Toasts** — three variants, none with Undo:

| case | text | detail |
|---|---|---|
| `n > 0` | `Closed {name} — N agents ended` | `It stays in Active. Launching an agent here brings it back to the rail.` |
| `n === 0` | `Closed {name}` | `It stays in Active — open it again any time.` |
| partial failure | `{name} — N agents did not stop` | the lane names |

**4. Both menus lost the `live > 0` gate.**

- *Rail tile ⋯* — Close is now **always present** (every tile in that menu is on the rail by
  construction). Label `Close project · end N agents` when live, `Close project` when not;
  `confirm: live > 0`.
- *Gallery card ⋯* — gated on `isOnRail(project, activity, activeProjectId)`; same graduated label;
  `confirm: liveCount > 0` — which **adds** a confirm to this surface, since its Undo-toast guard
  went away with the shelf write.

`CardMenu` already arms-and-relabels to `… — click again`, so the confirm needed no new mechanics.

**5. Copy** — `Archive project` → `Shelve project`; closing-chip tooltip →
`Ending this project’s agents`; Shelve-while-live detail →
`Still running, so it stays on Active — Close ends its agents.`

**6. Rail empty state** — one line, `nothing running`, mono/uppercase/`--fg-muted` matching the
gallery's `SECTION_TYPE`, rendered only when `shown.length === 0 && expanded`. Carries
`data-rail-empty` for the harnesses.

**7. Tests** — `project-shelf.test.ts` +6: `isOnRail` across live / open-and-idle / neither /
shelved-but-live, and a pair asserting that a closed project (no lanes, no `archivedAt`) partitions
into **active**, not previous, and is off the rail.

Forget is untouched — same placement, same wording, same `danger` + `confirm`, same tombstone.

## Where I deviated from the spec: nowhere functionally, once in placement

Only one thing needed a decision the spec did not spell out, and it is worth stating because it
changes what the user can see.

**The gallery's Close is effectively live-only, because scope is null on the gallery.**
`handleShowGallery` sets `activeProjectId = null`, and `contentMode` only resolves to `'gallery'`
when no project is in scope — so whenever a gallery card is on screen, `isOnRail` reduces to
`live > 0` there. The spec's verify #5 ("a project that is neither live nor open offers no Close")
holds; its implied companion ("open and idle DOES offer Close on its card") is unreachable, because
opening the gallery is what makes the project not-open.

That does not lose the case the user asked for: an idle open project has a rail tile, and the rail
tile ⋯ Close is unconditional. I implemented the gate as `isOnRail` with the real `activeProjectId`
threaded into `ProjectGallery` anyway, rather than hardcoding `live > 0` — so the gate is correct by
construction rather than correct by accident, and stays correct if the gallery ever renders in scope.

## Verified, and how

Statically verified (code/tests):

- 1–5, 9 — `archivedAt` is written in exactly one place; `grep` for it in `DashboardView` returns
  `archiveProjects`, `restoreProject`'s clear, `upsertProject`'s auto-lift, and reads. No close path.
- 11, the word audit — `grep` over `src/renderer`: **zero** user-facing "Archive" as a project verb
  (the only remaining occurrence is a comment explaining the rename); "Forget" appears only on the
  two destructive menu items (card, Previous row) and on the unrelated per-session control in
  `RecentLists`; Close and Forget are never adjacent — Shelve/Restore sits between them and Forget
  carries its own separator.
- 12 — 671 tests, build clean.

**Needs a GUI run, i.e. yours** (per the standing env constraint — GUI verification is the user's,
and there is no React test harness in this repo, all 55 suites are pure-lib):

- 1–4, 6–8 as *observed* behaviour: the tile leaving the rail, the toast text on screen, the
  confirm arming, Shelve's Undo, Forget's tombstone across a restart.
- 10 — that the empty rail reads `nothing running` rather than a bare strip.

The risk the spec named — copy drifting between menu, toast and undo — is the one I checked hardest,
and the audit above is the check.
