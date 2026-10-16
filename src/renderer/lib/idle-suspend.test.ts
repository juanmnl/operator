import { describe, it, expect } from 'vitest'
import {
  suspendDecision, planSuspends, needsPortCheck, servesDevServer, heldDeliveriesFor, quietFor,
  laneReady, LaneWaker, LANE_SETTLE_MS, LANE_READY_TIMEOUT_MS, HELD_RECORD_MAX_AGE_MS,
  suspendedTabId, isPlaceholderId, type SuspendCandidate,
  failedResume, tookTurnSince, RESUME_CONFIRM_MS, suspendedRowsToRestore, overlayKey, runSuspend, placeholderTab,
} from './idle-suspend'
import type { DispatchRecord } from '../../shared/types'

const MIN = 60_000
const NOW = Date.parse('2026-10-16T12:00:00Z')
const ago = (mins: number) => new Date(NOW - mins * MIN).toISOString()
const IDLE = 30 * MIN

const lane = (over: Partial<SuspendCandidate> = {}): SuspendCandidate => ({
  terminalId: 't1',
  roleId: 'code',
  phase: 'waiting',
  lastActivityAt: ago(45),
  resumable: true,
  devServer: false,
  ...over,
})

describe('idle suspend: eligibility', () => {
  it('suspends a lane waiting past the threshold with nothing holding it', () => {
    expect(suspendDecision(lane(), NOW, IDLE).suspend).toBe(true)
    expect(suspendDecision(lane({ phase: 'idle' }), NOW, IDLE).suspend).toBe(true)
  })

  it('is off at zero minutes', () => {
    expect(suspendDecision(lane(), NOW, 0)).toEqual({ suspend: false, why: 'suspending idle lanes is off' })
  })

  it('waits for the threshold, measured from the later of transcript and keystroke', () => {
    expect(suspendDecision(lane({ lastActivityAt: ago(29) }), NOW, IDLE).suspend).toBe(false)
    expect(suspendDecision(lane({ lastActivityAt: ago(30) }), NOW, IDLE).suspend).toBe(true)
    // Transcript quiet for 45 minutes, but someone typed into the pane five minutes ago.
    expect(suspendDecision(lane({ lastKeystrokeAt: NOW - 5 * MIN }), NOW, IDLE).suspend).toBe(false)
    expect(quietFor({ lastActivityAt: ago(45), lastKeystrokeAt: NOW - 5 * MIN }, NOW)).toBe(5 * MIN)
  })

  it.each(['running', 'compacting', 'asking'])('never suspends a lane that is %s', (phase) => {
    const d = suspendDecision(lane({ phase }), NOW, IDLE)
    expect(d.suspend).toBe(false)
    expect(d.why).toBe(`it is ${phase}`)
  })

  it('never suspends a lane with no tracked session', () => {
    expect(suspendDecision(lane({ phase: undefined }), NOW, IDLE).suspend).toBe(false)
  })

  it('never suspends the pane the user is looking at', () => {
    expect(suspendDecision(lane({ focused: true }), NOW, IDLE)).toEqual({ suspend: false, why: 'you are looking at it' })
  })

  it('never suspends a lane with unsent input', () => {
    expect(suspendDecision(lane({ unsentInput: true }), NOW, IDLE)).toEqual({ suspend: false, why: 'it has unsent text in its input' })
  })

  it('never suspends a lane with a submission still waiting for its turn', () => {
    expect(suspendDecision(lane({ pendingSubmission: true }), NOW, IDLE).suspend).toBe(false)
  })

  it('never suspends a lane with a queued or held dispatch or reply', () => {
    expect(suspendDecision(lane({ heldDeliveries: 1 }), NOW, IDLE)).toEqual({ suspend: false, why: 'a dispatch or reply to it is queued or held' })
  })

  it('never suspends a lane serving a dev server, and asks for the ports before deciding', () => {
    expect(suspendDecision(lane({ devServer: true }), NOW, IDLE)).toEqual({ suspend: false, why: 'it is serving a dev server' })
    expect(suspendDecision(lane({ devServer: undefined }), NOW, IDLE)).toEqual({ suspend: false, why: 'its ports have not been checked', checkPorts: true })
  })

  it.each(['operator', 'orchestrator', 'Operator'])('never suspends a coordinator (%s)', (roleId) => {
    expect(suspendDecision(lane({ roleId }), NOW, IDLE)).toEqual({ suspend: false, why: 'the coordinator stays running' })
  })

  it('never suspends a lane with background tasks or subagents running', () => {
    expect(suspendDecision(lane({ backgroundTasks: 1 }), NOW, IDLE)).toEqual({ suspend: false, why: 'it has background tasks running' })
    expect(suspendDecision(lane({ activeSubagents: 2 }), NOW, IDLE)).toEqual({ suspend: false, why: 'it has subagents running' })
  })

  it('never suspends a lane it could not resume, one already ended, released, or mid-restart', () => {
    expect(suspendDecision(lane({ resumable: false }), NOW, IDLE).suspend).toBe(false)
    expect(suspendDecision(lane({ ended: true }), NOW, IDLE).suspend).toBe(false)
    expect(suspendDecision(lane({ released: true }), NOW, IDLE).suspend).toBe(false)
    expect(suspendDecision(lane({ inFlight: true }), NOW, IDLE).suspend).toBe(false)
  })

  it('does not read the ports of a lane that fails an earlier rule', () => {
    const lanes = [
      lane({ terminalId: 'a', devServer: undefined }),
      lane({ terminalId: 'b', devServer: undefined, phase: 'running' }),
      lane({ terminalId: 'c', devServer: undefined, lastActivityAt: ago(5) }),
    ]
    expect(needsPortCheck(lanes, NOW, IDLE).map((l) => l.terminalId)).toEqual(['a'])
  })

  it('plans the quietest lanes first, capped per tick', () => {
    const lanes = [
      lane({ terminalId: 'a', lastActivityAt: ago(40) }),
      lane({ terminalId: 'b', lastActivityAt: ago(90) }),
      lane({ terminalId: 'c', lastActivityAt: ago(60) }),
      lane({ terminalId: 'd', lastActivityAt: ago(120), phase: 'running' }),
    ]
    expect(planSuspends(lanes, NOW, IDLE).map((l) => l.terminalId)).toEqual(['b', 'c'])
  })

  it('counts a port another lane claims as not this lane\'s server', () => {
    expect(servesDevServer([])).toBe(false)
    expect(servesDevServer([{ attributed: 'claimed' }])).toBe(false)
    expect(servesDevServer([{ attributed: 'shared' }])).toBe(true)
    expect(servesDevServer([{ attributed: 'sniffed' }])).toBe(true)
  })
})

describe('idle suspend: held deliveries', () => {
  const rec = (over: Partial<DispatchRecord>): DispatchRecord => ({ id: 'x', at: ago(10), toRoleId: 'code', task: 't', outcome: 'sent', ...over })

  it('counts held and queued records addressed to the lane, from the last day', () => {
    const records = [
      rec({ outcome: 'pending-approval' }),
      rec({ outcome: 'pair-brake', replyId: 'r1' }),
      rec({ outcome: 'undelivered' }),
      rec({ outcome: 'sent' }),
      rec({ outcome: 'launched' }),
      rec({ outcome: 'queued' }), // the task waits on the board; nothing is lost by suspending
      rec({ outcome: 'pending-approval', toRoleId: 'design' }),
      rec({ outcome: 'queued', at: new Date(NOW - HELD_RECORD_MAX_AGE_MS - 1).toISOString() }),
    ]
    expect(heldDeliveriesFor(records, 'code', NOW)).toBe(3)
    expect(heldDeliveriesFor(records, undefined, NOW)).toBe(0)
    expect(heldDeliveriesFor(undefined, 'code', NOW)).toBe(0)
  })
})

describe('idle suspend: placeholder ids', () => {
  it('never looks like a per-run pty id', () => {
    expect(isPlaceholderId(suspendedTabId('abc'))).toBe(true)
    expect(isPlaceholderId('t5')).toBe(false)
  })
})

describe('idle suspend: readiness', () => {
  it('waits for the session and the settle time, and gives up waiting at the timeout', () => {
    const spawnedAt = NOW
    expect(laneReady({ spawnedAt, observed: true }, NOW + LANE_SETTLE_MS - 1)).toBe(false)
    expect(laneReady({ spawnedAt, observed: false }, NOW + LANE_SETTLE_MS)).toBe(false)
    expect(laneReady({ spawnedAt, observed: true }, NOW + LANE_SETTLE_MS)).toBe(true)
    expect(laneReady({ spawnedAt, observed: false }, NOW + LANE_READY_TIMEOUT_MS)).toBe(true)
    expect(laneReady({ observed: false }, NOW)).toBe(true)
  })
})

describe('idle suspend: resume-on-dispatch ordering', () => {
  /** A fake view: records every step in order, and lets the test decide when the spawn and the
   *  readiness wait finish. */
  function harness(opts: { spawnFails?: boolean } = {}) {
    const log: string[] = []
    let finishSpawn: (() => void) | null = null
    let markReady: (() => void) | null = null
    const ready = new Promise<void>((r) => { markReady = r })
    const waker = new LaneWaker<{ id: string }>({
      resume: (terminalId, first) => {
        log.push(`spawn ${terminalId} --resume${first ? ` "${first}"` : ''}`)
        return new Promise((r) => { finishSpawn = () => r(opts.spawnFails ? null : { id: 't9' }) })
      },
      ready: async (tab) => { log.push(`wait ${tab.id}`); await ready },
      submit: (tab, text) => { log.push(`type ${tab.id} "${text}"`) },
    })
    return { log, waker, finishSpawn: () => finishSpawn!(), markReady: () => markReady!() }
  }

  it('hands the first message to the spawn and types later ones only once the lane is ready, in order', async () => {
    const h = harness()
    const first = h.waker.wake('k', 'suspended:k', 'dispatch one')
    const second = h.waker.wake('k', 'suspended:k', 'dispatch two')
    const third = h.waker.wake('k', 'suspended:k', 'reply three')
    expect(h.waker.waking('k')).toBe(true)
    // One spawn, carrying the first message on its command line. Nothing typed yet.
    expect(h.log).toEqual(['spawn suspended:k --resume "dispatch one"'])
    h.finishSpawn()
    expect(await first).toEqual({ id: 't9' })
    await Promise.resolve()
    expect(h.log.filter((l) => l.startsWith('type'))).toEqual([])
    h.markReady()
    await Promise.all([second, third])
    expect(h.log).toEqual([
      'spawn suspended:k --resume "dispatch one"',
      'wait t9',
      'type t9 "dispatch two"',
      'wait t9',
      'type t9 "reply three"',
    ])
    expect(h.waker.waking('k')).toBe(false)
  })

  it('a resume with no message (focus) still makes a later message wait for readiness', async () => {
    const h = harness()
    const focus = h.waker.wake('k', 'suspended:k')
    const dispatch = h.waker.wake('k', 'suspended:k', 'task')
    h.finishSpawn()
    await focus
    h.markReady()
    await dispatch
    expect(h.log).toEqual(['spawn suspended:k --resume', 'wait t9', 'type t9 "task"'])
  })

  it('a second wake with nothing to deliver joins the resume in flight', async () => {
    const h = harness()
    const a = h.waker.wake('k', 'suspended:k')
    expect(h.waker.wake('k', 'suspended:k')).toBe(a)
    h.finishSpawn()
    await a
    expect(h.log).toEqual(['spawn suspended:k --resume'])
  })

  it('types nothing when the spawn fails, and lets a later wake try again', async () => {
    const h = harness({ spawnFails: true })
    const first = h.waker.wake('k', 'suspended:k', 'one')
    const second = h.waker.wake('k', 'suspended:k', 'two')
    h.finishSpawn()
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(h.log).toEqual(['spawn suspended:k --resume "one"'])
    expect(h.waker.waking('k')).toBe(false)
  })
})

describe('idle suspend: a lane just resumed (review H1)', () => {
  it('counts the spawn as activity, so a lane resumed by focus is not suspended again at once', () => {
    // Suspended for two hours, resumed by focus a minute ago with no prompt: the transcript has no
    // record since, so only the spawn says it is fresh.
    const resumed = lane({ lastActivityAt: ago(120), spawnedAt: NOW - 1 * MIN })
    expect(quietFor(resumed, NOW)).toBe(1 * MIN)
    expect(suspendDecision(resumed, NOW, IDLE)).toEqual({ suspend: false, why: 'not idle long enough' })
    // Quiet for the whole window since the resume: suspended again, as any lane would be.
    expect(suspendDecision(lane({ lastActivityAt: ago(120), spawnedAt: NOW - 31 * MIN }), NOW, IDLE).suspend).toBe(true)
    expect(planSuspends([resumed], NOW, IDLE)).toEqual([])
  })

  it('keeps a lane up while a message to it waits for it to be ready', () => {
    const d = suspendDecision(lane({ awaitingDelivery: 1 }), NOW, IDLE)
    expect(d).toEqual({ suspend: false, why: 'a message to it is waiting for it to be ready' })
    expect(suspendDecision(lane({ awaitingDelivery: 0 }), NOW, IDLE).suspend).toBe(true)
  })
})

describe('idle suspend: the order of one suspend (review M4)', () => {
  const steps = (o: { idle?: boolean[]; killFails?: boolean } = {}) => {
    const log: string[] = []
    const idle = [...(o.idle ?? [true, true])]
    return {
      log,
      st: {
        stillIdle: () => { const v = idle.shift() ?? true; log.push(`check ${v}`); return v },
        report: async (withThisLane: boolean) => { log.push(withThisLane ? 'report +lane' : 'report -lane') },
        guardExit: (on: boolean) => { log.push(on ? 'guard on' : 'guard off') },
        kill: async () => { log.push('kill'); if (o.killFails) throw new Error('no such pty') },
        markSuspended: () => { log.push('shown suspended') },
      },
    }
  }

  it('tells main, re-checks, guards the exit and kills before the tab reads as suspended', async () => {
    const h = steps()
    expect(await runSuspend(h.st)).toBe('suspended')
    expect(h.log).toEqual(['check true', 'report +lane', 'check true', 'guard on', 'kill', 'shown suspended'])
  })

  it('cancels when a message arrives while main is told, and takes the lane back out of the record', async () => {
    const h = steps({ idle: [true, false] })
    expect(await runSuspend(h.st)).toBe('cancelled')
    expect(h.log).toEqual(['check true', 'report +lane', 'check false', 'report -lane'])
  })

  it('leaves the lane running and not suspended when the kill fails', async () => {
    const h = steps({ killFails: true })
    expect(await runSuspend(h.st)).toBe('kill-failed')
    expect(h.log).toEqual(['check true', 'report +lane', 'check true', 'guard on', 'kill', 'guard off', 'report -lane'])
    expect(h.log).not.toContain('shown suspended')
  })
})

describe('idle suspend: a resume that did not come back (review M3)', () => {
  const SPAWN = NOW - 5_000

  it('is an exit on its own, soon after the spawn, before the transcript moved', () => {
    expect(failedResume({ spawnedAt: SPAWN, tookTurn: false }, NOW, true)).toBe(true)
    // Operator killed it (a close, a restart): not a failed resume.
    expect(failedResume({ spawnedAt: SPAWN, tookTurn: false }, NOW, false)).toBe(false)
    // It took a turn: it came back, and a later exit is the lane's own.
    expect(failedResume({ spawnedAt: SPAWN, tookTurn: true }, NOW, true)).toBe(false)
    // Long after the spawn: an ordinary exit.
    expect(failedResume({ spawnedAt: NOW - RESUME_CONFIRM_MS, tookTurn: false }, NOW, true)).toBe(false)
  })

  it('reads a record written after the spawn as the transcript moving', () => {
    expect(tookTurnSince(new Date(SPAWN + 1_500).toISOString(), SPAWN)).toBe(true)
    expect(tookTurnSince(ago(120), SPAWN)).toBe(false)
    expect(tookTurnSince(undefined, SPAWN)).toBe(false)
  })
})

describe('idle suspend: restoring suspended tabs at launch (review M2)', () => {
  const row = (key: string, over: Record<string, unknown> = {}) => ({ key, idleSuspendedAt: ago(60), claudeSessionId: `c-${key}`, ...over })
  const none = { tabs: [], restoring: [], fromMain: [], liveAtEnd: [] }

  it('restores rows marked suspended, or listed by main, that can be resumed', () => {
    const rows = [row('a'), row('b', { idleSuspendedAt: undefined }), row('c', { claudeSessionId: undefined }), row('d', { releasedAt: ago(5) })]
    expect(suspendedRowsToRestore(rows, none).map((r) => r.key)).toEqual(['a'])
    expect(suspendedRowsToRestore(rows, { ...none, fromMain: ['b'] }).map((r) => r.key)).toEqual(['a', 'b'])
  })

  it('makes no second tab for a key that has one, is being restored, or was live at the end', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')]
    const got = suspendedRowsToRestore(rows, { tabs: ['a'], restoring: ['b'], fromMain: [], liveAtEnd: ['c'] })
    expect(got.map((r) => r.key)).toEqual(['d'])
  })

  it('makes one tab for a key that appears twice', () => {
    expect(suspendedRowsToRestore([row('a'), row('a')], none)).toHaveLength(1)
  })
})

describe('idle suspend: keys typed at the suspended pane (review L4)', () => {
  it('holds printable keys, takes one back on Backspace, and resumes on each', () => {
    let held = ''
    for (const key of ['h', 'i', '!', 'Backspace']) {
      const r = overlayKey(held, { key })
      expect(r?.resume).toBe(true)
      held = r!.held
    }
    expect(held).toBe('hi')
  })

  it('resumes on Enter without adding to or sending the held text', () => {
    expect(overlayKey('draft', { key: 'Enter' })).toEqual({ held: 'draft', resume: true })
  })

  it('leaves shortcuts and keys that type nothing alone', () => {
    expect(overlayKey('x', { key: 'k', metaKey: true })).toBeNull()
    expect(overlayKey('x', { key: 'c', ctrlKey: true })).toBeNull()
    expect(overlayKey('x', { key: 'ArrowUp' })).toBeNull()
    expect(overlayKey('x', { key: 'Shift' })).toBeNull()
  })
})

describe('idle suspend: the tab a restored row comes back as (review L5)', () => {
  it('keeps the fan-out index, so the resumed lane takes its own bus name and not its sibling\'s', () => {
    const tab = placeholderTab({ key: 'k2', cwd: '/w/k2', roleId: 'code', fanIndex: 2, idleSuspendedAt: ago(10), claudeSessionId: 'c2' }, ago(0))
    expect(tab).toMatchObject({ id: suspendedTabId('k2'), key: 'k2', fanIndex: 2, ended: true, idleSuspendedAt: ago(10), resumeSessionId: 'c2' })
    expect(isPlaceholderId(tab.id)).toBe(true)
  })

  it('stamps a row main listed but the renderer had not marked yet', () => {
    expect(placeholderTab({ key: 'k', cwd: '/w', claudeSessionId: 'c' }, ago(0)).idleSuspendedAt).toBe(ago(0))
  })
})
