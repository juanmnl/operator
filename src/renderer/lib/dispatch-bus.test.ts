import { describe, it, expect } from 'vitest'
import type { Project } from '../../shared/types'
import { emptyDeliveryState, HOP_LIMIT, type DeliveryState } from './agent-delivery'
import { resolveDispatch, readDeliveryResult, type BusLane, type DispatchContext } from './dispatch-bus'

const ROSTER = [
  { id: 'operator', name: 'Operator' },
  { id: 'code', name: 'Code' },
  { id: 'review', name: 'Review' },
]
const project = (): Project => ({ id: 'p1', name: 'operator', path: '/p', createdAt: '', roster: ROSTER } as Project)

const lane = (roleId: string, o: Partial<BusLane> = {}): BusLane => ({
  id: `t-${roleId}`, projectId: 'p1', roleId, ended: false, claudeSessionId: `uuid-${roleId}`, ...o,
} as BusLane)

const ADDRESSES = new Map([
  ['uuid-code', 'uds:/tmp/cc-socks/2001.sock'],
  ['uuid-review', 'uds:/tmp/cc-socks/2002.sock'],
])

const ctx = (o: Partial<DispatchContext> = {}): DispatchContext => ({
  project: project(),
  lanes: [lane('code'), lane('review')],
  addresses: ADDRESSES,
  brakes: emptyDeliveryState(),
  chatterPaused: false,
  now: 1_000_000,
  ...o,
})

const req = (lane: string, o: Partial<Parameters<typeof resolveDispatch>[0]> = {}) => ({
  lane, task: 'do the thing', fromRoleId: 'operator', fromLabel: 'Operator', projectId: 'p1', ...o,
})

describe('resolveDispatch — an IDLE (running) lane', () => {
  it('answers `send` with the bus address and the wrapped text', () => {
    const { verdict } = resolveDispatch(req('code'), ctx())
    expect(verdict.outcome).toBe('send')
    expect(verdict.to).toBe('uds:/tmp/cc-socks/2001.sock')
    expect(verdict.text).toContain('do the thing')
  })

  it('wraps with the SAME header the pty path types, so the two transports read alike', () => {
    const { verdict } = resolveDispatch(req('code'), ctx())
    // The receiving lane must not be able to tell which transport carried it — that is what lets
    // the sentinel path and the bus path run side by side for a release.
    expect(verdict.text).toMatch(/Operator/)
    expect(verdict.text!.endsWith('do the thing')).toBe(true)
  })

  it('resolves a lane by NAME as well as by id, like the sentinel', () => {
    expect(resolveDispatch(req('Review'), ctx()).verdict.to).toBe('uds:/tmp/cc-socks/2002.sock')
  })
})

describe('resolveDispatch — a lane that is not running', () => {
  it('answers `launching`, and the caller sends NOTHING', () => {
    // A second message to a lane that is still starting is the one that gets silently dropped
    // (project_dispatch_lost_on_lane_launch); Operator delivers the opening brief itself.
    const { verdict } = resolveDispatch(req('code'), ctx({ lanes: [lane('review')] }))
    expect(verdict.outcome).toBe('launching')
    expect(verdict.to).toBeUndefined()
    expect(verdict.text).toBeUndefined()
    expect(verdict.reason).toMatch(/launching/i)
  })

  it('also `launching` for a preset the roster has not got yet — the dispatch is the demand', () => {
    const bare = { ...project(), roster: [{ id: 'operator', name: 'Operator' }] } as Project
    const { verdict } = resolveDispatch(req('qa'), ctx({ project: bare, lanes: [] }))
    expect(verdict.outcome).toBe('launching')
    expect(verdict.reason).toMatch(/preset/i)
  })
})

describe('resolveDispatch — an UNKNOWN lane', () => {
  it('refuses a token that matches no lane and no preset, and names what there is', () => {
    // A typo like `[cod]` must not invent a junk lane.
    const { verdict } = resolveDispatch(req('cod'), ctx())
    expect(verdict.outcome).toBe('refused')
    expect(verdict.reason).toContain('cod')
    expect(verdict.reason).toMatch(/operator, code, review/)
  })

  it('refuses a lane that is running but not yet on the bus, rather than guessing an address', () => {
    // An address assembled from a pid would look valid and refuse to connect.
    const { verdict } = resolveDispatch(req('code'), ctx({ addresses: new Map() }))
    expect(verdict.outcome).toBe('refused')
    expect(verdict.reason).toMatch(/not reachable on the session bus/)
  })

  it('refuses a lane in ANOTHER project — a lane cannot reach outside its own fleet', () => {
    const foreign = [lane('code', { projectId: 'p2' })]
    const { verdict } = resolveDispatch(req('code'), ctx({ lanes: foreign }))
    // It is on the roster, so this is `launching` rather than `unknown` — but it is emphatically
    // not a `send` to the other project's live lane.
    expect(verdict.outcome).not.toBe('send')
    expect(verdict.to).toBeUndefined()
  })
})

describe('resolveDispatch — the brakes', () => {
  it('refuses when the human has paused agent chatter, and creates nothing', () => {
    const { verdict } = resolveDispatch(req('code'), ctx({ chatterPaused: true }))
    expect(verdict.outcome).toBe('refused')
    expect(verdict.reason).toMatch(/brake/i)
    expect(verdict.taskId).toBeUndefined()
  })

  it('refuses once the hop chain is exhausted', () => {
    // The brake exists to stop a runaway, and it is the one rule a server process re-deriving
    // state from disk could not have applied — which is why the app answers, not the server.
    let brakes: DeliveryState = emptyDeliveryState()
    let last = resolveDispatch(req('code'), ctx({ brakes }))
    for (let i = 0; i < HOP_LIMIT + 2; i++) {
      brakes = last.brakes
      last = resolveDispatch(req('code'), ctx({ brakes }))
    }
    expect(last.verdict.outcome).toBe('refused')
    expect(last.verdict.reason).toMatch(/brake/i)
  })

  it('returns the ADVANCED brake state on a send, so the next call sees this one', () => {
    const before = ctx()
    const { brakes } = resolveDispatch(req('code'), before)
    expect(brakes).not.toBe(before.brakes)
  })

  it('leaves the brake state untouched when the lane does not exist at all', () => {
    // Nothing was attempted, so nothing should be counted against the sender.
    const before = ctx()
    const { brakes } = resolveDispatch(req('cod'), before)
    expect(brakes).toBe(before.brakes)
  })
})

// The tailer records the lane's own `SendMessage` result as the dispatch's delivery outcome.
// This replaces the pty watchdog, which had no confirmation at all — it typed bytes and inferred
// delivery from whether a turn started.
describe('readDeliveryResult — the tool_result → task outcome mapping', () => {
  it('reads a success and keeps the CLI\'s message id', () => {
    const r = readDeliveryResult('{"success":true,"msg_id":"f0bfaf7d-b871-44fa-aad3-82f61e43dabe"}')
    expect(r.outcome).toBe('delivered')
    expect(r.detail).toBe('f0bfaf7d-b871-44fa-aad3-82f61e43dabe')
  })

  it('reads a structured failure and keeps the CLI\'s own sentence, unparaphrased', () => {
    const r = readDeliveryResult('{"success":false,"message":"no such agent: review"}')
    expect(r.outcome).toBe('failed')
    expect(r.detail).toBe('no such agent: review')
  })

  it('treats anything unrecognised as FAILED, never as delivered', () => {
    // A dispatch wrongly marked delivered is the exact failure this change exists to end, so the
    // ambiguous cases fall to the safe side.
    for (const raw of ['', '   ', 'null', '{"weird":1}', 'some prose about nothing']) {
      expect(readDeliveryResult(raw).outcome).toBe('failed')
    }
    expect(readDeliveryResult(undefined).outcome).toBe('failed')
  })

  it('still reads a non-JSON success line, and carries the text', () => {
    const r = readDeliveryResult('Message queued for delivery to code at its next tool round.')
    expect(r.outcome).toBe('delivered')
    expect(r.detail).toContain('queued')
  })

  it('caps the detail it keeps, so a huge result cannot ride into the task row', () => {
    const r = readDeliveryResult('x'.repeat(5000))
    expect(r.detail!.length).toBeLessThanOrEqual(200)
  })
})
