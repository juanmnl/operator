import { describe, it, expect } from 'vitest'
import { projectActivity, projectActivityLabel } from './project-status'

const s = (phase: string, status = 'active') => ({ status, phase })

describe('projectActivity', () => {
  it('rolls up to the busiest lane', () => {
    expect(projectActivity([s('idle'), s('running'), s('waiting')]).status).toBe('running')
    expect(projectActivity([s('idle'), s('waiting')]).status).toBe('waiting')
    expect(projectActivity([s('idle'), s('idle')]).status).toBe('idle')
  })

  it('ignores ended sessions in both the count and the roll-up', () => {
    const a = projectActivity([s('running', 'ended'), s('idle')])
    expect(a.live).toBe(1)
    expect(a.status).toBe('idle')
  })

  it('counts waiting lanes separately from the roll-up', () => {
    // The orb says "running" (busiest) while two lanes still want the user — which is
    // exactly why the label reads off `waiting`, not off `status`.
    const a = projectActivity([s('running'), s('waiting'), s('waiting')])
    expect(a.status).toBe('running')
    expect(a.waiting).toBe(2)
  })

  it('is idle with no sessions', () => {
    expect(projectActivity([], 6)).toEqual({ live: 0, waiting: 0, lanes: 6, status: 'idle' })
  })
})

describe('projectActivityLabel', () => {
  it('says "needs you" even when other lanes are running', () => {
    expect(projectActivityLabel(projectActivity([s('running'), s('waiting')], 6)))
      .toEqual({ text: '1 needs you', accent: true })
  })

  it('falls back to running, then to the roster size', () => {
    expect(projectActivityLabel(projectActivity([s('running'), s('running')], 6)))
      .toEqual({ text: '2 running', accent: true })
    expect(projectActivityLabel(projectActivity([], 6))).toEqual({ text: '6 lanes', accent: false })
    expect(projectActivityLabel(projectActivity([], 1))).toEqual({ text: '1 lane', accent: false })
  })

  it('says nothing for a project with no lanes and nothing running', () => {
    expect(projectActivityLabel(projectActivity([], 0))).toBeNull()
  })
})
