import { describe, it, expect } from 'vitest'
import { currentTaskOf } from './session-task'
import type { AgentSession, Project, TodoItem } from '../../shared/types'

const session = (o: Partial<AgentSession>): AgentSession => ({
  id: 's1', agentId: 'claude-code', workingDirectory: '/p', projectName: 'p',
  status: 'active', phase: 'running', activity: [], activeSubagents: 0,
  lastToolName: null, startedAt: '', lastActivityAt: '', terminalId: 't1', ...o,
} as AgentSession)

const todo = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

describe('currentTaskOf', () => {
  it('prefers the in-progress plan item', () => {
    const s = session({ todos: [todo('first', 'completed'), todo('doing now', 'in_progress'), todo('later', 'pending')], summary: 'the first prompt' })
    expect(currentTaskOf(s)).toBe('doing now')
  })

  // The bug: a plan grows over time, so taking the first match shows work that
  // finished long ago and makes the lane look stuck.
  it('takes the LAST in-progress item, not the first', () => {
    const s = session({ todos: [todo('older', 'in_progress'), todo('newer', 'in_progress')] })
    expect(currentTaskOf(s)).toBe('newer')
  })

  it('falls back to the most recently COMPLETED item when nothing is in progress', () => {
    const s = session({ todos: [todo('step one', 'completed'), todo('step two', 'completed')], summary: 'the first prompt' })
    expect(currentTaskOf(s)).toBe('step two')
  })

  it('uses a running project task on THIS lane when there is no plan', () => {
    const project = { tasks: [
      { id: 'a', text: 'other lane', status: 'running', terminalId: 't9' },
      { id: 'b', text: 'earlier', status: 'running', terminalId: 't1' },
      { id: 'c', text: 'latest', status: 'running', terminalId: 't1' },
      { id: 'd', text: 'done one', status: 'done', terminalId: 't1' },
    ] } as unknown as Project
    expect(currentTaskOf(session({ summary: 'the first prompt' }), project)).toBe('latest')
  })

  it('falls back to the summary only as a last resort', () => {
    expect(currentTaskOf(session({ summary: 'the first prompt' }))).toBe('the first prompt')
    expect(currentTaskOf(session({}))).toBeUndefined()
  })
})
