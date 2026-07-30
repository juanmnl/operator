# Brief — Shelf step 1+2: `relativeTime` long spans + `lib/project-shelf.ts`

Full approved plan: `/Users/juanmnl/.claude/plans/operator-the-research-lane-crispy-fox.md`
(read it for context; this brief is the executable slice).

**Scope: these two steps ONLY. No UI changes, no `archivedAt` field yet.** Both are pure and
land with zero user-visible behaviour change. Stop when the tests pass.

---

## Step 1 — `relativeTime` gains weeks/months/years

`src/renderer/lib/format.ts:7-16` currently ends at days:
```ts
return `${Math.round(h / 24)}d ago`
```
So a project last run in April reads `127d ago`. Extend the ladder:

- `< 7d`  → `Nd ago`   (unchanged)
- `< 5w`  → `Nw ago`
- `< 12mo` → `Nmo ago`
- else     → `Ny ago`

Keep the existing `subMinuteSeconds` option and every shorter branch byte-identical —
`format.test.ts:25` asserts `2d` and must still pass. Add cases for each new boundary.

Callers benefit for free (gallery card footer, ActivityDashboard rows, RecentLists).

---

## Step 2 — new `src/renderer/lib/project-shelf.ts`

Sibling to `lib/project-status.ts`, one-way dependency on it. **Do not merge into
`project-status.ts`** — that module is *what a project is doing right now* (pure over sessions,
no notion of the store). This one is *durable membership + ordering + query* (pure over
`Project[]`). Different axes; keeping them apart keeps `projectActivity` free of any archive concept.

```ts
import type { Project } from '../../shared/types'
import type { ProjectActivity } from './project-status'

/** Above this many rows a list earns a type-to-filter field. One definition for the switcher
 *  popover and the gallery — they had none and 8 respectively. */
export const FILTER_THRESHOLD = 8

/** Days without a run before we OFFER to shelve. Advisory only; never written automatically. */
export const STALE_DAYS = 14

/** Is this project on the ACTIVE shelf? `archivedAt` is the user's decision — but a project with
 *  a live session is active whatever the record says, because a running agent must never hide
 *  inside a collapsed section. Tolerates a missing activity entry (first frame). */
export function isActiveProject(p: Project, activity?: ProjectActivity): boolean

/** Live first, then most recently RUN. The one ordering, shared by the gallery grid and the
 *  switcher popover, which each carried a copy. */
export function byActivityThenRecency(
  activities: Record<string, ProjectActivity>,
): (a: Project, b: Project) => number

/** Split the store into the two shelves, each already ordered:
 *  active = live-first then last-run desc; previous = most recently shelved first
 *  (with a `lastActiveAt` tiebreak so the order is total). */
export function partitionProjects(
  projects: Project[],
  activities: Record<string, ProjectActivity>,
): { active: Project[]; previous: Project[] }

/** Name-or-path substring match, case-insensitive — the switcher's filter, now shared.
 *  Matching the PATH is what makes the three `fastrack` casings findable. */
export function matchProject(p: Project, query: string): boolean

/** Active projects with nothing running that haven't run in STALE_DAYS — what the tidy prompt
 *  will offer later. `now` is injectable so the boundary is testable. */
export function staleProjects(
  active: Project[],
  activities: Record<string, ProjectActivity>,
  now?: number,
): Project[]
```

**`archivedAt` does not exist on `Project` yet.** Reference it as an optional field that may be
absent — i.e. write `isActiveProject` against `p.archivedAt` and add the field to
`src/shared/types.ts` as part of THIS step (field only, nobody writes it yet):

```ts
/** When the user shelved this project. Absent = ACTIVE; present = PREVIOUS.
 *  A decision, never a measurement. Cleared automatically the moment a session launches
 *  here (upsertProject) — a running agent must never hide in a collapsed section. */
archivedAt?: string
```

While in `types.ts`, **fix the `lastActiveAt` doc comment** to say what it actually means:
"last time an agent ran or was restored here — *not* last opened." (`handleOpenProject` at
`DashboardView.tsx:385` never bumps it; only the 4 launch/restore sites do.) That misreading is
one refactor away from being a real bug.

---

## Rewire the two existing copies

Behaviour must be **identical** — this is a pure refactor.

- `src/renderer/components/sidebar/ProjectSwitcher.tsx:12` → import `FILTER_THRESHOLD`.
- `ProjectSwitcher.tsx:51-58` → the local sort + filter become `byActivityThenRecency` /
  `matchProject`.
- **Leave `ProjectGallery.tsx` alone in this step** — its sort moves out in step 3, and it needs a
  new `activities` prop first. Don't start that here.

---

## Tests — `src/renderer/lib/project-shelf.test.ts`

Follow the shape of the existing `project-status.test.ts`.

1. A project with **no `archivedAt` is active** — the direct back-compat assertion for all 19
   existing records in `~/.operator/projects.json`.
2. `archivedAt` set **+ `live > 0` → still active** (the auto-lift invariant).
3. `archivedAt` set **+ `activities[id] === undefined` → previous** (first-frame guard; the
   switcher already defends this at `:95`).
4. `partitionProjects` ordering: liveness beats recency; equal liveness falls to `lastActiveAt`
   desc; previous ordered by `archivedAt` desc with a `lastActiveAt` tiebreak.
5. `staleProjects`: excludes anything live, excludes anything already archived, hits the 14-day
   boundary exactly (inject `now`).
6. `matchProject` matches path as well as name, case-insensitively.

## Done when

- `npm test` green (new file + unchanged `format.test.ts`).
- `npm run build` clean (`tsc && vite build`).
- `node dev/drive-navigation.mjs` still passes — proves the switcher refactor changed nothing.

## Write your result to

`dev/briefs/shelf-1-foundations-RESULT.md` — what landed, anything you had to decide, anything
that surprised you. There is no other way for me to see your output.
