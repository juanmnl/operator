import { describe, it, expect } from 'vitest'
import { routeDispatch, liveLaneNames, pickLaneTab, dispatchNeedsApproval, COORDINATOR_ROLE_IDS, type RoutableTab, orphanTabs, tabRunsIn, markReleased, isReleased, reusableLane } from './dispatch'
import type { Role } from '../../shared/types'

const roster: Role[] = [
  { id: 'operator', name: 'Operator', model: 'fable' },
  { id: 'code', name: 'Code', model: 'opus' },
  { id: 'research', name: 'Research', model: 'sonnet' },
]

const tab = (o: Partial<RoutableTab> & { id: string }): RoutableTab =>
  ({ projectId: 'p1', ...o })

describe('routeDispatch', () => {
  it('sends to a live lane for the target role (by id)', () => {
    const tabs = [tab({ id: 't1', roleId: 'code' })]
    const r = routeDispatch('code', roster, tabs, 'p1')
    expect(r.kind).toBe('send')
    if (r.kind === 'send') { expect(r.role.id).toBe('code'); expect(r.tab.id).toBe('t1') }
  })

  it('resolves the role case-insensitively by name', () => {
    const tabs = [tab({ id: 't1', roleId: 'code' })]
    expect(routeDispatch('CODE', roster, tabs, 'p1').kind).toBe('send')
  })

  it('queues when the role is defined but has no live lane', () => {
    const r = routeDispatch('code', roster, [], 'p1')
    expect(r.kind).toBe('queue')
    if (r.kind === 'queue') expect(r.role.id).toBe('code')
  })

  // Bug 4: an ended tab lingers mounted; it must NOT be treated as a live lane, or the task
  // is written into a dead pty and silently lost.
  it('does NOT send to an ENDED lane — it queues instead', () => {
    const tabs = [tab({ id: 't1', roleId: 'code', ended: true })]
    const r = routeDispatch('code', roster, tabs, 'p1')
    expect(r.kind).toBe('queue')
  })

  it('ignores a live lane in a DIFFERENT project', () => {
    const tabs = [tab({ id: 't1', roleId: 'code', projectId: 'other' })]
    expect(routeDispatch('code', roster, tabs, 'p1').kind).toBe('queue')
  })

  it('is unassigned when no role matches the token', () => {
    expect(routeDispatch('nonesuch', roster, [], 'p1').kind).toBe('unassigned')
  })
})

describe('liveLaneNames', () => {
  it('lists running lanes in the project, excluding the dispatcher', () => {
    const tabs = [
      tab({ id: 'src', roleId: 'operator' }),
      tab({ id: 't1', roleId: 'code' }),
      tab({ id: 't2', roleId: 'research' }),
    ]
    expect(liveLaneNames(tabs, roster, 'p1', 'src')).toEqual(['Code', 'Research'])
  })

  it('excludes ended lanes (never advertise a dead lane as running)', () => {
    const tabs = [
      tab({ id: 't1', roleId: 'code', ended: true }),
      tab({ id: 't2', roleId: 'research' }),
    ]
    expect(liveLaneNames(tabs, roster, 'p1', 'src')).toEqual(['Research'])
  })

  it('excludes tabs whose roleId is not in the roster', () => {
    const tabs = [tab({ id: 't1', roleId: 'ghost' })]
    expect(liveLaneNames(tabs, roster, 'p1', 'src')).toEqual([])
  })
})

describe('routeDispatch against an EMPTY roster (rosters no longer auto-seed)', () => {
  const tabs: Array<{ id: string; projectId?: string; roleId?: string; ended?: boolean }> = []

  it('creates a lane from its template when the token names a preset', () => {
    const r = routeDispatch('code', [], tabs, 'p1')
    expect(r.kind).toBe('create')
    if (r.kind !== 'create') throw new Error('unreachable')
    // The tuned template, not a bare shell — model/effort/accent/charter all arrive with it.
    expect(r.role).toMatchObject({ id: 'code', name: 'Code', model: 'opus', effort: 'high' })
    expect(r.role.prompt).toBeTruthy()
  })

  it('matches a preset by NAME and case-insensitively, like a real lane', () => {
    expect(routeDispatch('Design', [], tabs, 'p1').kind).toBe('create')
    expect(routeDispatch('QA', [], tabs, 'p1').kind).toBe('create')
  })

  it('does NOT invent a lane for a typo — that goes to the visible backlog', () => {
    expect(routeDispatch('cod', [], tabs, 'p1').kind).toBe('unassigned')
    expect(routeDispatch('frontend', [], tabs, 'p1').kind).toBe('unassigned')
  })

  it('prefers an EXISTING lane over the template of the same name', () => {
    const mine = [{ id: 'code', name: 'Code', model: 'haiku', effort: 'low' as const }]
    const r = routeDispatch('code', mine, tabs, 'p1')
    expect(r.kind).toBe('queue')
    if (r.kind !== 'queue') throw new Error('unreachable')
    expect(r.role.model).toBe('haiku') // the user's tuning wins, not the preset's
  })
})

describe('pickLaneTab — deterministic duplicate resolution', () => {
  // Duplicates shouldn't exist any more (the launch path reuses a live lane), but the real
  // store held 4-5 sessions per role, so which one is "the lane" has to be DEFINED rather
  // than left to array order.
  const tab = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, projectId: 'p1', roleId: 'code', ...over })

  it('prefers the most recently ACTIVE of several live duplicates', () => {
    const tabs = [
      tab('a', { lastActivityAt: '2026-07-01T00:00:00Z' }),
      tab('c', { lastActivityAt: '2026-07-30T00:00:00Z' }),
      tab('b', { lastActivityAt: '2026-07-15T00:00:00Z' }),
    ]
    expect(pickLaneTab(tabs, 'p1', 'code')?.id).toBe('c')
    // Order of the input must not change the answer.
    expect(pickLaneTab([...tabs].reverse(), 'p1', 'code')?.id).toBe('c')
  })

  it('never returns an ended lane, or one from another project or role', () => {
    expect(pickLaneTab([tab('a', { ended: true })], 'p1', 'code')).toBeUndefined()
    expect(pickLaneTab([tab('a', { projectId: 'other' })], 'p1', 'code')).toBeUndefined()
    expect(pickLaneTab([tab('a', { roleId: 'qa' })], 'p1', 'code')).toBeUndefined()
  })

  it('falls back to the latest in input order when activity is unknown', () => {
    expect(pickLaneTab([tab('a'), tab('b')], 'p1', 'code')?.id).toBe('b')
    // A real timestamp beats an absent one regardless of position.
    expect(pickLaneTab([tab('a', { lastActivityAt: '2026-07-01T00:00:00Z' }), tab('b')], 'p1', 'code')?.id).toBe('a')
  })

  it('routeDispatch resolves through it — the two cannot disagree', () => {
    const roster = [{ id: 'code', name: 'Code', model: 'opus' }]
    const tabs = [
      tab('old', { lastActivityAt: '2026-07-01T00:00:00Z' }),
      tab('new', { lastActivityAt: '2026-07-30T00:00:00Z' }),
    ]
    const route = routeDispatch('code', roster, tabs, 'p1')
    expect(route.kind).toBe('send')
    expect(route.kind === 'send' && route.tab.id).toBe('new')
  })
})

describe('dispatchNeedsApproval — a read-only lane must not commission work', () => {
  it('lets the COORDINATOR dispatch unsupervised — that is its job', () => {
    expect(dispatchNeedsApproval('operator')).toBe(false)
    expect(dispatchNeedsApproval('orchestrator')).toBe(false) // pre-rename id, still on old rosters
    expect(dispatchNeedsApproval('OPERATOR')).toBe(false)     // ids are compared case-insensitively
  })

  it('HOLDS every other lane, including the ones caught doing it', () => {
    // The real store: 16 dispatches from research, 3 design, 2 code, 2 qa.
    for (const role of ['research', 'code', 'design', 'qa', 'review']) {
      expect(dispatchNeedsApproval(role)).toBe(true)
    }
  })

  it('HOLDS an unidentified sender rather than trusting it', () => {
    // An ad-hoc session with no lane is still an agent emitting a directive.
    expect(dispatchNeedsApproval(undefined)).toBe(true)
    expect(dispatchNeedsApproval('')).toBe(true)
  })

  it('is keyed on role ID, not on charter text', () => {
    // Charter text is advisory: Research's already said "never change code", and it complied
    // literally while dispatching Code to build what it had specced.
    expect(COORDINATOR_ROLE_IDS).toEqual(['operator', 'orchestrator'])
  })
})

// THE BUG STATE, named. A live pty whose tab lost its stamping is invisible to `pickLaneTab`, so
// routing answers `queue` — indistinguishable from "no lane running" unless something asks.
describe('orphanTabs', () => {
  const tab = (o: Partial<{ id: string; projectId: string; roleId: string; ended: boolean }>) =>
    ({ id: 't1', ...o }) as never

  it('finds a live tab missing its project or its role', () => {
    const tabs = [
      tab({ id: 'ok', projectId: 'p', roleId: 'code' }),
      tab({ id: 'no-project', roleId: 'code' }),
      tab({ id: 'no-role', projectId: 'p' }),
      tab({ id: 'neither' }),
    ]
    expect(orphanTabs(tabs).map((t: { id: string }) => t.id)).toEqual(['no-project', 'no-role', 'neither'])
  })

  it('ignores ENDED tabs — a dead pty with no label is not a routing bug', () => {
    expect(orphanTabs([tab({ id: 'dead', ended: true })])).toEqual([])
  })

  it('is empty in the healthy case', () => {
    expect(orphanTabs([tab({ projectId: 'p', roleId: 'code' })])).toEqual([])
  })
})

// X6 (dev/results/lane-instances-and-message-mixing-2026-09-25.md): routing trusted a tab's project
// LABEL alone, so a tab labelled uwazi/design whose pty runs in mantel would be picked as uwazi's
// Design and handed that mantel session.
describe('a tab is a project\'s lane only if it runs in that project', () => {
  const uwazi = '/Users/x/Developer/huridocs/uwazi_app'
  const mantel = '/Users/x/Developer/mantel'
  it('skips a tab labelled with the project whose pty runs in ANOTHER project', () => {
    const tabs = [{ id: 't4', projectId: 'uwazi', roleId: 'design', cwd: mantel }]
    const paths = { own: uwazi, others: [mantel] }
    expect(pickLaneTab(tabs, 'uwazi', 'design', paths)).toBeUndefined()
    expect(routeDispatch('design', [{ id: 'design', name: 'Design' }], tabs, 'uwazi', paths).kind).toBe('queue')
  })

  it('keeps a lane whose project was MOVED, whose directory matches no project (review A5)', () => {
    const moved = { id: 't6', projectId: 'uwazi', roleId: 'design', cwd: '/Users/x/old-place/uwazi_app' }
    expect(pickLaneTab([moved], 'uwazi', 'design', { own: uwazi, others: [mantel] })).toBe(moved)
  })

  it('compares case-insensitively, as the default macOS volume does', () => {
    expect(tabRunsIn({ cwd: '/Users/x/Developer/HURIDOCS/uwazi_app' }, { own: uwazi, others: [mantel] })).toBe(true)
    expect(tabRunsIn({ cwd: '/Users/x/Developer/MANTEL/src' }, { own: uwazi, others: [mantel] })).toBe(false)
  })

  it('a project nested in another: the most specific path decides', () => {
    const outer = '/Users/x/Developer/mono', inner = '/Users/x/Developer/mono/apps/site'
    expect(tabRunsIn({ cwd: `${inner}/src` }, { own: outer, others: [inner] })).toBe(false) // runs in the inner project
    expect(tabRunsIn({ cwd: `${inner}/src` }, { own: inner, others: [outer] })).toBe(true)
    expect(tabRunsIn({ cwd: `${outer}/lib` }, { own: outer, others: [inner] })).toBe(true)
  })

  it('accepts a main-checkout lane under the project path and a worktree lane whose source is the project', () => {
    const main = { id: 't1', projectId: 'uwazi', roleId: 'design', cwd: `${uwazi}/` }
    const wt = { id: 't2', projectId: 'uwazi', roleId: 'code', cwd: '/Users/x/.operator/worktrees/uwazi_app-464540', sourceCwd: uwazi }
    expect(pickLaneTab([main], 'uwazi', 'design', uwazi)).toBe(main)
    expect(pickLaneTab([wt], 'uwazi', 'code', uwazi)).toBe(wt)
  })

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    expect(tabRunsIn({ cwd: `${uwazi}-old` }, { own: `${uwazi}-old-other`, others: [uwazi] })).toBe(true) // matches nothing
    expect(tabRunsIn({ cwd: `${uwazi}-landing` }, { own: uwazi, others: [`${uwazi}-landing`] })).toBe(false)
  })

  it('gives a tab with no directory, or a caller with no project path, the benefit of the doubt', () => {
    expect(tabRunsIn({}, uwazi)).toBe(true)
    expect(tabRunsIn({ cwd: '/elsewhere' }, undefined)).toBe(true)
  })
})

// A worktree lane that called `worktree_done` keeps running, idle, in a directory removed when it
// ends; its brief forbids branching again there. Dispatching to its role retires it (idle) or
// refuses (mid-turn). Only the release record qualifies.
describe('routeDispatch — a lane that released its worktree', () => {
  const released = (phase: string | undefined, o: Partial<RoutableTab> = {}) =>
    tab({ id: 't1', roleId: 'code', released: true, phase, ...o })

  it('RETIRES an idle released lane (between turns) so a fresh one is launched', () => {
    for (const phase of ['waiting', 'idle']) {
      const r = routeDispatch('code', roster, [released(phase)], 'p1')
      expect(r.kind, phase).toBe('retire')
      if (r.kind === 'retire') { expect(r.tab.id).toBe('t1'); expect(r.role.id).toBe('code') }
    }
  })

  it('never ends a BUSY released lane: mid-turn, compacting or asking is `finishing`', () => {
    for (const phase of ['running', 'compacting', 'asking']) {
      const r = routeDispatch('code', roster, [released(phase)], 'p1')
      expect(r.kind, phase).toBe('finishing')
      if (r.kind === 'finishing') expect(r.unseen).toBe(false)
    }
  })

  it('an UNSEEN released lane (no phase) is `finishing` and marked unseen, never retired', () => {
    const r = routeDispatch('code', roster, [released(undefined)], 'p1')
    expect(r.kind).toBe('finishing')
    if (r.kind === 'finishing') expect(r.unseen).toBe(true)
  })

  // L2 / H1: something happened in the last few seconds the transcript may not show yet.
  it('an idle released lane that is still SETTLING is not retired yet', () => {
    expect(routeDispatch('code', roster, [released('waiting', { settling: true })], 'p1').kind).toBe('finishing')
  })

  // L3: a lane a retire is already under way for reads as ended, so the next dispatch launches
  // (and joins that relaunch) instead of retiring it twice.
  it('a lane being retired (marked ended) routes to a launch', () => {
    expect(routeDispatch('code', roster, [released('waiting', { ended: true })], 'p1').kind).toBe('queue')
  })

  it('leaves a lane WITHOUT a release unchanged, whatever its phase', () => {
    for (const phase of ['waiting', 'idle', 'running', undefined]) {
      expect(routeDispatch('code', roster, [tab({ id: 't1', roleId: 'code', phase })], 'p1').kind).toBe('send')
    }
  })

  it('never touches another project\'s released lane', () => {
    const other = released('waiting', { projectId: 'p2' })
    expect(routeDispatch('code', roster, [other], 'p1').kind).toBe('queue')
    // And a dispatch in p2 to its own released lane does not reach p1's live one.
    const mine = tab({ id: 't9', roleId: 'code' })
    const r = routeDispatch('code', roster, [mine, other], 'p2')
    expect(r.kind).toBe('retire')
    if (r.kind === 'retire') expect(r.tab.id).toBe('t1')
    expect(routeDispatch('code', roster, [mine, other], 'p1').kind).toBe('send')
  })

  it('an ENDED released lane is no lane at all: the role is launched as before', () => {
    expect(routeDispatch('code', roster, [released('waiting', { ended: true })], 'p1').kind).toBe('queue')
  })
})

describe('markReleased', () => {
  type WtTab = RoutableTab & { worktreeBranch?: string }
  const wtLane = (o: Partial<WtTab> = {}): WtTab => ({
    id: 't1', projectId: 'p1', roleId: 'code', cwd: '/wt/proj-abc', sourceCwd: '/src/proj', worktreeBranch: 'operator/abc', ...o,
  })
  const row = (o: Partial<{ terminalId: string; projectId: string | null; path: string }> = {}) =>
    ({ terminalId: 't1', projectId: 'p1', path: '/wt/proj-abc', ...o })

  it('marks the worktree lane whose terminal AND directory match an open release', () => {
    expect(markReleased([wtLane()], [row()])[0].released).toBe(true)
    // Trailing slash and case differences are the same directory, as elsewhere in routing.
    expect(markReleased([wtLane()], [row({ path: '/WT/proj-abc/' })])[0].released).toBe(true)
    expect(markReleased([wtLane()], [row({ projectId: null })])[0].released).toBe(true)
  })

  it('does not mark on a terminal id alone, a directory alone, or another project', () => {
    expect(markReleased([wtLane()], [row({ path: '/wt/proj-other' })])[0].released).toBeUndefined()
    expect(markReleased([wtLane()], [row({ terminalId: 't2' })])[0].released).toBeUndefined()
    expect(markReleased([wtLane()], [row({ projectId: 'p2' })])[0].released).toBeUndefined()
  })

  it('never marks a lane in the main checkout, even with a matching row', () => {
    const main = wtLane({ cwd: '/src/proj', sourceCwd: '/src/proj' })
    expect(markReleased([main], [row({ path: '/src/proj' })])[0].released).toBeUndefined()
    const noBranch = wtLane({ worktreeBranch: undefined })
    expect(markReleased([noBranch], [row()])[0].released).toBeUndefined()
  })

  it('leaves the other tabs as they were', () => {
    const other = wtLane({ id: 't2', cwd: '/wt/proj-def' })
    const out = markReleased([wtLane(), other], [row()])
    expect(out[1]).toBe(other)
  })
})

// H2: the relaunch for a retired lane must never type its brief into another live tab of the role.
describe('reusableLane', () => {
  const dup = tab({ id: 't2', roleId: 'code', lastActivityAt: '2026-09-27T10:00:00Z' })
  it('reuses the live lane on a normal launch', () => {
    expect(reusableLane([dup], 'p1', 'code')?.id).toBe('t2')
  })
  it('reuses NOTHING when replacing a retired lane, even with a duplicate live on the role', () => {
    const dupReleased = tab({ id: 't3', roleId: 'code', released: true, phase: 'waiting' })
    expect(reusableLane([dup, dupReleased], 'p1', 'code', undefined, 't1')).toBeUndefined()
  })
})

describe('isReleased', () => {
  it('answers markReleased for one tab', () => {
    const t = { id: 't1', projectId: 'p1', cwd: '/wt/a', sourceCwd: '/src', worktreeBranch: 'operator/a' }
    expect(isReleased(t, [{ terminalId: 't1', path: '/wt/a' }])).toBe(true)
    expect(isReleased(t, [])).toBe(false)
  })
})
