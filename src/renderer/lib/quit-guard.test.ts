import { describe, it, expect } from 'vitest'
import { quitGuardCopy, quitGuardRows, ROW_CAP, type QuitLane, type QuitRequest } from './quit-guard'

const lane = (over: Partial<QuitLane> = {}): QuitLane => ({
  terminalId: 't1',
  project: 'operator',
  projectId: 'p1',
  phase: 'running',
  lastActivityAt: '2026-08-14T10:00:00.000Z',
  ...over,
})

const req = (lanes: QuitLane[], idle = 0): QuitRequest => ({ lanes, idle })

describe('title — three compositions, both pluralisations', () => {
  it('names working agents when anything is mid-turn', () => {
    expect(quitGuardCopy(req([lane()])).title).toBe('1 agent is still working')
    expect(quitGuardCopy(req([lane(), lane({ terminalId: 't2' })])).title).toBe('2 agents are still working')
  })

  it('says "waiting on you" only when NOTHING is mid-turn', () => {
    const w = (id: string) => lane({ terminalId: id, phase: 'waiting' })
    expect(quitGuardCopy(req([w('t1')])).title).toBe('1 agent is waiting on you')
    expect(quitGuardCopy(req([w('t1'), w('t2')])).title).toBe('2 agents are waiting on you')
    // One working lane is the story even when two are waiting.
    expect(quitGuardCopy(req([w('t1'), w('t2'), lane({ terminalId: 't3' })])).title)
      .toBe('3 agents are still working')
  })

  it('counts a compacting lane as working', () => {
    expect(quitGuardCopy(req([lane({ phase: 'compacting' })])).title).toBe('1 agent is still working')
  })
})

describe('body and verb — singular and plural', () => {
  it('claims the turn in flight and nothing bigger', () => {
    expect(quitGuardCopy(req([lane()])).body).toBe(
      'Quitting ends it. Whatever it’s in the middle of is lost — its worktree and transcript stay on disk.',
    )
    expect(quitGuardCopy(req([lane(), lane({ terminalId: 't2' })])).body).toBe(
      'Quitting ends all of them. Whatever each one is in the middle of is lost — their worktrees and transcripts stay on disk.',
    )
  })

  it('names what happens to the things just listed', () => {
    expect(quitGuardCopy(req([lane()])).quitVerb).toBe('Quit and end it')
    expect(quitGuardCopy(req([lane(), lane({ terminalId: 't2' })])).quitVerb).toBe('Quit and end them')
    // The safe verb names the outcome, not the cancellation — and never changes.
    expect(quitGuardCopy(req([lane()])).stayVerb).toBe('Stay open')
    expect(quitGuardCopy(req([lane()])).hint).toBe('⌥⌘Q quits without asking')
  })
})

describe('the idle addendum', () => {
  it('is absent when nothing idle will be ended', () => {
    expect(quitGuardCopy(req([lane()], 0)).idle).toBeNull()
  })

  it('counts idle lanes in one line, both pluralisations', () => {
    expect(quitGuardCopy(req([lane()], 1)).idle).toBe('1 idle agent will be ended too.')
    expect(quitGuardCopy(req([lane()], 4)).idle).toBe('4 idle agents will be ended too.')
  })
})

describe('the six-row cap and its remainder', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => lane({ terminalId: `t${i}` }))

  it('shows every row up to the cap, with no overflow line', () => {
    for (const n of [1, 2, ROW_CAP]) {
      const r = quitGuardRows(req(many(n)))
      expect(r.rows).toHaveLength(n)
      expect(r.more).toBe(0)
      expect(quitGuardCopy(req(many(n))).overflow).toBeNull()
    }
  })

  it('caps at six and counts the rest', () => {
    const r = quitGuardRows(req(many(10)))
    expect(r.rows).toHaveLength(ROW_CAP)
    expect(r.more).toBe(4)
    expect(quitGuardCopy(req(many(10))).overflow).toBe('and 4 more')
    expect(quitGuardCopy(req(many(7))).overflow).toBe('and 1 more')
  })
})

describe('row ordering — the cap must never hide the worst', () => {
  it('sorts running before compacting before waiting', () => {
    const lanes = [
      lane({ terminalId: 'w', phase: 'waiting' }),
      lane({ terminalId: 'c', phase: 'compacting' }),
      lane({ terminalId: 'r', phase: 'running' }),
    ]
    expect(quitGuardRows(req(lanes)).rows.map((r) => r.terminalId)).toEqual(['r', 'c', 'w'])
  })

  it('sorts most-recently-active first inside a bucket', () => {
    const lanes = [
      lane({ terminalId: 'old', lastActivityAt: '2026-08-14T09:00:00.000Z' }),
      lane({ terminalId: 'new', lastActivityAt: '2026-08-14T11:00:00.000Z' }),
      lane({ terminalId: 'mid', lastActivityAt: '2026-08-14T10:00:00.000Z' }),
    ]
    expect(quitGuardRows(req(lanes)).rows.map((r) => r.terminalId)).toEqual(['new', 'mid', 'old'])
  })

  it('keeps a running lane on screen when seven waiting ones would fill the list', () => {
    const lanes = [
      ...Array.from({ length: 7 }, (_, i) => lane({ terminalId: `w${i}`, phase: 'waiting' })),
      lane({ terminalId: 'r', phase: 'running' }),
    ]
    expect(quitGuardRows(req(lanes)).rows[0].terminalId).toBe('r')
  })
})

describe('the project suffix', () => {
  it('is omitted when every lane is in one project', () => {
    const lanes = [lane({ terminalId: 'a' }), lane({ terminalId: 'b' })]
    const rows = quitGuardRows(req(lanes), () => ({ name: 'Code' })).rows
    expect(rows.map((r) => r.name)).toEqual(['Code', 'Code'])
  })

  it('is appended to every row once lanes span two projects', () => {
    const lanes = [
      lane({ terminalId: 'a', projectId: 'p1', project: 'operator' }),
      lane({ terminalId: 'b', projectId: 'p2', project: 'herdr' }),
    ]
    const rows = quitGuardRows(req(lanes), () => ({ name: 'Code' })).rows
    expect(rows.map((r) => r.name)).toEqual(['Code · operator', 'Code · herdr'])
  })

  it('separates ad-hoc lanes (no project id) by their folder name', () => {
    const lanes = [
      lane({ terminalId: 'a', projectId: '', project: 'scratch' }),
      lane({ terminalId: 'b', projectId: '', project: 'other' }),
    ]
    const identify = (id: string) => ({ name: id === 'a' ? 'Code' : 'Review' })
    expect(quitGuardRows(req(lanes), identify).rows.map((r) => r.name)).toEqual(['Code · scratch', 'Review · other'])
  })

  /** Caught by the WebKit probe, not by this file: an unmatched lane falls back to the project
   *  as its NAME, so appending the project suffix said the same word twice. */
  it('does not repeat the project when the fallback name already is the project', () => {
    const lanes = [
      lane({ terminalId: 'a', projectId: 'p1', project: 'operator' }),
      lane({ terminalId: 'b', projectId: 'p2', project: 'herdr' }),
    ]
    expect(quitGuardRows(req(lanes)).rows.map((r) => r.name)).toEqual(['operator', 'herdr'])
    // …and a lane it CAN name still gets the suffix in the same list.
    const identify = (id: string) => (id === 'a' ? { name: 'Code' } : undefined)
    expect(quitGuardRows(req(lanes), identify).rows.map((r) => r.name)).toEqual(['Code · operator', 'herdr'])
  })
})

describe('rows render even when the frontend knows nothing about the lane', () => {
  it('falls back to the phase word for state', () => {
    const lanes = [
      lane({ terminalId: 'r', phase: 'running' }),
      lane({ terminalId: 'c', phase: 'compacting' }),
      lane({ terminalId: 'w', phase: 'waiting' }),
    ]
    expect(quitGuardRows(req(lanes)).rows.map((r) => r.state))
      .toEqual(['Working', 'Compacting context', 'Your turn'])
  })

  it('falls back to the payload project for the name', () => {
    expect(quitGuardRows(req([lane({ project: 'operator' })])).rows[0].name).toBe('operator')
  })

  it('prefers what the frontend resolved when it can match the lane', () => {
    const identify = (id: string) => (id === 't1' ? { name: 'Review', state: 'Editing', accent: '#f0f' } : undefined)
    const rows = quitGuardRows(req([lane({ terminalId: 't1' }), lane({ terminalId: 't2' })]), identify).rows
    expect(rows[0]).toMatchObject({ name: 'Review', state: 'Editing', accent: '#f0f' })
    expect(rows[1]).toMatchObject({ name: 'operator', state: 'Working', accent: undefined })
  })

  it('never emits a phase StatusWave cannot animate', () => {
    expect(quitGuardRows(req([lane({ phase: 'nonsense' })])).rows[0].phase).toBe('running')
  })
})
