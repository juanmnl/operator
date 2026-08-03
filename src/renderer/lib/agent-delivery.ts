// AGENT → AGENT delivery, and the brakes that must ship with it.
//
// The feature is one line of behaviour: a lane's OPERATOR-REPLY gets typed into the addressee's
// pty, so the recipient learns it arrived. Everything else here exists because two cooperative
// agents that can each answer the other will ping-pong indefinitely at ~1s per tailer poll,
// burning tokens with nobody watching. That is the DEFAULT behaviour of two helpful agents, not
// an edge case, so the brakes are not optional and none of them is advisory.
//
// Everything is pure: the decision and the state transition are computed here and applied by the
// caller, so every threshold can be tested without a pty, a timer, or a live lane.

/** Stop delivering at this depth. A chain is human → A (0) → B (1) → A (2) … */
export const HOP_LIMIT = 6
/** The cycle brake's window, and how many deliveries a single ordered pair may make inside it. */
export const PAIR_WINDOW_MS = 60_000
export const PAIR_MAX_IN_WINDOW = 4
/** How long a tripped pair stays suspended. Per-pair, never global. */
export const PAIR_SUSPEND_MS = 5 * 60_000
/** Hard cap on one delivered message.
 *
 *  Not a style preference. There is **no delivery acknowledgment anywhere in the write path**:
 *  success is inferred from timing by `nudgeDelayFor`, which its own comment calls a heuristic
 *  stand-in for the closed-loop confirmation that doesn't exist, and which caps out at 6s. The
 *  prefix-submits-tail-strands bug lived exactly there. Past a few KB the risk is unbounded and
 *  unmeasurable, so we truncate with a marker rather than gambling on the whole thing landing.
 *
 *  It used to live in `channel-send.ts` as `CHANNEL_MAX_CHARS` and be re-exported here — the one
 *  place a surviving module imported from the deleted channel. Moved rather than aliased: an
 *  alias would have kept `channel-send.ts` alive as a one-constant file, which is the deletion
 *  not happening. The value is unchanged, so nothing about delivery behaviour moved with it. */
export const DELIVER_MAX_CHARS = 2000

/** The kill switch's persisted key, and the one place its default is decided.
 *
 *  Extracted from `DashboardView` so all three cases can be tested, because the interesting part
 *  is what it does with a value it did NOT write. The key is only ever written by the toggle:
 *
 *    absent → never touched   → LIVE   (flipped 2026-07-30; it used to mean paused)
 *    `'1'`  → explicitly OFF  → paused
 *    `'0'`  → explicitly ON   → live
 *
 *  Preserving both explicit values is the whole care here. Flipping a default is allowed to change
 *  what "no opinion" means; it is not allowed to reach into a decision someone actually made, in
 *  either direction — a user who deliberately pulled this switch must not find it pushed back. */
export const CHATTER_KEY = 'operator.chatterPaused'
export function chatterPausedFrom(stored: string | null | undefined): boolean {
  return stored === '1'
}

/** Why a message was not delivered. Each maps to a `DispatchRecord.outcome`. */
export type BlockReason = 'paused' | 'hop-limit' | 'pair-brake' | 'queued'

export interface DeliveryState {
  /** roleId → the hop count of the last message delivered INTO that lane.
   *
   *  This is how a chain is reconstructed without message ids: a reply from lane X is treated as
   *  a response to whatever was last delivered to X, so it inherits that hop + 1. It is a
   *  HEURISTIC, and deliberately the conservative kind — a lane that speaks spontaneously long
   *  after being addressed inherits a stale hop and so stops sooner, never later. A human message
   *  resets the lane to 0, which is what makes the budget recover without a timer. */
  inheritedHop: Record<string, number>
  /** "from>to" → epoch ms of recent deliveries, pruned to the window. */
  pairHistory: Record<string, number[]>
  /** "from>to" → epoch ms until which that pair is suspended. */
  suspendedUntil: Record<string, number>
  /** Lanes whose chain has hit `HOP_LIMIT`. A lane in here cannot SEND either, not just receive.
   *
   *  Added because the hop budget leaked, which only showed up when the brakes were driven in the
   *  real app. `inheritedHop` is only ever advanced by a SUCCESSFUL delivery, so when A→B was
   *  blocked at the limit, B's count stayed where it was and B→A still computed a hop under the
   *  limit. The chain did not stop — it alternated blocked/delivered at half rate, forever, and in
   *  the measured run it was the pair brake that eventually ended it rather than the hop limit.
   *
   *  Cleared by exactly two things, both of which mean the chain legitimately restarted:
   *  a human message (`resetChainFor`), or a delivery INTO the lane that itself passed the budget
   *  check — which cannot resurrect a dead chain, because passing the check is the whole point. */
  exhausted: Record<string, true>
}

export const emptyDeliveryState = (): DeliveryState => ({ inheritedHop: {}, pairHistory: {}, suspendedUntil: {}, exhausted: {} })

const pairKey = (from: string, to: string) => `${from}>${to}`

export type DeliveryDecision =
  | { kind: 'deliver'; hop: number; text: string; truncated: boolean }
  | { kind: 'block'; reason: BlockReason; hop: number; note: string }

export interface DeliveryInput {
  /** Sender lane id. */
  from: string
  /** Addressee lane id. */
  to: string
  text: string
  /** Is the addressee's lane live right now? A message NEVER launches one. */
  targetLive: boolean
  /** The human's kill switch. Halts agent→agent only; human→lane is a different path entirely. */
  paused: boolean
  now: number
  state: DeliveryState
}

/** Truncate for delivery, and say so in the wire copy. Never a silent cut: the recipient is told
 *  there is more, and given the only route to it that still exists.
 *
 *  That route used to be "the full message is in this project's channel". The channel is deleted,
 *  and this string is typed into an AGENT's pty — so leaving it would have been an instruction to
 *  go and read a screen that isn't there, which is worse than saying nothing. The sender still has
 *  the whole message (it is in its own transcript), and asking it is something the recipient can
 *  actually do. */
export function truncateForDelivery(text: string): { text: string; truncated: boolean } {
  if (text.length <= DELIVER_MAX_CHARS) return { text, truncated: false }
  // Leave room for the notice so the result is still under the cap.
  const notice = `\n…[truncated at ${DELIVER_MAX_CHARS} chars — ask the sender for the rest]`
  return { text: text.slice(0, DELIVER_MAX_CHARS - notice.length) + notice, truncated: true }
}

/** Prefix the delivered text so it reads as relayed rather than as the recipient's own thought.
 *
 *  It also cannot match `DIRECTIVE_LINE` (roster.ts): that regex anchors on optional list/emphasis
 *  decoration followed immediately by `OPERATOR-`, and `[` is not in its decoration set. Belt to
 *  the braces — the actual protection is that a delivered message lands as a `user` turn and the
 *  parser only ever runs on assistant turns (verified: transcript.rs calls parse_* from
 *  apply_assistant only). Without both, a relayed sentinel could be re-parsed on arrival and
 *  amplify itself. */
export function deliveryPrefix(fromLabel: string): string {
  return `[Operator · message from ${fromLabel}] `
}

/** Decide whether to deliver, and return the state as it would be afterwards.
 *
 *  Order matters and is deliberate: the kill switch outranks everything (it is the control you
 *  reach for when something is already wrong), then liveness (nothing to deliver to), then the
 *  chain budget, then the pair brake. A blocked message still updates nothing except what the
 *  block itself implies — notably a blocked delivery does NOT count toward the pair window, so a
 *  suspended pair cannot keep extending its own suspension. The one thing a block DOES write is
 *  chain exhaustion (see `exhausted`), which is precisely "what the block implies": if this
 *  message was over budget, the conversation it belongs to is over, in both directions. */
export function evaluateDelivery(input: DeliveryInput): { decision: DeliveryDecision; state: DeliveryState } {
  const { from, to, text, targetLive, paused, now, state } = input
  const hop = (state.inheritedHop[from] ?? 0) + 1
  const key = pairKey(from, to)

  const block = (reason: BlockReason, note: string): { decision: DeliveryDecision; state: DeliveryState } =>
    ({ decision: { kind: 'block', reason, hop, note }, state })

  if (paused) {
    return block('paused', 'Agent-to-agent delivery is paused. Nothing was sent; the reply is recorded on the Team screen’s dispatch log.')
  }
  if (!targetLive) {
    // Queued, never launched — the same rule human→lane follows. A text box that starts sessions
    // is an unbounded spawn.
    return block('queued', `"${to}" isn't running, and a message never starts a lane. Nothing was sent.`)
  }
  // The chain budget. `exhausted` is checked alongside the count rather than after it, because a
  // lane that was marked when its partner hit the limit has a STALE count of its own — that gap is
  // exactly the leak, and reading the count alone is what let a message through it.
  if (state.exhausted?.[from] || hop >= HOP_LIMIT) {
    const already = !!state.exhausted?.[from]
    return {
      decision: {
        kind: 'block', reason: 'hop-limit', hop,
        note: already
          ? `"${from}" is in a chain that already reached ${HOP_LIMIT} hops. Send it a task to let it speak again.`
          : `Chain reached ${HOP_LIMIT} hops without a human in it. Delivery stopped; send "${to}" a task to restart the chain.`,
      },
      // BOTH ends. The sender is already over budget by its own count; the addressee is the one
      // that leaked, because nothing was delivered into it so its count never moved. Marking only
      // the sender would leave the chain running at half rate.
      state: { ...state, exhausted: { ...state.exhausted, [from]: true, [to]: true } },
    }
  }

  // Prune the window before judging it, so an old burst can't hold a pair down forever.
  const recent = (state.pairHistory[key] ?? []).filter((t) => now - t < PAIR_WINDOW_MS)
  const until = state.suspendedUntil[key] ?? 0
  if (now < until) {
    const secs = Math.ceil((until - now) / 1000)
    return block('pair-brake', `${from} → ${to} is suspended for another ${secs}s after too many messages in a minute.`)
  }
  if (recent.length >= PAIR_MAX_IN_WINDOW) {
    // Trip it: suspend the pair and report once. Suspension is per ORDERED pair, so the reverse
    // direction and every unrelated lane stay reachable.
    return {
      decision: {
        kind: 'block', reason: 'pair-brake', hop,
        note: `${from} → ${to} sent ${recent.length} messages in under a minute, so that pair is suspended for ${PAIR_SUSPEND_MS / 60_000} minutes. Other lanes are unaffected.`,
      },
      state: { ...state, pairHistory: { ...state.pairHistory, [key]: recent }, suspendedUntil: { ...state.suspendedUntil, [key]: now + PAIR_SUSPEND_MS } },
    }
  }

  const { text: wire, truncated } = truncateForDelivery(text)
  return {
    decision: { kind: 'deliver', hop, text: wire, truncated },
    state: {
      // The recipient inherits this hop, so ITS next reply continues the chain rather than
      // restarting it. This single line is what makes the budget bound a conversation.
      inheritedHop: { ...state.inheritedHop, [to]: hop },
      pairHistory: { ...state.pairHistory, [key]: [...recent, now] },
      suspendedUntil: state.suspendedUntil,
      // …and this delivery PASSED the budget, so whatever exhaustion the addressee carried is
      // spent: the chain restarted legitimately. It cannot revive a dead one — reaching here at
      // all means the check above let it through.
      exhausted: clearExhausted(state.exhausted, to),
    },
  }
}

/** Drop a lane's exhaustion mark, returning the same object when there is nothing to drop. */
function clearExhausted(exhausted: DeliveryState['exhausted'], lane: string): DeliveryState['exhausted'] {
  if (!exhausted?.[lane]) return exhausted ?? {}
  const next = { ...exhausted }
  delete next[lane]
  return next
}

/** A human message resets the addressee's chain depth: the human is the thing that makes a
 *  conversation legitimate again, and it's what lets the budget recover without a timer.
 *
 *  It clears the exhaustion mark for the same reason and by the same authority — otherwise a lane
 *  stopped by the budget could never speak again, since the mark has no timer of its own. */
export function resetChainFor(state: DeliveryState, to: string): DeliveryState {
  const exhausted = clearExhausted(state.exhausted, to)
  if (!(to in state.inheritedHop) && exhausted === state.exhausted) return state
  const inheritedHop = { ...state.inheritedHop }
  delete inheritedHop[to]
  return { ...state, inheritedHop, exhausted }
}
