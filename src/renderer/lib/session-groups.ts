import type { AgentSession, Project } from '../../shared/types'

export interface SessionGroup {
  /** Stable identity: the projectId, or a `name:` key for legacy sessions without one. */
  key: string
  name: string
  /** The resolved project, when the session carried a known projectId (supplies the roster). */
  project?: Project
  sessions: AgentSession[]
}

/** Bucket live sessions by their project, newest work first.
 *
 *  Keying mirrors the sidebar's (projectId, basename fallback) so both surfaces agree on
 *  what counts as one project — two folders sharing a basename stay apart, and a worktree
 *  lane groups under its source repo. Groups are ordered by their most recent activity and
 *  rows within a group by recency, so what you touched last is top on both axes. */
export function groupSessionsByProject(sessions: AgentSession[], projects?: Project[]): SessionGroup[] {
  const projectById = new Map((projects ?? []).map((p) => [p.id, p]))
  const groups = new Map<string, SessionGroup>()
  for (const s of sessions) {
    const project = s.projectId ? projectById.get(s.projectId) : undefined
    const key = s.projectId || `name:${s.projectName || 'Unknown'}`
    const existing = groups.get(key)
    if (existing) existing.sessions.push(s)
    else groups.set(key, { key, name: project?.name || s.projectName || 'Unknown', project, sessions: [s] })
  }
  const lastActive = (g: SessionGroup) => g.sessions.reduce((max, s) => (s.lastActivityAt > max ? s.lastActivityAt : max), '')
  return [...groups.values()]
    .map((g) => ({ ...g, sessions: [...g.sessions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)) }))
    .sort((a, b) => lastActive(b).localeCompare(lastActive(a)))
}
