import { describe, it, expect } from 'vitest'
import { sessionWaveStatus } from './session-status'
import { projectActivity, projectActivityLabel } from './project-status'
import { quitGuardRows, quitGuardCopy } from './quit-guard'
import { chatSignal } from './chat-signal'
import { isBetweenTurns } from './comms'

// `asking` reaching every renderer consumer of a session phase.

const lane = (terminalId: string, phase: string, lastActivityAt = '2026-09-16T10:00:00Z') =>
  ({ terminalId, project: 'thing', projectId: 'p1', phase, lastActivityAt })

describe('asking — renderer consumers', () => {
  it('maps to its own orb status, and ended still wins', () => {
    expect(sessionWaveStatus({ status: 'active', phase: 'asking' })).toBe('asking')
    expect(sessionWaveStatus({ status: 'ended', phase: 'asking' })).toBe('ended')
  })

  it('outranks running on the project orb and counts as needing you', () => {
    const a = projectActivity([{ status: 'active', phase: 'running' }, { status: 'active', phase: 'asking' }])
    expect(a.status).toBe('asking')
    expect(a.waiting).toBe(1)
    expect(projectActivityLabel(a)?.text).toBe('1 needs you')
  })

  it('sorts first in the quit guard and is named', () => {
    const { rows } = quitGuardRows({ lanes: [lane('a', 'running', '2026-09-16T11:00:00Z'), lane('b', 'asking')], idle: 0 })
    expect(rows.map((r) => r.terminalId)).toEqual(['b', 'a'])
    expect(rows[0].phase).toBe('asking')
    expect(rows[0].state).toBe('Asking you')
    expect(quitGuardCopy({ lanes: [lane('b', 'asking')], idle: 0 }).title).toBe('1 agent is waiting on you')
  })

  it('has a chat signal', () => {
    expect(chatSignal({ status: 'active', phase: 'asking', lastToolName: 'AskUserQuestion', activeSubagents: 0 } as never)?.label).toBe('Asking you')
  })

  it('is NOT between turns: nothing may be typed into a lane whose question dialog is up', () => {
    expect(isBetweenTurns('asking')).toBe(false)
    expect(isBetweenTurns('waiting')).toBe(true)
  })
})
