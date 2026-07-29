import { describe, it, expect } from 'vitest'
import { routeDispatch, liveLaneNames, type RoutableTab } from './dispatch'
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
