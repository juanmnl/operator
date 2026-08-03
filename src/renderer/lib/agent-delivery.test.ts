import { describe, it, expect } from 'vitest'
import {
  HOP_LIMIT, PAIR_WINDOW_MS, PAIR_MAX_IN_WINDOW, PAIR_SUSPEND_MS, DELIVER_MAX_CHARS,
  emptyDeliveryState, evaluateDelivery, truncateForDelivery, deliveryPrefix, resetChainFor,
  chatterPausedFrom,
  type DeliveryState,
} from './agent-delivery'

const T0 = 1_800_000_000_000 // a fixed epoch; nothing here reads the clock
const base = (over: Partial<Parameters<typeof evaluateDelivery>[0]> = {}) => ({
  from: 'research', to: 'code', text: 'have a look at this',
  targetLive: true, paused: false, now: T0, state: emptyDeliveryState(),
  ...over,
})

describe('the kill switch', () => {
  it('blocks agent→agent delivery outright', () => {
    const { decision } = evaluateDelivery(base({ paused: true }))
    expect(decision.kind).toBe('block')
    expect(decision.kind === 'block' && decision.reason).toBe('paused')
  })

  it('outranks every other check — it is the control you reach for when things are wrong', () => {
    // Live target, fresh chain, short text: everything else would have said deliver.
    const { decision } = evaluateDelivery(base({ paused: true, targetLive: true }))
    expect(decision.kind).toBe('block')
    // And it does not consume the pair window, so unpausing starts from a clean slate.
    const { state } = evaluateDelivery(base({ paused: true }))
    expect(state.pairHistory).toEqual({})
  })
})

describe('never deliver to a lane that is not live', () => {
  it('queues rather than launching', () => {
    const { decision } = evaluateDelivery(base({ targetLive: false }))
    expect(decision.kind === 'block' && decision.reason).toBe('queued')
    expect(decision.kind === 'block' && decision.note).toContain("never starts a lane")
  })
})

describe('hop budget', () => {
  it('counts a fresh chain as hop 1 and delivers', () => {
    const { decision } = evaluateDelivery(base())
    expect(decision).toMatchObject({ kind: 'deliver', hop: 1 })
  })

  it('makes the recipient inherit the hop, so its own reply continues the chain', () => {
    const { state } = evaluateDelivery(base({ from: 'research', to: 'code' }))
    expect(state.inheritedHop.code).toBe(1)
    // Code now replies to research: hop 2, not a fresh 1.
    const { decision } = evaluateDelivery(base({ from: 'code', to: 'research', state }))
    expect(decision).toMatchObject({ kind: 'deliver', hop: 2 })
  })

  it(`STOPS at hop ${HOP_LIMIT}`, () => {
    const state: DeliveryState = { ...emptyDeliveryState(), inheritedHop: { research: HOP_LIMIT - 1 } }
    const { decision } = evaluateDelivery(base({ state }))
    expect(decision.kind === 'block' && decision.reason).toBe('hop-limit')
    expect(decision.kind === 'block' && decision.note).toContain('without a human in it')
  })

  it('a human message resets the chain, so the budget recovers with no timer', () => {
    const deep: DeliveryState = { ...emptyDeliveryState(), inheritedHop: { code: 5 } }
    const reset = resetChainFor(deep, 'code')
    expect(reset.inheritedHop.code).toBeUndefined()
    expect(evaluateDelivery(base({ from: 'code', to: 'research', state: reset })).decision)
      .toMatchObject({ kind: 'deliver', hop: 1 })
  })
})

describe('cycle brake', () => {
  const spam = (n: number, from = 'a', to = 'b') => {
    let state = emptyDeliveryState()
    const decisions = []
    for (let i = 0; i < n; i++) {
      // Fresh chain each time, so this isolates the PAIR brake from the hop budget.
      state = { ...state, inheritedHop: {} }
      const r = evaluateDelivery(base({ from, to, now: T0 + i * 1000, state }))
      decisions.push(r.decision)
      state = r.state
    }
    return { decisions, state }
  }

  it(`allows ${PAIR_MAX_IN_WINDOW} in the window and trips on the next`, () => {
    const { decisions } = spam(PAIR_MAX_IN_WINDOW + 1)
    expect(decisions.slice(0, PAIR_MAX_IN_WINDOW).every((d) => d.kind === 'deliver')).toBe(true)
    const last = decisions[PAIR_MAX_IN_WINDOW]
    expect(last.kind === 'block' && last.reason).toBe('pair-brake')
    expect(last.kind === 'block' && last.note).toContain('suspended for 5 minutes')
  })

  it('suspends for 5 minutes, then releases', () => {
    const { state } = spam(PAIR_MAX_IN_WINDOW + 1)
    const tripAt = T0 + PAIR_MAX_IN_WINDOW * 1000
    // Still suspended a minute later…
    expect(evaluateDelivery(base({ from: 'a', to: 'b', now: tripAt + 60_000, state })).decision.kind).toBe('block')
    // …released after the suspension elapses.
    expect(evaluateDelivery(base({ from: 'a', to: 'b', now: tripAt + PAIR_SUSPEND_MS + 1, state })).decision)
      .toMatchObject({ kind: 'deliver' })
  })

  it('is PER ORDERED PAIR — the reverse direction and other lanes stay reachable', () => {
    const { state } = spam(PAIR_MAX_IN_WINDOW + 1)
    const at = T0 + PAIR_MAX_IN_WINDOW * 1000
    expect(evaluateDelivery(base({ from: 'b', to: 'a', now: at, state })).decision).toMatchObject({ kind: 'deliver' })
    expect(evaluateDelivery(base({ from: 'a', to: 'c', now: at, state })).decision).toMatchObject({ kind: 'deliver' })
    expect(evaluateDelivery(base({ from: 'x', to: 'y', now: at, state })).decision).toMatchObject({ kind: 'deliver' })
  })

  it('does not trip on the same volume spread outside the window', () => {
    let state = emptyDeliveryState()
    for (let i = 0; i < 10; i++) {
      state = { ...state, inheritedHop: {} }
      const r = evaluateDelivery(base({ from: 'a', to: 'b', now: T0 + i * (PAIR_WINDOW_MS + 1000), state }))
      expect(r.decision.kind).toBe('deliver')
      state = r.state
    }
  })

  it('a blocked delivery does not extend its own suspension', () => {
    const { state } = spam(PAIR_MAX_IN_WINDOW + 1)
    const tripAt = T0 + PAIR_MAX_IN_WINDOW * 1000
    // Hammer it while suspended; the release time must not move.
    let s = state
    for (let i = 0; i < 20; i++) {
      s = evaluateDelivery(base({ from: 'a', to: 'b', now: tripAt + i * 1000, state: s })).state
    }
    expect(evaluateDelivery(base({ from: 'a', to: 'b', now: tripAt + PAIR_SUSPEND_MS + 1, state: s })).decision)
      .toMatchObject({ kind: 'deliver' })
  })
})

describe('hard length cap', () => {
  it('truncates a 3000-char message rather than sending it whole', () => {
    const { decision } = evaluateDelivery(base({ text: 'x'.repeat(3000) }))
    expect(decision.kind).toBe('deliver')
    if (decision.kind !== 'deliver') return
    expect(decision.truncated).toBe(true)
    expect(decision.text.length).toBeLessThanOrEqual(DELIVER_MAX_CHARS)
    // …and says so, with a route to the rest. It used to point at the project channel; that
    // was deleted, and the sender is the only thing left that still has the whole message.
    expect(decision.text).toContain('truncated')
    expect(decision.text).toContain('ask the sender')
  })

  it('leaves a message at the cap untouched', () => {
    const at = 'x'.repeat(DELIVER_MAX_CHARS)
    expect(truncateForDelivery(at)).toEqual({ text: at, truncated: false })
  })
})

describe('the delivered prefix cannot be re-parsed as a directive', () => {
  // Self-amplification guard: if a relayed sentinel could match DIRECTIVE_LINE it would be
  // re-emitted and re-delivered forever.
  const DIRECTIVE_LINE = /^\s*(?:(?:[-*•>]|\d+[.)])\s+|[`*_]+)*OPERATOR-(?:DISPATCH|REPLY)\s*\[/
  it('does not match, even when the payload is itself a sentinel', () => {
    const line = deliveryPrefix('Research') + 'OPERATOR-REPLY [code] do it again'
    expect(DIRECTIVE_LINE.test(line)).toBe(false)
  })
  it('names the sender, so a relayed message never reads as the recipient\'s own thought', () => {
    expect(deliveryPrefix('Research')).toContain('Research')
  })
})

describe('the loop test — two lanes answering each other MUST terminate', () => {
  it('stops on its own, and marks the chain rather than running forever', () => {
    // Each lane replies to the other the instant it is delivered to. This is the default
    // behaviour of two cooperative agents, and the reason the budget is mandatory.
    let state = emptyDeliveryState()
    let now = T0
    let from = 'research'
    let to = 'code'
    const outcomes: string[] = []
    // A hard iteration ceiling so a REGRESSION fails the test instead of hanging it.
    for (let i = 0; i < 100; i++) {
      const r = evaluateDelivery({ from, to, text: 'and another thing', targetLive: true, paused: false, now, state })
      state = r.state
      outcomes.push(r.decision.kind === 'deliver' ? `deliver:${r.decision.hop}` : `block:${r.decision.reason}`)
      if (r.decision.kind === 'block') break
      ;[from, to] = [to, from] // ping-pong
      now += 1000 // ~1s per tailer poll, the real cadence
    }
    const last = outcomes[outcomes.length - 1]
    expect(last.startsWith('block:')).toBe(true)
    // Whichever brake catches it first, it is caught — and well inside the ceiling.
    expect(['block:hop-limit', 'block:pair-brake']).toContain(last)
    expect(outcomes.length).toBeLessThan(10)
    expect(outcomes.filter((o) => o.startsWith('deliver')).length).toBeLessThanOrEqual(HOP_LIMIT)
  })

  it('stops even when the pair brake cannot help — a ring of many lanes', () => {
    // A → B → C → D → E → F: every pair is distinct, so ONLY the hop budget can stop this.
    const ring = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    let state = emptyDeliveryState()
    let delivered = 0
    for (let i = 0; i < 100; i++) {
      const r = evaluateDelivery({
        from: ring[i % ring.length], to: ring[(i + 1) % ring.length],
        text: 'passing it on', targetLive: true, paused: false, now: T0 + i * 1000, state,
      })
      state = r.state
      if (r.decision.kind === 'block') {
        expect(r.decision.reason).toBe('hop-limit')
        break
      }
      delivered++
      expect(delivered).toBeLessThan(HOP_LIMIT + 1) // fails loudly instead of spinning
    }
    expect(delivered).toBeLessThanOrEqual(HOP_LIMIT)
  })
})

// --- the DEFAULT (dev/briefs/chatter-on-by-default.md) ------------------------------------
describe('chatterPausedFrom — flipping the default without touching a decision', () => {
  it('an untouched install is now LIVE', () => {
    // The change. Default-off meant a reply was recorded and reached nobody: the dispatch log
    // filled with held rows while the lane it was addressed to sat idle.
    expect(chatterPausedFrom(null)).toBe(false)
    expect(chatterPausedFrom(undefined)).toBe(false)
  })

  it("keeps someone who deliberately PAUSED it paused", () => {
    expect(chatterPausedFrom('1')).toBe(true)
  })

  it('keeps someone who deliberately ENABLED it enabled', () => {
    expect(chatterPausedFrom('0')).toBe(false)
  })

  it('treats a junk value as no opinion rather than as paused', () => {
    // Only the exact string the toggle writes counts as a decision; anything else is noise from
    // a hand-edited store and must not silently disable the feature.
    for (const v of ['', 'true', 'paused', 'yes', '2']) expect(chatterPausedFrom(v), v).toBe(false)
  })
})

// --- the hop-limit LEAK, closed --------------------------------------------------------
// Found by driving the brakes in the real app, not here: the pure tests only ever asserted that
// an over-budget message is blocked, never that the CHAIN ends. It didn't. `inheritedHop` is
// advanced only by a successful delivery, so a blocked A→B left B's count untouched and B→A
// still computed a hop under the limit — the chain alternated blocked/delivered at half rate
// instead of stopping.
describe('a chain that hits the limit STOPS, in both directions', () => {
  /** Run an alternating two-lane chain and report each outcome in order. */
  const runChain = (n: number) => {
    let state = emptyDeliveryState()
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      const [from, to] = i % 2 === 0 ? ['code', 'research'] : ['research', 'code']
      const r = evaluateDelivery({ from, to, text: 'x', targetLive: true, paused: false, now: T0 + i * 10_000, state })
      state = r.state
      out.push(r.decision.kind === 'deliver' ? 'sent' : r.decision.reason)
    }
    return { out, state }
  }

  it('REPRODUCES the leak shape it must not have: nothing delivers after the first block', () => {
    const { out } = runChain(10)
    const firstBlock = out.indexOf('hop-limit')
    expect(firstBlock).toBeGreaterThan(0)
    // The bug was `['...','hop-limit','sent','hop-limit','sent']`. Nothing may pass after it.
    expect(out.slice(firstBlock)).not.toContain('sent')
    expect(out.slice(firstBlock).every((o) => o === 'hop-limit')).toBe(true)
  })

  it('stops at HOP_LIMIT, not one hop later', () => {
    const { out } = runChain(10)
    expect(out.filter((o) => o === 'sent').length).toBe(HOP_LIMIT - 1)
  })

  it('marks BOTH ends — the addressee is the one that leaked', () => {
    // Only the sender is over budget by its own count; the addressee's count never moved,
    // because nothing was delivered into it. Marking one leaves the chain running at half rate.
    const { state } = runChain(10)
    expect(state.exhausted.code).toBe(true)
    expect(state.exhausted.research).toBe(true)
  })

  it('blocks an exhausted lane from sending to a THIRD, uninvolved lane', () => {
    // The chain is what is exhausted, not the pair — otherwise a stopped lane simply turns to
    // whoever else is listening and carries on burning tokens.
    const { state } = runChain(10)
    const r = evaluateDelivery({ from: 'code', to: 'design', text: 'x', targetLive: true, paused: false, now: T0 + 200_000, state })
    expect(r.decision.kind).toBe('block')
    expect(r.decision.kind === 'block' && r.decision.reason).toBe('hop-limit')
  })

  it('says WHY in a way that names the chain, not the message', () => {
    const { state } = runChain(10)
    const r = evaluateDelivery({ from: 'code', to: 'design', text: 'x', targetLive: true, paused: false, now: T0, state })
    expect(r.decision.kind === 'block' && r.decision.note).toMatch(/already reached \d+ hops/)
  })

  it('a HUMAN message frees the lane it addresses, and only that lane', () => {
    const { state } = runChain(10)
    const after = resetChainFor(state, 'research')
    expect(after.exhausted.research).toBeUndefined()
    expect(after.exhausted.code).toBe(true) // untouched — the human spoke to one lane
    const ok = evaluateDelivery({ from: 'research', to: 'code', text: 'x', targetLive: true, paused: false, now: T0 + 200_000, state: after })
    expect(ok.decision.kind).toBe('deliver')
  })

  it('…and that delivery frees the RECIPIENT, so the conversation genuinely resumes', () => {
    // Receiving a message that passed the budget check restarts the chain for the recipient too.
    // Without this, a human unblocking one lane would leave its partner mute and the reply would
    // die on the first hop back.
    const { state } = runChain(10)
    const freed = resetChainFor(state, 'research')
    const first = evaluateDelivery({ from: 'research', to: 'code', text: 'x', targetLive: true, paused: false, now: T0 + 200_000, state: freed })
    expect(first.state.exhausted.code).toBeUndefined()
    const back = evaluateDelivery({ from: 'code', to: 'research', text: 'x', targetLive: true, paused: false, now: T0 + 210_000, state: first.state })
    expect(back.decision.kind).toBe('deliver')
  })

  it('cannot revive a dead chain: clearing on delivery only happens when the budget allowed it', () => {
    // The freeing above is safe precisely because it is downstream of the check. An exhausted
    // sender never reaches the delivery branch, so it can never clear anyone.
    const { state } = runChain(10)
    const r = evaluateDelivery({ from: 'code', to: 'research', text: 'x', targetLive: true, paused: false, now: T0 + 200_000, state })
    expect(r.decision.kind).toBe('block')
    expect(r.state.exhausted.research).toBe(true) // still marked
  })

  it('does not count a blocked message toward the pair window', () => {
    // The pre-existing invariant, re-asserted now that a block writes state at all.
    const { state } = runChain(10)
    expect(state.pairHistory['code>research']?.length ?? 0).toBeLessThanOrEqual(PAIR_MAX_IN_WINDOW)
  })

  it('tolerates a state object from before `exhausted` existed', () => {
    // The ref is not persisted, but a stale shape must degrade to the old behaviour rather than
    // throwing on `undefined[from]`.
    const legacy = { inheritedHop: {}, pairHistory: {}, suspendedUntil: {} } as DeliveryState
    const r = evaluateDelivery({ from: 'code', to: 'research', text: 'x', targetLive: true, paused: false, now: T0, state: legacy })
    expect(r.decision.kind).toBe('deliver')
  })
})
