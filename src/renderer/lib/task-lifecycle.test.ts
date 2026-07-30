import { describe, it, expect } from 'vitest'
import type { ProjectTask } from '../../shared/types'
import {
  statusOf, isQueued, isClosed, queuedCountsByRole,
  liveLaneOf, isStaleRunning, reconcileStaleRunning, type LiveLane,
} from './task-lifecycle'

const task = (o: Partial<ProjectTask> = {}): ProjectTask =>
  ({ id: o.id ?? crypto.randomUUID(), text: 't', createdAt: '2026-01-01T00:00:00.000Z', ...o })

/** A live lane, as the hydrate path builds them. */
const lane = (o: Partial<LiveLane> = {}): LiveLane =>
  ({ terminalId: 't1', claudeSessionId: 'uuid-1', roleId: 'code', projectId: 'p1', ...o })

describe('statusOf / isQueued / isClosed', () => {
  it('treats an absent status as queued (the schema default)', () => {
    expect(statusOf(task())).toBe('queued')
    expect(isQueued(task())).toBe(true)
    expect(isQueued(task({ status: 'running' }))).toBe(false)
    expect(isQueued(task({ status: 'done' }))).toBe(false)
    expect(isQueued(task({ status: 'abandoned' }))).toBe(false)
  })

  it('treats done and abandoned alike as closed — neither is actionable', () => {
    expect(isClosed(task({ status: 'done' }))).toBe(true)
    expect(isClosed(task({ status: 'abandoned' }))).toBe(true)
    expect(isClosed(task({ status: 'running' }))).toBe(false)
    expect(isClosed(task())).toBe(false)
  })
})

describe('queuedCountsByRole', () => {
  it('counts ONLY queued tasks — not running, not done, not abandoned', () => {
    // The reported "28 QUEUED" on a lane that was really 23 running + 7 done.
    const tasks = [
      task({ roleId: 'code', status: 'queued' }),
      task({ roleId: 'code', status: 'queued' }),
      task({ roleId: 'code', status: 'running' }),
      task({ roleId: 'code', status: 'done' }),
      task({ roleId: 'code', status: 'abandoned' }),
      task({ roleId: 'code' }), // absent status = queued
    ]
    expect(queuedCountsByRole(tasks)).toEqual({ code: 3 })
  })

  it('ignores unassigned tasks and handles an empty roster', () => {
    expect(queuedCountsByRole([task({ status: 'queued' })])).toEqual({})
    expect(queuedCountsByRole(undefined)).toEqual({})
  })
})

describe('liveLaneOf — liveness is keyed on the SESSION, not the terminal', () => {
  const lanes = [lane()]

  it('matches on claudeSessionId', () => {
    expect(liveLaneOf(task({ status: 'running', claudeSessionId: 'uuid-1' }), lanes)).toBe(lanes[0])
    expect(liveLaneOf(task({ status: 'running', claudeSessionId: 'uuid-9' }), lanes)).toBeUndefined()
  })

  it('IGNORES terminalId once a session id is stamped — this is the collision fix', () => {
    // Measured in the real store: `t5` is held by three different sessions across three runs.
    // A task from an old run must not look alive merely because this run reused the counter.
    const old = task({ status: 'running', claudeSessionId: 'uuid-from-last-week', terminalId: 't1' })
    expect(liveLaneOf(old, lanes)).toBeUndefined()
  })

  it('falls back to terminal + role for tasks stamped before the session id existed', () => {
    expect(liveLaneOf(task({ status: 'running', terminalId: 't1', roleId: 'code' }), lanes)).toBe(lanes[0])
    // Same terminal, different role → not this lane's task.
    expect(liveLaneOf(task({ status: 'running', terminalId: 't1', roleId: 'qa' }), lanes)).toBeUndefined()
    // Different terminal entirely.
    expect(liveLaneOf(task({ status: 'running', terminalId: 't9', roleId: 'code' }), lanes)).toBeUndefined()
  })

  it('cannot match a legacy task that was never stamped with a terminal', () => {
    expect(liveLaneOf(task({ status: 'running' }), lanes)).toBeUndefined()
  })
})

describe('isStaleRunning', () => {
  const lanes = [lane()]

  it('is false for a task running on a live lane', () => {
    expect(isStaleRunning(task({ status: 'running', claudeSessionId: 'uuid-1' }), lanes)).toBe(false)
  })

  it('is TRUE for a task whose session is gone', () => {
    expect(isStaleRunning(task({ status: 'running', claudeSessionId: 'uuid-gone' }), lanes)).toBe(true)
  })

  it('never touches queued, done or abandoned tasks', () => {
    for (const status of ['queued', 'done', 'abandoned'] as const) {
      expect(isStaleRunning(task({ status, claudeSessionId: 'uuid-gone' }), lanes)).toBe(false)
    }
    expect(isStaleRunning(task({ claudeSessionId: 'uuid-gone' }), lanes)).toBe(false)
  })
})

describe('reconcileStaleRunning', () => {
  const NOW = '2026-07-30T12:00:00.000Z'
  const lanes = [lane()]

  it('ABANDONS a task whose lane is gone — never claims it is done', () => {
    const tasks = [
      task({ id: 'a', status: 'running', claudeSessionId: 'uuid-gone' }),
      task({ id: 'b', status: 'running', claudeSessionId: 'uuid-1' }),
      task({ id: 'c', status: 'queued' }),
    ]
    const next = reconcileStaleRunning(tasks, lanes, NOW)!
    expect(next.map((t) => [t.id, t.status])).toEqual([
      ['a', 'abandoned'], ['b', 'running'], ['c', 'queued'],
    ])
    // "its run ended", not "verified complete" — and no doneAt is invented.
    expect(next[0].reconciledAt).toBe(NOW)
    expect(next[0].doneAt).toBeUndefined()
  })

  it('ADOPTS a legacy task whose lane is still alive, stamping the liveness key', () => {
    // The case that protects in-flight work: 15 tasks on my own live lane must not be closed
    // out from under it just because they predate claudeSessionId.
    const tasks = [task({ id: 'a', status: 'running', terminalId: 't1', roleId: 'code' })]
    const next = reconcileStaleRunning(tasks, lanes, NOW)!
    expect(next[0].status).toBe('running')
    expect(next[0].claudeSessionId).toBe('uuid-1')
    expect(next[0].reconciledAt).toBeUndefined()
  })

  it('is IDEMPOTENT — a second pass changes nothing and returns the same reference', () => {
    const tasks = [
      task({ status: 'running', claudeSessionId: 'uuid-gone' }),
      task({ status: 'running', terminalId: 't1', roleId: 'code' }),
      task({ status: 'done' }),
    ]
    const once = reconcileStaleRunning(tasks, lanes, NOW)!
    expect(once).not.toBe(tasks)
    const twice = reconcileStaleRunning(once, lanes, NOW)
    expect(twice).toBe(once) // same array ⇒ the caller skips the write
  })

  it('returns the SAME array when nothing needs reconciling', () => {
    const tasks = [task({ status: 'running', claudeSessionId: 'uuid-1' }), task({ status: 'done' })]
    expect(reconcileStaleRunning(tasks, lanes, NOW)).toBe(tasks)
    expect(reconcileStaleRunning(undefined, lanes, NOW)).toBeUndefined()
  })

  it('clears a whole stranded project in one pass, with no live lanes at all', () => {
    const tasks = Array.from({ length: 26 }, (_, i) =>
      task({ id: `x${i}`, status: 'running', claudeSessionId: `gone-${i}` }))
    const next = reconcileStaleRunning(tasks, [], NOW)!
    expect(next.every((t) => t.status === 'abandoned' && t.reconciledAt === NOW)).toBe(true)
    expect(queuedCountsByRole(next)).toEqual({})
  })

  it('does not resurrect an already-abandoned task', () => {
    const tasks = [task({ status: 'abandoned', reconciledAt: '2026-07-01T00:00:00.000Z' })]
    expect(reconcileStaleRunning(tasks, lanes, NOW)).toBe(tasks)
  })
})
