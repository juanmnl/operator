import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RosterPanel, liveSectionLabel } from './RosterPanel'
import type { Project } from '../../../shared/types'

// THE TEAM TAB SAID "LIVE" FOR A LANE WITH NO CLI (QA 2026-10-16, O1; review L8). A suspended lane
// keeps its tab, so it was in `liveRoles` and drew as a live card with a LIVE pill under
// "Live · N". This renders the real roster with one live and one suspended lane.

let host: HTMLDivElement
let root: Root
let savedAct: unknown

const project: Project = {
  id: 'proj1', path: '/tmp/proj1', name: 'proj1',
  createdAt: '2026-10-01T00:00:00Z', lastActiveAt: '2026-10-16T00:00:00Z',
  roster: [
    { id: 'research', name: 'Research' },
    { id: 'design', name: 'Design' },
    { id: 'qa', name: 'QA' },
  ] as Project['roster'],
}

const render = async (suspendedRoles?: ReadonlySet<string>) => {
  await act(async () => {
    root.render(h(RosterPanel, {
      project,
      liveRoles: { research: 't1', design: 'suspended:k2' },
      suspendedRoles,
      laneSessions: { research: { phase: 'waiting' } },
    }))
  })
}

const pills = () => [...host.querySelectorAll('[data-lane-pill]')].map((e) => `${e.getAttribute('data-lane-pill')}:${e.textContent?.trim()}`)

beforeEach(() => {
  const g = globalThis as Record<string, unknown>
  savedAct = g.IS_REACT_ACT_ENVIRONMENT
  g.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = savedAct
})

describe('the Team roster with a suspended lane', () => {
  it('badges it suspended and counts only the running lane as live', async () => {
    await render(new Set(['design']))
    expect(pills()).toEqual(['live:waiting', 'suspended:suspended'])
    expect(host.textContent).toContain('Live · 1 · Suspended · 1')
  })

  it('reads as before when nothing is suspended', async () => {
    await render()
    expect(pills()).toEqual(['live:waiting', 'live:live'])
    expect(host.textContent).toContain('Live · 2')
  })
})

describe('liveSectionLabel', () => {
  it('names the suspended lanes, alone or after the running ones', () => {
    expect(liveSectionLabel(3, 0)).toBe('Live · 3')
    expect(liveSectionLabel(3, 1)).toBe('Live · 2 · Suspended · 1')
    expect(liveSectionLabel(2, 2)).toBe('Suspended · 2')
  })
})
