import { describe, it, expect } from 'vitest'
import type { ProjectTask } from '../../shared/types'
import { statusOf, isQueued, queuedCountsByRole, isStaleRunning, reconcileStaleRunning } from './task-lifecycle'

const task = (o: Partial<ProjectTask> = {}): ProjectTask =>
  ({ id: o.id ?? crypto.randomUUID(), text: 't', createdAt: '2026-01-01T00:00:00.000Z', ...o })

describe('statusOf / isQueued', () => {
  it('treats an absent status as queued (the schema default)', () => {
    expect(statusOf(task())).toBe('queued')
    expect(isQueued(task())).toBe(true)
    expect(isQueued(task({ status: 'running' }))).toBe(false)
    expect(isQueued(task({ status: 'done' }))).toBe(false)
  })
})

describe('queuedCountsByRole', () => {
  it('counts ONLY queued tasks — not running, not done', () => {
    // The reported "28 QUEUED" on a lane that was really 23 running + 7 done.
    const tasks = [
      task({ roleId: 'code', status: 'queued' }),
      task({ roleId: 'code', status: 'queued' }),
      task({ roleId: 'code', status: 'running' }),
      task({ roleId: 'code', status: 'done' }),
      task({ roleId: 'code' }), // absent status = queued
    ]
    expect(queuedCountsByRole(tasks)).toEqual({ code: 3 })
  })

  it('ignores unassigned tasks and handles an empty roster', () => {
    expect(queuedCountsByRole([task({ status: 'queued' })])).toEqual({})
    expect(queuedCountsByRole(undefined)).toEqual({})
  })
})

describe('isStaleRunning', () => {
  const live = new Set(['t1'])

  it('is false for a task running on a LIVE terminal', () => {
    expect(isStaleRunning(task({ status: 'running', terminalId: 't1' }), live)).toBe(false)
  })

  it('is TRUE for a task running on a terminal from a previous run', () => {
    // The permanent-strand case: the id was stamped, so the roleId fallback (which required
    // no terminalId) could never rescue it either.
    expect(isStaleRunning(task({ status: 'running', terminalId: 't9' }), live)).toBe(true)
  })

  it('is TRUE for a running task that was never stamped with a terminal', () => {
    expect(isStaleRunning(task({ status: 'running' }), live)).toBe(true)
  })

  it('never touches queued or done tasks', () => {
    expect(isStaleRunning(task({ status: 'queued', terminalId: 't9' }), live)).toBe(false)
    expect(isStaleRunning(task({ status: 'done', terminalId: 't9' }), live)).toBe(false)
    expect(isStaleRunning(task({ terminalId: 't9' }), live)).toBe(false)
  })
})

describe('reconcileStaleRunning', () => {
  const NOW = '2026-07-28T12:00:00.000Z'

  it('closes out tasks stranded by a restart, and marks WHY', () => {
    const tasks = [
      task({ id: 'a', status: 'running', terminalId: 'dead' }),
      task({ id: 'b', status: 'running', terminalId: 't1' }),
      task({ id: 'c', status: 'queued' }),
    ]
    const next = reconcileStaleRunning(tasks, new Set(['t1']), NOW)!
    expect(next.map((t) => [t.id, t.status])).toEqual([['a', 'done'], ['b', 'running'], ['c', 'queued']])
    // Honest about the difference between "its run ended" and "verified complete".
    expect(next[0].reconciledAt).toBe(NOW)
    expect(next[1].reconciledAt).toBeUndefined()
  })

  it('keeps an existing doneAt rather than rewriting history', () => {
    const tasks = [task({ status: 'running', terminalId: 'dead', doneAt: '2026-01-02T00:00:00.000Z' })]
    expect(reconcileStaleRunning(tasks, new Set(), NOW)![0].doneAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('returns the SAME array when nothing is stale, so no write is triggered', () => {
    const tasks = [task({ status: 'running', terminalId: 't1' }), task({ status: 'done' })]
    expect(reconcileStaleRunning(tasks, new Set(['t1']), NOW)).toBe(tasks)
    expect(reconcileStaleRunning(undefined, new Set(), NOW)).toBeUndefined()
  })

  it('clears a whole stranded project in one pass (the reported wreckage)', () => {
    // fastrack: 26 running, 0 done, no live terminals at all.
    const tasks = Array.from({ length: 26 }, (_, i) => task({ id: `x${i}`, status: 'running', terminalId: `t${i}` }))
    const next = reconcileStaleRunning(tasks, new Set(), NOW)!
    expect(next.every((t) => t.status === 'done' && t.reconciledAt === NOW)).toBe(true)
    expect(queuedCountsByRole(next)).toEqual({})
  })
})
