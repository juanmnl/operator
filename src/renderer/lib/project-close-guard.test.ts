import { describe, it, expect } from 'vitest'
import { closeGuardCopy, closeGuardRows, type CloseGuardLane } from './project-close-guard'
import { ROW_CAP } from './quit-guard'

const lane = (over: Partial<CloseGuardLane> = {}): CloseGuardLane => ({
  terminalId: 't1',
  name: 'Code',
  phase: 'waiting',
  suspended: false,
  lastActivityAt: '2026-10-24T10:00:00.000Z',
  ...over,
})

describe('closeGuardCopy', () => {
  it('one lane: names it as its agent, and the end verb says it', () => {
    const c = closeGuardCopy('web27', 1, 0)
    expect(c.title).toBe('Close web27 and end its agent?')
    expect(c.body).toBe('Its CLI stops and its worktree folder is removed. Unsaved changes are committed to its branch first. Branches, roster, tasks and notes stay.')
    expect(c.endVerb).toBe('End it and close')
    expect(c.keepVerb).toBe('Keep running')
    expect(c.hint).toBe('Esc to keep')
  })

  it('N lanes: counts them in the title and the end verb', () => {
    const c = closeGuardCopy('web27', 4, 0)
    expect(c.title).toBe('Close web27 and end 4 agents?')
    expect(c.body.startsWith('Each agent’s CLI stops')).toBe(true)
    expect(c.endVerb).toBe('End 4 and close')
  })

  it('all waiting: no mid-turn line', () => {
    expect(closeGuardCopy('web27', 3, 0).midTurn).toBeNull()
  })

  it('mid-turn > 0: says how many and what is lost', () => {
    expect(closeGuardCopy('web27', 4, 2).midTurn).toBe('2 are mid-turn. The work in those turns is lost.')
    expect(closeGuardCopy('web27', 4, 1).midTurn).toBe('1 is mid-turn. That turn’s work is lost.')
    expect(closeGuardCopy('web27', 1, 1).midTurn).toBe('It is mid-turn. That turn’s work is lost.')
  })

  it('over ROW_CAP: counts the lanes that got no row', () => {
    expect(closeGuardCopy('web27', ROW_CAP, 0).overflow).toBeNull()
    expect(closeGuardCopy('web27', ROW_CAP + 3, 0).overflow).toBe('and 3 more')
  })

  it('no sentence starts with a word left alone on its line', () => {
    for (const c of [closeGuardCopy('p', 1, 1), closeGuardCopy('p', 4, 1), closeGuardCopy('p', 4, 3)]) {
      for (const text of [c.body, c.midTurn ?? '']) {
        for (const m of text.matchAll(/\. (\S+)(.)/g)) expect(m[2], text).toBe(' ')
      }
    }
  })
})

describe('closeGuardRows', () => {
  it('puts mid-turn lanes first, then waiting, idle, suspended', () => {
    const rows = closeGuardRows([
      lane({ terminalId: 's', phase: 'idle', suspended: true }),
      lane({ terminalId: 'i', phase: 'idle' }),
      lane({ terminalId: 'w', phase: 'waiting' }),
      lane({ terminalId: 'r', phase: 'running' }),
      lane({ terminalId: 'a', phase: 'asking' }),
    ]).rows
    expect(rows.map((r) => r.terminalId)).toEqual(['a', 'r', 'w', 'i', 's'])
    expect(rows.map((r) => r.state)).toEqual(['asking you', 'working', 'waiting on you', 'idle', 'suspended'])
    expect(rows.map((r) => r.wave)).toEqual(['asking', 'running', 'waiting', 'idle', 'ended'])
  })

  it('orders most recent first inside a bucket', () => {
    const rows = closeGuardRows([
      lane({ terminalId: 'old', lastActivityAt: '2026-10-24T09:00:00.000Z' }),
      lane({ terminalId: 'new', lastActivityAt: '2026-10-24T11:00:00.000Z' }),
    ]).rows
    expect(rows.map((r) => r.terminalId)).toEqual(['new', 'old'])
  })

  it('caps at ROW_CAP and keeps a mid-turn lane on screen', () => {
    const lanes = [
      ...Array.from({ length: ROW_CAP + 2 }, (_, i) => lane({ terminalId: `w${i}` })),
      lane({ terminalId: 'r', phase: 'running' }),
    ]
    const { rows, more } = closeGuardRows(lanes)
    expect(rows).toHaveLength(ROW_CAP)
    expect(more).toBe(3)
    expect(rows[0].terminalId).toBe('r')
  })
})
