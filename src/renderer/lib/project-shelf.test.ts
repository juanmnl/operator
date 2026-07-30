import { describe, it, expect } from 'vitest'
import type { Project } from '../../shared/types'
import type { ProjectActivity } from './project-status'
import {
  FILTER_THRESHOLD, STALE_DAYS,
  isActiveProject, byActivityThenRecency, partitionProjects, matchProject, staleProjects,
  shelvingMoves, closePlan,
  byRailOrder, reorderRail,
} from './project-shelf'

const NOW = Date.parse('2026-07-29T12:00:00.000Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString()

const p = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  path: `/Users/jane/Developer/${id}`,
  name: id,
  createdAt: daysAgo(90),
  lastActiveAt: daysAgo(1),
  ...over,
})

const act = (over: Partial<ProjectActivity> = {}): ProjectActivity =>
  ({ live: 0, waiting: 0, lanes: 6, status: 'idle', ...over })

describe('isActiveProject', () => {
  it('treats a record with no archivedAt as active', () => {
    // The back-compat assertion: every project on disk today predates the field.
    expect(isActiveProject(p('operator'))).toBe(true)
    expect(isActiveProject(p('operator'), act())).toBe(true)
  })

  it('lifts an archived project back to active while a session is live', () => {
    // The auto-lift invariant — a running agent must never hide in a collapsed section,
    // whatever the record says.
    const shelved = p('mantel', { archivedAt: daysAgo(3) })
    expect(isActiveProject(shelved, act({ live: 2, status: 'running' }))).toBe(true)
    expect(isActiveProject(shelved, act({ live: 0 }))).toBe(false)
  })

  it('reads a missing activity entry as nothing-live', () => {
    // First frame: the activity map isn't built yet. Undefined must not accidentally
    // un-shelve the whole Previous list.
    expect(isActiveProject(p('uwazi_web', { archivedAt: daysAgo(3) }), undefined)).toBe(false)
  })
})

describe('byActivityThenRecency', () => {
  it('puts live projects first, then falls to last-run desc', () => {
    const old = p('old', { lastActiveAt: daysAgo(40) })
    const recent = p('recent', { lastActiveAt: daysAgo(1) })
    const middle = p('middle', { lastActiveAt: daysAgo(10) })
    const sorted = [recent, middle, old]
      .sort(byActivityThenRecency({ old: act({ live: 1 }) }))
    expect(sorted.map((x) => x.id)).toEqual(['old', 'recent', 'middle'])
  })
})

describe('partitionProjects', () => {
  it('orders active by liveness then recency, previous by when it was shelved', () => {
    const projects = [
      p('quiet-recent', { lastActiveAt: daysAgo(2) }),
      p('quiet-old', { lastActiveAt: daysAgo(30) }),
      p('busy', { lastActiveAt: daysAgo(60) }),
      p('shelved-long-ago', { archivedAt: daysAgo(20), lastActiveAt: daysAgo(50) }),
      p('shelved-yesterday', { archivedAt: daysAgo(1), lastActiveAt: daysAgo(70) }),
    ]
    const { active, previous } = partitionProjects(projects, { busy: act({ live: 3 }) })
    // Liveness beats recency: `busy` ran two months ago and still leads.
    expect(active.map((x) => x.id)).toEqual(['busy', 'quiet-recent', 'quiet-old'])
    expect(previous.map((x) => x.id)).toEqual(['shelved-yesterday', 'shelved-long-ago'])
  })

  it('breaks an archivedAt tie on last run, so a bulk tidy still orders totally', () => {
    const at = daysAgo(5)
    const { previous } = partitionProjects([
      p('older-run', { archivedAt: at, lastActiveAt: daysAgo(60) }),
      p('newer-run', { archivedAt: at, lastActiveAt: daysAgo(20) }),
    ], {})
    expect(previous.map((x) => x.id)).toEqual(['newer-run', 'older-run'])
  })

  it('keeps a live archived project on the active shelf', () => {
    const { active, previous } = partitionProjects(
      [p('revived', { archivedAt: daysAgo(9) })],
      { revived: act({ live: 1 }) },
    )
    expect(active.map((x) => x.id)).toEqual(['revived'])
    expect(previous).toEqual([])
  })
})

describe('matchProject', () => {
  it('matches name and path, case-insensitively', () => {
    const proj = p('FastRack', { path: '/Users/jane/Developer/fastrack-api' })
    expect(matchProject(proj, 'fastrack')).toBe(true) // name, different casing
    expect(matchProject(proj, 'API')).toBe(true) // path only
    expect(matchProject(proj, 'Developer')).toBe(true)
    expect(matchProject(proj, 'mantel')).toBe(false)
  })

  it('matches everything on an empty or blank query', () => {
    expect(matchProject(p('operator'), '')).toBe(true)
    expect(matchProject(p('operator'), '   ')).toBe(true)
  })
})

describe('staleProjects', () => {
  it('hits the STALE_DAYS boundary exactly', () => {
    const list = [
      p('just-inside', { lastActiveAt: daysAgo(STALE_DAYS) }),
      p('just-outside', { lastActiveAt: new Date(NOW - (STALE_DAYS * DAY - 1)).toISOString() }),
    ]
    expect(staleProjects(list, {}, NOW).map((x) => x.id)).toEqual(['just-inside'])
  })

  it('excludes anything live and anything already shelved', () => {
    const list = [
      p('stale', { lastActiveAt: daysAgo(40) }),
      p('stale-but-live', { lastActiveAt: daysAgo(40) }),
      p('stale-but-shelved', { lastActiveAt: daysAgo(40), archivedAt: daysAgo(5) }),
    ]
    const stale = staleProjects(list, { 'stale-but-live': act({ live: 1 }) }, NOW)
    expect(stale.map((x) => x.id)).toEqual(['stale'])
  })
})

describe('FILTER_THRESHOLD', () => {
  it('is the switcher\'s existing threshold, so the refactor changes nothing', () => {
    expect(FILTER_THRESHOLD).toBe(8)
  })
})

// --- closing a project (dev/briefs/close-a-project.md) ------------------------------------
describe('shelvingMoves — the honesty check behind the Shelve toast', () => {
  it('says NO while a lane is live, because isActiveProject lifts it straight back', () => {
    // The bug: Shelve wrote the flag and claimed "It moves to Previous". With a live lane it
    // does not move at all — success toast, Undo button, no change.
    expect(shelvingMoves({ live: 1 } as ProjectActivity)).toBe(false)
    expect(shelvingMoves({ live: 3 } as ProjectActivity)).toBe(false)
  })

  it('says yes when nothing is running, including with no activity entry at all', () => {
    expect(shelvingMoves({ live: 0 } as ProjectActivity)).toBe(true)
    expect(shelvingMoves(undefined)).toBe(true)
  })

  it('agrees with isActiveProject — one rule, stated from two sides', () => {
    const shelved = { id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '', archivedAt: 'x' }
    for (const live of [0, 1, 2]) {
      const activity = { live } as ProjectActivity
      // A shelved project shows on Active exactly when shelving would NOT have moved it.
      expect(isActiveProject(shelved, activity)).toBe(!shelvingMoves(activity))
    }
  })
})

describe('closePlan — what Close will end', () => {
  const s = (o: Partial<{ id: string; projectId: string; status: string; phase: string; terminalId: string }>) =>
    ({ id: 'x', projectId: 'p', status: 'active', phase: 'waiting', terminalId: 't1', ...o })

  it('is a pure shelve when nothing is live', () => {
    expect(closePlan('p', [])).toEqual({ sessions: [], running: 0 })
    expect(closePlan('p', [s({ id: 'a', status: 'ended' })])).toEqual({ sessions: [], running: 0 })
  })

  it('collects every live lane of THIS project', () => {
    const plan = closePlan('p', [
      s({ id: 'a', terminalId: 't1' }),
      s({ id: 'b', terminalId: 't2' }),
    ])
    expect(plan.sessions).toEqual(['a', 'b'])
  })

  it('NEVER touches another project, which is the damage that would be unrecoverable', () => {
    const plan = closePlan('p', [
      s({ id: 'mine' }),
      s({ id: 'theirs', projectId: 'other' }),
      s({ id: 'orphan', projectId: undefined }), // unattributable — not ours to end
    ])
    expect(plan.sessions).toEqual(['mine'])
  })

  it('skips a session with no terminal — there is no pty to close', () => {
    expect(closePlan('p', [s({ id: 'a', terminalId: undefined })]).sessions).toEqual([])
  })

  it('counts mid-task lanes without blocking on them', () => {
    // Reported, never a modal: closing is reversible housekeeping, but ending a lane mid-turn
    // loses that turn's work, so the count is named in the toast rather than discovered after.
    const plan = closePlan('p', [
      s({ id: 'a', phase: 'running' }),
      s({ id: 'b', phase: 'compacting' }),
      s({ id: 'c', phase: 'waiting' }),
      s({ id: 'd', phase: 'idle' }),
    ])
    expect(plan.sessions).toHaveLength(4)
    expect(plan.running).toBe(2)
  })

  it('a closed project has nothing left to lift it onto Active', () => {
    // The sequence, as a property: once closePlan's sessions are gone, shelving MOVES.
    const plan = closePlan('p', [s({ id: 'a' })])
    expect(plan.sessions).toHaveLength(1)
    expect(shelvingMoves({ live: 0 } as ProjectActivity)).toBe(true)
  })
})

describe('rail order — the user places the tiles, nothing recomputes them', () => {
  const proj = (id: string, railOrder?: number): Project => ({
    id, path: `/x/${id}`, name: id,
    createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z',
    ...(railOrder === undefined ? {} : { railOrder }),
  })
  const ids = (list: Project[]) => list.map((p) => p.id)
  const sorted = (list: Project[]) => ids([...list].sort(byRailOrder))

  it('leaves a store nobody has dragged in its own order — no migration needed', () => {
    // Every existing projects.json looks like this: not one railOrder in it.
    const store = [proj('a'), proj('b'), proj('c')]
    expect(sorted(store)).toEqual(['a', 'b', 'c'])
  })

  it('does NOT use Infinity arithmetic — two unplaced projects must not compare as NaN', () => {
    // `(a ?? Infinity) - (b ?? Infinity)` is NaN, and a NaN comparator yields an arbitrary order
    // that looks fine on 3 items and shuffles on 20.
    expect(byRailOrder(proj('a'), proj('b'))).toBe(0)
    expect(Number.isNaN(byRailOrder(proj('a'), proj('b')))).toBe(false)
  })

  it('sorts placed projects before unplaced ones, so a new project lands at the END', () => {
    // The defined slot for a brand-new project, and for one that appears because something just
    // went live in it: after everything the user has arranged, never inside it.
    const store = [proj('fresh'), proj('placed', 1), proj('first', 0)]
    expect(sorted(store)).toEqual(['first', 'placed', 'fresh'])
  })

  it('moves a tile and stamps a TOTAL order across the whole store', () => {
    const store = [proj('a'), proj('b'), proj('c')]
    const next = reorderRail(store, 'c', 'a', 'before')
    expect(sorted(next)).toEqual(['c', 'a', 'b'])
    // Every project carries a number afterwards — not just the ones that moved.
    expect(next.every((p) => typeof p.railOrder === 'number')).toBe(true)
  })

  it('restamps projects that are OFF the rail too, so they cannot collide later', () => {
    // The bug this prevents: numbering only the visible tiles leaves an off-rail project holding
    // a stale index that now belongs to someone else — and it only shows when it comes back.
    const store = [proj('visible1'), proj('offrail'), proj('visible2')]
    const next = reorderRail(store, 'visible2', 'visible1', 'before')
    const orders = next.map((p) => p.railOrder)
    expect(new Set(orders).size).toBe(orders.length) // all distinct
    expect(sorted(next)).toEqual(['visible2', 'visible1', 'offrail'])
  })

  it('survives a round trip through JSON — this is what makes it durable', () => {
    const next = reorderRail([proj('a'), proj('b'), proj('c')], 'c', 'a', 'before')
    const reloaded = JSON.parse(JSON.stringify(next)) as Project[]
    expect(sorted(reloaded)).toEqual(['c', 'a', 'b'])
  })

  it('keeps a second drag stable rather than re-deriving from scratch', () => {
    let store = reorderRail([proj('a'), proj('b'), proj('c')], 'c', 'a', 'before') // c a b
    store = reorderRail(store, 'b', 'c', 'before') // b c a
    expect(sorted(store)).toEqual(['b', 'c', 'a'])
  })

  it('returns the SAME object for a project whose position did not change', () => {
    // The store's persist effect diffs serialized JSON; churning new objects would write on
    // every render.
    const store = reorderRail([proj('a'), proj('b')], 'a', 'b', 'after') // b a
    const again = reorderRail(store, 'a', 'b', 'after') // unchanged
    expect(again[0]).toBe(store[0])
    expect(again[1]).toBe(store[1])
  })

  it('is a no-op when a tile is dropped on itself', () => {
    const store = [proj('a', 0), proj('b', 1)]
    expect(ids(reorderRail(store, 'a', 'a', 'before'))).toEqual(['a', 'b'])
    expect(sorted(reorderRail(store, 'a', 'a', 'before'))).toEqual(['a', 'b'])
  })
})
