import { describe, it, expect } from 'vitest'
import { groupSessionsByProject } from './session-groups'
import type { AgentSession, Project } from '../../shared/types'

const s = (id: string, at: string, over: Partial<AgentSession> = {}): AgentSession => ({
  id, agentId: 'claude-code', workingDirectory: '/p', projectName: 'p',
  status: 'active', phase: 'idle', activity: [], activeSubagents: 0, lastToolName: null,
  startedAt: at, lastActivityAt: at, ...over,
} as AgentSession)

const proj = (id: string, name: string): Project =>
  ({ id, path: `/${name}`, name, createdAt: 't', lastActiveAt: 't' })

describe('groupSessionsByProject', () => {
  it('buckets by projectId and titles each group from the projects store', () => {
    const groups = groupSessionsByProject(
      [s('a', '3', { projectId: 'p1' }), s('b', '2', { projectId: 'p2' }), s('c', '1', { projectId: 'p1' })],
      [proj('p1', 'operator'), proj('p2', 'el-encanto')],
    )
    expect(groups.map((g) => [g.name, g.sessions.length])).toEqual([['operator', 2], ['el-encanto', 1]])
  })

  it('orders groups by most recent activity, and rows within a group by recency', () => {
    const groups = groupSessionsByProject(
      [s('old', '1', { projectId: 'p1' }), s('mid', '2', { projectId: 'p2' }), s('new', '3', { projectId: 'p1' })],
      [proj('p1', 'one'), proj('p2', 'two')],
    )
    // p1 holds the newest session ('3') so it leads, and its own rows are newest-first.
    expect(groups.map((g) => g.name)).toEqual(['one', 'two'])
    expect(groups[0].sessions.map((x) => x.id)).toEqual(['new', 'old'])
  })

  it('falls back to a name key for legacy sessions with no projectId', () => {
    // Two folders sharing a basename must not merge — that is why the key is the id first.
    const groups = groupSessionsByProject([s('a', '1', { projectName: 'app' }), s('b', '2', { projectId: 'p1' })], [proj('p1', 'app')])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.key)).toEqual(['p1', 'name:app'])
  })

  it('survives an unknown projectId and an empty input', () => {
    expect(groupSessionsByProject([], [])).toEqual([])
    const [g] = groupSessionsByProject([s('a', '1', { projectId: 'gone', projectName: 'ghost' })], [])
    expect([g.key, g.name, g.project]).toEqual(['gone', 'ghost', undefined])
  })
})
