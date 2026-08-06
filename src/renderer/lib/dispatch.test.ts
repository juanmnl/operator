import { describe, it, expect } from 'vitest'
import { routeDispatch, liveLaneNames, pickLaneTab, dispatchNeedsApproval, COORDINATOR_ROLE_IDS, type RoutableTab, orphanTabs } from './dispatch'
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
