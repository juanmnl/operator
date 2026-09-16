import { describe, it, expect } from 'vitest'
import type { ArtifactReport, Project, ProjectTask } from '../../shared/types'
import { dispatchedTasks } from './plan-dispatches'

const task = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 'x', text: 'Do the thing', roleId: 'code', status: 'running', source: 'mcp-dispatch',
  createdAt: '2026-09-16T10:00:00Z', startedAt: '2026-09-16T10:00:00Z', ...over,
})

const project = (id: string, tasks: ProjectTask[]): Project => ({
  id, name: id, path: `/p/${id}`, lastActiveAt: '2026-09-16T00:00:00Z', tasks,
  roster: [{ id: 'code', name: 'Code' }, { id: 'qa', name: 'QA' }],
} as Project)

const report = (over: Partial<ArtifactReport> = {}): ArtifactReport => ({
  id: 1, at: '2026-09-16T11:00:00Z', terminalId: 't1', projectId: 'a', roleId: 'code',
  taskId: 'x', summary: 'done', artifacts: '[]', ...over,
})

describe('dispatchedTasks — scoping', () => {
  it('lists only the named project’s tasks', () => {
    const projects = [project('a', [task({ id: 'a1' })]), project('b', [task({ id: 'b1' })])]
    expect(dispatchedTasks(projects, 'a', []).map((r) => r.id)).toEqual(['a1'])
    expect(dispatchedTasks(projects, 'b', []).map((r) => r.id)).toEqual(['b1'])
    expect(dispatchedTasks(projects, 'missing', [])).toEqual([])
  })

  it('lists only tasks created through mcp dispatch, not backlog or sentinel tasks', () => {
    const projects = [project('a', [task({ id: 'bus' }), task({ id: 'backlog', source: undefined })])]
    expect(dispatchedTasks(projects, 'a', []).map((r) => r.id)).toEqual(['bus'])
  })

  it('attaches the newest report for the task, and ignores reports filed under another project', () => {
    const projects = [project('a', [task({ id: 'x' })])]
    const rows = dispatchedTasks(projects, 'a', [
      report({ id: 7, at: '2026-09-16T11:00:00Z' }),
      report({ id: 9, at: '2026-09-16T12:00:00Z' }),
      report({ id: 12, at: '2026-09-16T13:00:00Z', projectId: 'b' }),
    ])
    expect(rows[0].reportId).toBe(9)
    expect(dispatchedTasks(projects, 'a', [report({ projectId: 'b' })])[0].reportId).toBeUndefined()
  })

  it('names the lane from the roster, falling back to its id', () => {
    const projects = [project('a', [task({ id: 'k', roleId: 'qa' }), task({ id: 'g', roleId: 'gone', startedAt: '2026-09-16T09:00:00Z' })])]
    expect(dispatchedTasks(projects, 'a', []).map((r) => r.lane)).toEqual(['QA', 'gone'])
  })
})

describe('dispatchedTasks — ordering', () => {
  it('orders blocked, running, queued, done, abandoned', () => {
    const projects = [project('a', [
      task({ id: 'done', status: 'done' }),
      task({ id: 'queued', status: 'queued' }),
      task({ id: 'abandoned', status: 'abandoned' }),
      task({ id: 'running', status: 'running' }),
      task({ id: 'blocked', status: 'running', blockedAt: '2026-09-16T10:30:00Z' }),
    ])]
    expect(dispatchedTasks(projects, 'a', []).map((r) => [r.id, r.status])).toEqual([
      ['blocked', 'blocked'], ['running', 'running'], ['queued', 'queued'], ['done', 'done'], ['abandoned', 'abandoned'],
    ])
  })

  it('puts the most recently started first within a status', () => {
    const projects = [project('a', [
      task({ id: 'old', startedAt: '2026-09-16T08:00:00Z' }),
      task({ id: 'new', startedAt: '2026-09-16T12:00:00Z' }),
      task({ id: 'queuedOnly', status: 'queued', startedAt: undefined, createdAt: '2026-09-16T13:00:00Z' }),
    ])]
    expect(dispatchedTasks(projects, 'a', []).map((r) => r.id)).toEqual(['new', 'old', 'queuedOnly'])
  })

  it('treats a missing status as queued, and a blocked stamp on a finished task as finished', () => {
    const projects = [project('a', [
      task({ id: 'none', status: undefined }),
      task({ id: 'doneAfterBlock', status: 'done', blockedAt: '2026-09-16T10:30:00Z' }),
    ])]
    expect(dispatchedTasks(projects, 'a', []).map((r) => r.status)).toEqual(['queued', 'done'])
  })
})
