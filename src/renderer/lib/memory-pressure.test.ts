import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  reducePressure, bannerVisible, autoSuspendAllowed, bannerCopy, joinSentences, NORMAL_BANNER, DISMISSAL_KEPT_MS,
  type PressureBanner, type PressureEvent,
} from './memory-pressure'
import { suspendDecision, planSuspends, needsPortCheck, suspendPlanned, withCap, SUSPEND_STEP_CAP_MS, type SuspendCandidate, type PassSteps } from './idle-suspend'

const run = (...events: PressureEvent[]): PressureBanner => events.reduce(reducePressure, NORMAL_BANNER)
const lvl = (level: 1 | 2 | 4, at = 0): PressureEvent => ({ type: 'level', level, at })
const DISMISS: PressureEvent = { type: 'dismiss' }

describe('memory pressure: the banner state', () => {
  it('is hidden at normal and shows at warn', () => {
    expect(bannerVisible(NORMAL_BANNER)).toBe(false)
    expect(bannerVisible(run(lvl(2)))).toBe(true)
    expect(bannerVisible(run(lvl(4)))).toBe(true)
  })

  it('stays dismissed while the level stays up', () => {
    expect(bannerVisible(run(lvl(2), DISMISS))).toBe(false)
    expect(bannerVisible(run(lvl(2), DISMISS, lvl(2)))).toBe(false)
    // Critical back down to warn does not bring it back either.
    expect(bannerVisible(run(lvl(4), DISMISS, lvl(2)))).toBe(false)
  })

  it('shows again on the next rise from normal', () => {
    expect(bannerVisible(run(lvl(2), DISMISS, lvl(1, 1000), lvl(2, 1000 + DISMISSAL_KEPT_MS)))).toBe(true)
    // Never dismissed: shown on any rise, however soon.
    expect(bannerVisible(run(lvl(2), lvl(1, 1000), lvl(2, 2000)))).toBe(true)
  })

  it('stays dismissed across a quick drop to normal and back (review L1)', () => {
    const s = run(lvl(2), DISMISS, lvl(1, 1000), lvl(2, 1000 + DISMISSAL_KEPT_MS - 1))
    expect(bannerVisible(s)).toBe(false)
    // A rise to critical still shows it.
    expect(bannerVisible(reducePressure(s, lvl(4, 1000 + DISMISSAL_KEPT_MS)))).toBe(true)
    // The hold is counted from the last drop, and is not carried past a rise that showed it.
    expect(bannerVisible(run(lvl(2), DISMISS, lvl(1, 0), lvl(4, 10), lvl(1, 20), lvl(2, 30)))).toBe(true)
  })

  it('shows again when warn rises to critical, since lanes may now be suspended', () => {
    expect(bannerVisible(run(lvl(2), DISMISS, lvl(4)))).toBe(true)
  })

  it('hides at normal and forgets the count', () => {
    const s = run(lvl(4), { type: 'suspended', count: 3 }, lvl(1))
    expect(bannerVisible(s)).toBe(false)
    expect(s).toEqual(NORMAL_BANNER)
    expect(run(lvl(4), DISMISS, lvl(1, 50))).toEqual({ ...NORMAL_BANNER, dismissedDropAt: 50 })
    expect(run(lvl(4), { type: 'suspended', count: 3 }, lvl(1), lvl(2)).suspended).toBe(0)
  })

  it('counts suspends across passes while the level is up, and ignores them at normal', () => {
    expect(run(lvl(4), { type: 'suspended', count: 2 }, { type: 'suspended', count: 0 }, { type: 'suspended', count: 1 }).suspended).toBe(3)
    expect(run({ type: 'suspended', count: 2 }).suspended).toBe(0)
    expect(run(DISMISS)).toEqual(NORMAL_BANNER)
  })
})

describe('memory pressure: automatic suspension', () => {
  it('runs only at critical, and never while idle suspension is Off', () => {
    expect(autoSuspendAllowed(4, 30)).toBe(true)
    expect(autoSuspendAllowed(4, 0)).toBe(false)
    expect(autoSuspendAllowed(2, 30)).toBe(false)
    expect(autoSuspendAllowed(1, 30)).toBe(false)
  })
})

describe('memory pressure: the copy', () => {
  const NB = ' '
  it('says memory is low, how many lanes run, and offers the button with its count', () => {
    const c = bannerCopy(run(lvl(2)), { running: 14, eligible: 6, autoOff: false })
    expect(c.text).toBe(`Memory is low. 14${NB}lanes are${NB}running.`)
    expect(c.action).toBe('Suspend 6 idle lanes')
    expect(bannerCopy(run(lvl(2)), { running: 1, eligible: 1, autoOff: false }).action).toBe('Suspend 1 idle lane')
  })

  it('says so instead of offering a button when no lane is eligible', () => {
    const c = bannerCopy(run(lvl(2)), { running: 3, eligible: 0, autoOff: false })
    expect(c.action).toBeUndefined()
    expect(c.text).toContain(`None${NB}of them can be suspended right${NB}now.`)
  })

  it('offers no button while the count is being read', () => {
    expect(bannerCopy(run(lvl(2)), { running: 3, autoOff: false }).action).toBeUndefined()
  })

  it('states how many were suspended at critical', () => {
    const c = bannerCopy(run(lvl(4), { type: 'suspended', count: 5 }), { running: 9, eligible: 0, autoOff: false })
    expect(c.text).toBe(`Memory is critically low. 9${NB}lanes are running. Suspended${NB}5 idle lanes. No${NB}other lane can be suspended right${NB}now.`)
  })

  it('says idle suspension is off at critical when it is, and keeps the button', () => {
    const c = bannerCopy(run(lvl(4)), { running: 9, eligible: 4, autoOff: true })
    expect(c.text).toContain(`Idle${NB}suspension is off in`)
    expect(c.action).toBe('Suspend 4 idle lanes')
  })

  it('never starts a sentence or ends the text on a word that can wrap alone', () => {
    expect(joinSentences(['One two.', 'Three four five.'])).toBe(`One two. Three${NB}four${NB}five.`)
    expect(joinSentences(['Alone.'])).toBe('Alone.')
  })
})

describe('memory pressure: "suspend now" drops only the quiet-time rule', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z')
  const lane = (over: Partial<SuspendCandidate> = {}): SuspendCandidate => ({
    terminalId: 't1', roleId: 'code', phase: 'waiting',
    // Quiet for ten seconds: far under any Tuning threshold.
    lastActivityAt: new Date(NOW - 10_000).toISOString(),
    resumable: true, conversation: true, devServer: false,
    ...over,
  })

  it('suspends a lane quiet for seconds, which the timed tick keeps', () => {
    expect(suspendDecision(lane(), NOW, 30 * 60_000).suspend).toBe(false)
    expect(suspendDecision(lane(), NOW, 'now')).toEqual({ suspend: true, why: 'idle, and memory is low' })
  })

  it('applies even when idle suspension is Off: the person pressed the button', () => {
    expect(suspendDecision(lane(), NOW, 0).suspend).toBe(false)
    expect(suspendDecision(lane(), NOW, 'now').suspend).toBe(true)
  })

  it.each<[string, Partial<SuspendCandidate>]>([
    ['the focused lane', { focused: true }],
    ['a coordinator', { roleId: 'operator' }],
    ['a lane mid-turn', { phase: 'running' }],
    ['a lane asking a question', { phase: 'asking' }],
    ['unsent input', { unsentInput: true }],
    ['a pending submission', { pendingSubmission: true }],
    ['a message waiting for readiness', { awaitingDelivery: 1 }],
    ['held deliveries', { heldDeliveries: 1 }],
    ['background tasks', { backgroundTasks: 1 }],
    ['subagents', { activeSubagents: 1 }],
    ['a dev server', { devServer: true }],
    ['no conversation yet', { conversation: false }],
    ['nothing to resume', { resumable: false }],
    ['a released worktree', { released: true }],
    ['a restart in flight', { inFlight: true }],
    ['an ended lane', { ended: true }],
    ['no tracked session', { phase: undefined }],
    ['no activity timestamp', { lastActivityAt: undefined }],
  ])('still keeps %s', (_name, over) => {
    expect(suspendDecision(lane(over), NOW, 'now').suspend).toBe(false)
  })

  it('still reads the ports before deciding, and takes every eligible lane with no cap', () => {
    expect(needsPortCheck([lane({ devServer: undefined })], NOW, 'now')).toHaveLength(1)
    const many = Array.from({ length: 5 }, (_, i) => lane({ terminalId: `t${i}` }))
    expect(planSuspends(many, NOW, 'now', Infinity)).toHaveLength(5)
  })
})

describe('a suspend pass judges each lane again right before its kill (review M1)', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z')
  const lane = (id: string, over: Partial<SuspendCandidate> = {}): SuspendCandidate => ({
    terminalId: id, roleId: 'code', phase: 'waiting',
    lastActivityAt: new Date(NOW - 10_000).toISOString(),
    resumable: true, conversation: true, devServer: false,
    ...over,
  })

  /** A view whose lanes can change while the pass runs. `suspend` checks `eligible` right before
   *  its kill, as `suspendLane` does, and records what it killed. */
  function view(ids: string[]) {
    const state = new Map(ids.map((id) => [id, lane(id)]))
    const ports = new Map<string, boolean>()
    const killed: string[] = []
    const beforeKill: Array<(id: string) => void> = []
    const steps: PassSteps = {
      planned: ids.map((id) => lane(id)),
      threshold: 'now',
      now: () => NOW,
      fresh: (id) => { const c = state.get(id); return c && { ...c, devServer: undefined } },
      readDevServer: async (id) => ports.get(id) ?? false,
      suspend: async (id, eligible) => {
        if (!eligible()) return false
        await Promise.resolve() // the report IPC
        for (const f of beforeKill) f(id)
        if (!eligible()) return false
        killed.push(id)
        return true
      },
    }
    return { state, ports, killed, beforeKill, steps }
  }

  it('does not kill a lane that started a background task after the plan was made', async () => {
    const v = view(['a', 'b', 'c'])
    // While "a" is being suspended, "c" takes a turn and leaves a background task running.
    v.beforeKill.push((id) => { if (id === 'a') v.state.set('c', lane('c', { backgroundTasks: 1 })) })
    expect(await suspendPlanned(v.steps)).toBe(2)
    expect(v.killed).toEqual(['a', 'b'])
  })

  it('does not kill a lane that gains a background task between its report and its kill', async () => {
    const v = view(['a'])
    v.beforeKill.push(() => v.state.set('a', lane('a', { backgroundTasks: 1 })))
    expect(await suspendPlanned(v.steps)).toBe(0)
    expect(v.killed).toEqual([])
  })

  it.each<[string, Partial<SuspendCandidate>]>([
    ['a subagent', { activeSubagents: 1 }],
    ['a held dispatch', { heldDeliveries: 1 }],
    ['a release', { released: true }],
    ['another end of the lane in flight', { inFlight: true }],
    ['a turn in progress', { phase: 'running' }],
  ])('keeps a lane that gained %s mid-pass', async (_name, over) => {
    const v = view(['a', 'b'])
    v.beforeKill.push((id) => { if (id === 'a') v.state.set('b', lane('b', over)) })
    await suspendPlanned(v.steps)
    expect(v.killed).toEqual(['a'])
  })

  it('reads the ports again, and keeps a lane that started a dev server mid-pass', async () => {
    const v = view(['a', 'b'])
    v.beforeKill.push((id) => { if (id === 'a') v.ports.set('b', true) })
    await suspendPlanned(v.steps)
    expect(v.killed).toEqual(['a'])
  })

  it('keeps a lane whose ports cannot be read now, and one whose tab is gone', async () => {
    const v = view(['a', 'b'])
    v.steps.readDevServer = async (id) => (id === 'a' ? undefined : false)
    v.state.delete('b')
    expect(await suspendPlanned(v.steps)).toBe(0)
  })

  describe('a step that hangs (review L2)', () => {
    afterEach(() => { vi.useRealTimers() })

    it('is given up after the cap, logged, and the pass goes on', async () => {
      vi.useFakeTimers()
      const v = view(['a', 'b'])
      const skipped: string[] = []
      v.steps.onSkip = (id, why) => skipped.push(`${id} ${why}`)
      let latePorts!: (b: boolean) => void
      v.steps.readDevServer = (id) => (id === 'a' ? new Promise((r) => { latePorts = r }) : Promise.resolve(false))
      const done = suspendPlanned(v.steps)
      await vi.advanceTimersByTimeAsync(SUSPEND_STEP_CAP_MS)
      expect(await done).toBe(1)
      expect(v.killed).toEqual(['b'])
      expect(skipped).toEqual([`a took longer than ${SUSPEND_STEP_CAP_MS / 1000} s; the pass moved on`])
      // The port read that comes back late starts no suspend.
      latePorts(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(v.killed).toEqual(['b'])
    })

    it('goes on past a step that throws', async () => {
      const v = view(['a', 'b'])
      const skipped: string[] = []
      v.steps.onSkip = (id, why) => skipped.push(`${id} ${why}`)
      const suspend = v.steps.suspend
      v.steps.suspend = (id, eligible) => (id === 'a' ? Promise.reject(new Error('ipc')) : suspend(id, eligible))
      expect(await suspendPlanned(v.steps)).toBe(1)
      expect(skipped).toEqual(['a failed: ipc'])
    })

    it('withCap resolves the value, or timed-out once the cap passes', async () => {
      vi.useFakeTimers()
      expect(await withCap(Promise.resolve(3), 10)).toBe(3)
      const slow = withCap(new Promise(() => {}), 10)
      await vi.advanceTimersByTimeAsync(10)
      expect(await slow).toBe('timed-out')
    })
  })
})
