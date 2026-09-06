import { describe, it, expect } from 'vitest'
import type { Project } from '../../shared/types'
import { emptyDeliveryState, HOP_LIMIT, type DeliveryState } from './agent-delivery'
import {
  resolveDispatch, readDeliveryResult, trackSend, takeSend, SEND_CONFIRM_TTL_MS,
  type BusLane, type DispatchContext, type SendBook,
} from './dispatch-bus'

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

describe('resolveDispatch — the AUTHORITY GATE', () => {
  // The hole this closes: `mcp__operator__dispatch` is offered to every lane regardless of role,
  // and the gate had exactly one call site — the sentinel subscription. So the bus path let any
  // lane commission work with no pending-approval record and no toast, which is the one guardrail
  // that decides whether a lane may put work into another lane at all.
  it('HOLDS a non-coordinator lane\'s dispatch instead of sending it', () => {
    const { verdict } = resolveDispatch(req('review', { fromRoleId: 'code', fromLabel: 'Code' }), ctx())
    expect(verdict.outcome).toBe('refused')
    expect(verdict.to).toBeUndefined()
    expect(verdict.text).toBeUndefined()
    expect(verdict.held?.toRoleId).toBe('review')
    expect(verdict.held?.toLabel).toBe('Review')
  })

  it('tells the caller not to retry — a held dispatch is not a transient failure', () => {
    // `refused` also covers a brake and a typo, and a model that reads them alike will retry.
    const { verdict } = resolveDispatch(req('review', { fromRoleId: 'code', fromLabel: 'Code' }), ctx())
    expect(verdict.reason).toMatch(/approval/i)
    expect(verdict.reason).toMatch(/not been delivered/i)
    expect(verdict.reason).toMatch(/do not retry/i)
  })

  it('holds a LAUNCH too — filing work into a project is commissioning it', () => {
    // The most consequential route, so the gate sits before the launch branch rather than after.
    const { verdict } = resolveDispatch(
      req('code', { fromRoleId: 'review', fromLabel: 'Review' }),
      ctx({ lanes: [lane('review')] }),
    )
    expect(verdict.outcome).toBe('refused')
    expect(verdict.held).toBeDefined()
  })

  it('holds an UNKNOWN sender, because an unidentified agent is not a trusted one', () => {
    const { verdict } = resolveDispatch(req('code', { fromRoleId: undefined as unknown as string }), ctx())
    expect(verdict.held).toBeDefined()
  })

  it('lets the COORDINATOR through, which is the whole point of the exception', () => {
    const { verdict } = resolveDispatch(req('code', { fromRoleId: 'operator' }), ctx())
    expect(verdict.outcome).toBe('send')
    expect(verdict.held).toBeUndefined()
  })

  it('charges the hop budget NOTHING for a held dispatch — nothing was delivered', () => {
    const before = ctx()
    const { brakes } = resolveDispatch(req('code', { fromRoleId: 'code' }), before)
    expect(brakes).toBe(before.brakes)
  })

  it('still refuses an unknown lane by NAME rather than holding it, since nothing is commissioned', () => {
    // The sentinel holds `unassigned` because its path files a backlog task; this path files
    // nothing, so naming the roster is the more useful answer to what is usually a typo.
    const { verdict } = resolveDispatch(req('cod', { fromRoleId: 'code' }), ctx())
    expect(verdict.outcome).toBe('refused')
    expect(verdict.held).toBeUndefined()
    expect(verdict.reason).toMatch(/operator, code, review/)
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

// Review found both halves of this in the first version, which kept ONE entry per address.
// These are the two failures it named, plus the expiry that keeps a stale entry from being
// claimed by an unrelated send much later.
describe('the send book — which SendMessage result belongs to which dispatch', () => {
  const book = (): SendBook => new Map()
  const entry = (taskId: string, at = 1_000) => ({ taskId, projectId: 'p1', at })

  it('keeps TWO dispatches to the same lane apart, oldest first', () => {
    // The first bug: the second `set` overwrote the first, so that task never got a verdict.
    const b = book()
    trackSend(b, 't-code', 'uds:/a.sock', entry('task-1'))
    trackSend(b, 't-code', 'uds:/a.sock', entry('task-2'))
    expect(takeSend(b, 't-code', 'uds:/a.sock', 1_000)?.taskId).toBe('task-1')
    expect(takeSend(b, 't-code', 'uds:/a.sock', 1_000)?.taskId).toBe('task-2')
    expect(takeSend(b, 't-code', 'uds:/a.sock', 1_000)).toBeUndefined()
  })

  it('will not let ANOTHER lane\'s send to the same address claim the dispatch', () => {
    // The second bug: a send made for a lane's own reasons consumed the entry and could mark a
    // delivered dispatch abandoned.
    const b = book()
    trackSend(b, 't-operator', 'uds:/a.sock', entry('task-1'))
    expect(takeSend(b, 't-review', 'uds:/a.sock', 1_000)).toBeUndefined()
    expect(takeSend(b, 't-operator', 'uds:/a.sock', 1_000)?.taskId).toBe('task-1')
  })

  it('does not confuse two addresses from the same sender', () => {
    const b = book()
    trackSend(b, 't-op', 'uds:/a.sock', entry('task-a'))
    trackSend(b, 't-op', 'uds:/b.sock', entry('task-b'))
    expect(takeSend(b, 't-op', 'uds:/b.sock', 1_000)?.taskId).toBe('task-b')
    expect(takeSend(b, 't-op', 'uds:/a.sock', 1_000)?.taskId).toBe('task-a')
  })

  it('consumes an entry ONCE, so a replayed result cannot re-judge a decided task', () => {
    // A transcript re-read replays every SendMessage in the file.
    const b = book()
    trackSend(b, 't-op', 'uds:/a.sock', entry('task-1'))
    expect(takeSend(b, 't-op', 'uds:/a.sock', 1_000)).toBeDefined()
    expect(takeSend(b, 't-op', 'uds:/a.sock', 1_000)).toBeUndefined()
  })

  it('expires an entry rather than letting a much later send claim it', () => {
    // Failing toward "never judged" — the task keeps whatever status it has — beats judging it
    // on the result of something unrelated.
    const b = book()
    trackSend(b, 't-op', 'uds:/a.sock', entry('task-1', 0))
    expect(takeSend(b, 't-op', 'uds:/a.sock', SEND_CONFIRM_TTL_MS + 1)).toBeUndefined()
  })

  it('a stale entry does not shield the live one behind it', () => {
    const b = book()
    trackSend(b, 't-op', 'uds:/a.sock', entry('stale', 0))
    trackSend(b, 't-op', 'uds:/a.sock', entry('live', SEND_CONFIRM_TTL_MS))
    expect(takeSend(b, 't-op', 'uds:/a.sock', SEND_CONFIRM_TTL_MS + 1)?.taskId).toBe('live')
  })

  it('leaves no empty queues behind, so the book cannot grow without bound', () => {
    const b = book()
    trackSend(b, 't-op', 'uds:/a.sock', entry('task-1'))
    takeSend(b, 't-op', 'uds:/a.sock', 1_000)
    expect(b.size).toBe(0)
  })
})
