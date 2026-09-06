import { describe, it, expect } from 'vitest'
import {
  laneCloseDecision, planLaneCloses, type LaneSnapshot, type LaneClosePolicy,
  DEFAULT_KEEP_WARM_MINUTES, DEFAULT_QUIET_MINUTES,
  doneStampsFrom, DONE_SIGNAL_MAX_AGE_MS,
} from './lane-lifecycle'

const MIN = 60_000
const NOW = Date.parse('2026-08-06T12:00:00Z')
const ago = (mins: number) => new Date(NOW - mins * MIN).toISOString()

const POLICY: LaneClosePolicy = { keepWarmMs: 10 * MIN, quietMs: 120 * MIN }

const lane = (over: Partial<LaneSnapshot> = {}): LaneSnapshot => ({
  terminalId: 't1',
  roleId: 'code',
  projectId: 'p',
  phase: 'idle',
  lastActivityAt: ago(30),
  reportedDoneAt: ago(30),
  openWork: 0,
  ...over,
})

describe('lane close decision', () => {
  it('closes a lane that reported done and then went quiet for the grace window', () => {
    const d = laneCloseDecision(lane(), NOW, POLICY)
    expect(d.close).toBe(true)
    expect(d.close && d.reason).toBe('reported-done')
  })

  it('keeps it warm inside the window, measured from the LATER of report and activity', () => {
    // Reported 30 minutes ago but still talking two minutes ago: the tail of that turn must not
    // be cut. The window runs from the last thing that happened, not from the report.
    expect(laneCloseDecision(lane({ lastActivityAt: ago(2) }), NOW, POLICY).close).toBe(false)
    expect(laneCloseDecision(lane({ reportedDoneAt: ago(2) }), NOW, POLICY).close).toBe(false)
    // Exactly at the window: inclusive.
    expect(laneCloseDecision(lane({ lastActivityAt: ago(10), reportedDoneAt: ago(10) }), NOW, POLICY).close).toBe(true)
  })

  it('NEVER closes a lane in `waiting` — the one that would bite', () => {
    // A permission prompt on screen is indistinguishable from nothing to do. Reported done,
    // quiet for hours, and still not closable while the prompt is up.
    const d = laneCloseDecision(lane({ phase: 'waiting', lastActivityAt: ago(600), reportedDoneAt: ago(600) }), NOW, POLICY)
    expect(d.close).toBe(false)
    expect(d.why).toBe('waiting on you')
  })

  it('never closes a busy lane, however long ago it reported', () => {
    for (const phase of ['running', 'compacting']) {
      expect(laneCloseDecision(lane({ phase, lastActivityAt: ago(999) }), NOW, POLICY).close).toBe(false)
    }
  })

  it('does not close a lane that still holds open work', () => {
    // A new dispatch landed after the report: it is not finished, whatever it said a moment ago.
    const d = laneCloseDecision(lane({ openWork: 1 }), NOW, POLICY)
    expect(d.close).toBe(false)
    expect(d.why).toContain('1 task')
  })

  it('never closes the coordinator — it is long-lived by design, not task-scoped', () => {
    expect(laneCloseDecision(lane({ roleId: 'operator' }), NOW, POLICY).close).toBe(false)
    expect(laneCloseDecision(lane({ roleId: 'Orchestrator' }), NOW, POLICY).close).toBe(false)
  })

  it('never closes the lane you are looking at, or one whose pty already exited', () => {
    expect(laneCloseDecision(lane({ focused: true }), NOW, POLICY).close).toBe(false)
    expect(laneCloseDecision(lane({ ended: true }), NOW, POLICY).close).toBe(false)
  })

  it('never closes a lane with no tracked session — unknown is not idle', () => {
    expect(laneCloseDecision(lane({ phase: undefined }), NOW, POLICY).close).toBe(false)
  })

  describe('reported done vs went quiet — different facts, different outcomes', () => {
    const quiet = (mins: number) => lane({ reportedDoneAt: undefined, lastActivityAt: ago(mins) })

    it('a lane that never reported does NOT close on the short path', () => {
      const d = laneCloseDecision(quiet(30), NOW, POLICY)
      expect(d.close).toBe(false)
      expect(d.why).toBe('has not reported done')
    })

    it('…and closes on the long backstop, labelled as silence rather than success', () => {
      const d = laneCloseDecision(quiet(121), NOW, POLICY)
      expect(d.close).toBe(true)
      expect(d.close && d.reason).toBe('went-quiet')
    })

    it('the backstop is far longer than the grace window', () => {
      expect(DEFAULT_QUIET_MINUTES).toBeGreaterThan(DEFAULT_KEEP_WARM_MINUTES * 4)
    })
  })

  it('zero keep-warm turns auto-close OFF entirely, backstop included', () => {
    const off: LaneClosePolicy = { keepWarmMs: 0, quietMs: 120 * MIN }
    expect(laneCloseDecision(lane(), NOW, off).close).toBe(false)
    expect(laneCloseDecision(lane({ reportedDoneAt: undefined, lastActivityAt: ago(999) }), NOW, off).close).toBe(false)
  })
})

describe('the per-tick plan', () => {
  const many = Array.from({ length: 7 }, (_, i) => lane({
    terminalId: `t${i}`,
    lastActivityAt: ago(20 + i * 10),
    reportedDoneAt: ago(20 + i * 10),
  }))

  it('paces the closes and REPORTS what it held back — never a silent cap', () => {
    const plan = planLaneCloses(many, NOW, POLICY, 3)
    expect(plan.close).toHaveLength(3)
    expect(plan.deferred).toBe(4)
  })

  it('takes the quietest lanes first', () => {
    const plan = planLaneCloses(many, NOW, POLICY, 2)
    expect(plan.close.map((c) => c.lane.terminalId)).toEqual(['t6', 't5'])
  })

  it('carries each lane’s own reason, so the caller can treat the two differently', () => {
    const plan = planLaneCloses(
      [lane({ terminalId: 'a' }), lane({ terminalId: 'b', reportedDoneAt: undefined, lastActivityAt: ago(200) })],
      NOW, POLICY,
    )
    expect(plan.close.map((c) => [c.lane.terminalId, c.reason])).toEqual([
      ['b', 'went-quiet'],
      ['a', 'reported-done'],
    ])
  })
})

// THE DECISION: a `report` counts as done. Over a month the fleet called `report` 643 times and
// `task_status` 5 times, so keying the lifecycle on the latter meant no lane was ever closable by
// having FINISHED — only by the went-quiet timer.
describe('doneStampsFrom — what counts as "this lane said it finished"', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const lanes = [{ id: 't1', projectId: 'p1' }, { id: 't2', projectId: 'p2' }]

  it('stamps a lane from a REPORT alone — the report-only lane', () => {
    const out = doneStampsFrom([{ terminalId: 't1', projectId: 'p1', at: ago(1000) }], lanes, NOW)
    expect(out).toEqual({ t1: ago(1000) })
  })

  it('keeps the NEWEST signal when a lane reports several times', () => {
    const out = doneStampsFrom([
      { terminalId: 't1', at: ago(9000) },
      { terminalId: 't1', at: ago(1000) },
      { terminalId: 't1', at: ago(5000) },
    ], lanes, NOW)
    expect(out.t1).toBe(ago(1000))
  })

  it('IGNORES a signal older than an hour — terminal ids collide across runs', () => {
    // `t1` in this run and `t1` from a run yesterday are the same string and a different lane.
    expect(doneStampsFrom([{ terminalId: 't1', at: ago(DONE_SIGNAL_MAX_AGE_MS + 1) }], lanes, NOW)).toEqual({})
  })

  it('ignores a signal from the future, which is a clock problem and not a completion', () => {
    expect(doneStampsFrom([{ terminalId: 't1', at: new Date(NOW + 60_000).toISOString() }], lanes, NOW)).toEqual({})
  })

  it('refuses a signal whose project disagrees with the lane’s', () => {
    expect(doneStampsFrom([{ terminalId: 't1', projectId: 'p2', at: ago(1000) }], lanes, NOW)).toEqual({})
  })

  it('accepts a signal with NO project — a lane that reported before sessions.json caught up', () => {
    expect(doneStampsFrom([{ terminalId: 't1', at: ago(1000) }], lanes, NOW)).toEqual({ t1: ago(1000) })
  })

  it('ignores a signal for a lane that is not open here', () => {
    expect(doneStampsFrom([{ terminalId: 't99', at: ago(1000) }], lanes, NOW)).toEqual({})
  })

  it('ignores a signal with no terminal id and an unparseable timestamp', () => {
    expect(doneStampsFrom([{ at: ago(1000) }, { terminalId: 't1', at: 'nonsense' }], lanes, NOW)).toEqual({})
  })

  it('keeps lanes apart', () => {
    const out = doneStampsFrom([
      { terminalId: 't1', at: ago(1000) }, { terminalId: 't2', at: ago(2000) },
    ], lanes, NOW)
    expect(out).toEqual({ t1: ago(1000), t2: ago(2000) })
  })
})

describe('a report-only lane, end to end through the close policy', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('becomes closable on a report, once the keep-warm window passes', () => {
    const stamps = doneStampsFrom([{ terminalId: 't1', at: ago(20 * 60_000) }], [{ id: 't1' }], NOW)
    const lane = {
      terminalId: 't1', phase: 'idle' as const, openWork: 0,
      lastActivityAt: ago(20 * 60_000), reportedDoneAt: stamps.t1,
    }
    expect(laneCloseDecision(lane, NOW, { keepWarmMs: 10 * 60_000, quietMs: 6 * 60 * 60_000 }).close).toBe(true)
  })

  it('does NOT close while the same lane still has open work', () => {
    // The guard the decision does not weaken: a report is a statement about a message, not a
    // promise that the queue is empty.
    const stamps = doneStampsFrom([{ terminalId: 't1', at: ago(20 * 60_000) }], [{ id: 't1' }], NOW)
    const lane = {
      terminalId: 't1', phase: 'idle' as const, openWork: 2,
      lastActivityAt: ago(20 * 60_000), reportedDoneAt: stamps.t1,
    }
    const v = laneCloseDecision(lane, NOW, { keepWarmMs: 10 * 60_000, quietMs: 6 * 60 * 60_000 })
    expect(v.close).toBe(false)
    expect(v.why).toContain('still open')
  })
})
