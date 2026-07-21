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
