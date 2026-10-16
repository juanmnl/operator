import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProjectRail } from './ProjectRail'
import { projectActivity } from '../../lib/project-status'
import type { AgentSession, Project } from '../../../shared/types'

// A LANE SUSPENDED WHILE IDLE STAYS ON THE RAIL (QA 2026-10-16, D1). Its session's status is
// `ended`, and the rail's member filter dropped every ended session, so the dimmed row and the word
// "suspended" never rendered and the lane could only be reached with ⌘1-9. This renders the real
// rail with one live and one suspended lane and reads the rows.

let host: HTMLDivElement
let root: Root
const saved: Record<string, unknown> = {}

const project: Project = {
  id: 'proj1', path: '/tmp/proj1', name: 'proj1',
  createdAt: '2026-10-01T00:00:00Z', lastActiveAt: '2026-10-16T00:00:00Z',
  roster: [
    { id: 'research', name: 'Research' },
    { id: 'qa', name: 'QA' },
  ] as Project['roster'],
}

const session = (over: Partial<AgentSession>): AgentSession => ({
  id: 's', agentId: 'claude-code', workingDirectory: '/tmp/proj1', projectName: 'proj1',
  projectId: 'proj1', status: 'active', phase: 'waiting', activity: [],
  ...over,
} as AgentSession)

const render = async (sessions: AgentSession[], collapsed = false) => {
  await act(async () => {
    root.render(h(ProjectRail, {
      collapsed, animate: false,
      projects: [project],
      activities: { proj1: projectActivity(sessions, 2) },
      activeProjectId: null,
      onOpenProject: () => {}, onOpenProjectHome: () => {}, projectHomeActive: false,
      onShowGallery: () => {}, onOpenFolder: () => {}, onOpenAgents: () => {}, onOpenTuning: () => {},
      sessions,
    }))
  })
}

beforeEach(() => {
  const g = globalThis as Record<string, unknown>
  saved.ResizeObserver = g.ResizeObserver
  saved.IS_REACT_ACT_ENVIRONMENT = g.IS_REACT_ACT_ENVIRONMENT
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  const g = globalThis as Record<string, unknown>
  g.ResizeObserver = saved.ResizeObserver
  g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT
})

describe('the rail with a lane suspended while idle', () => {
  const live = session({ id: 'qa-1', roleId: 'qa', terminalId: 't2' })
  const asleep = session({ id: 'research-1', roleId: 'research', terminalId: 'suspended:k1', status: 'ended', suspended: true })

  it('keeps the suspended lane as a row that says "suspended"', async () => {
    await render([live, asleep])
    const text = host.textContent ?? ''
    expect(text).toContain('Research')
    expect(text).toContain('QA')
    expect(text.toLowerCase()).toContain('suspended')
  })

  it('keeps the project on the rail when its only lane is suspended', async () => {
    await render([asleep])
    expect(host.querySelector('[data-rail-project-header="proj1"]')).not.toBeNull()
    expect((host.textContent ?? '').toLowerCase()).toContain('suspended')
  })

  it('still drops a lane that ended for good', async () => {
    await render([live, session({ id: 'research-1', roleId: 'research', terminalId: 't1', status: 'ended' })])
    expect(host.textContent ?? '').not.toContain('Research')
  })
})
