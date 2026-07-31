import { CHANNEL_MAX_CHARS } from './channel-send'

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
/** Same hard cap as a human message, for the same reason: nothing in the write path can confirm
 *  delivery, so past this length we are guessing. Inherited rather than redeclared. */
export const DELIVER_MAX_CHARS = CHANNEL_MAX_CHARS

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
}

export const emptyDeliveryState = (): DeliveryState => ({ inheritedHop: {}, pairHistory: {}, suspendedUntil: {} })

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

/** Truncate for delivery, keeping the full text in the store and saying so in the wire copy.
 *  Never a silent cut: the recipient is told there is more and where it lives. */
export function truncateForDelivery(text: string): { text: string; truncated: boolean } {
  if (text.length <= DELIVER_MAX_CHARS) return { text, truncated: false }
  // Leave room for the notice so the result is still under the cap.
  const notice = `\n…[truncated at ${DELIVER_MAX_CHARS} chars — the full message is in this project's channel]`
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
 *  suspended pair cannot keep extending its own suspension. */
export function evaluateDelivery(input: DeliveryInput): { decision: DeliveryDecision; state: DeliveryState } {
  const { from, to, text, targetLive, paused, now, state } = input
  const hop = (state.inheritedHop[from] ?? 0) + 1
  const key = pairKey(from, to)

  const block = (reason: BlockReason, note: string): { decision: DeliveryDecision; state: DeliveryState } =>
    ({ decision: { kind: 'block', reason, hop, note }, state })

  if (paused) {
    return block('paused', 'Agent-to-agent delivery is paused. The message is in the channel; nothing was sent.')
  }
  if (!targetLive) {
    // Queued, never launched — the same rule human→lane follows. A text box that starts sessions
    // is an unbounded spawn.
    return block('queued', `"${to}" isn't running, and a message never starts a lane. It stays in the channel.`)
  }
  if (hop >= HOP_LIMIT) {
    return block('hop-limit', `Chain reached ${HOP_LIMIT} hops without a human in it. Delivery stopped; the message is in the channel for you.`)
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
    },
  }
}

/** A human message resets the addressee's chain depth: the human is the thing that makes a
 *  conversation legitimate again, and it's what lets the budget recover without a timer. */
export function resetChainFor(state: DeliveryState, to: string): DeliveryState {
  if (!(to in state.inheritedHop)) return state
  const inheritedHop = { ...state.inheritedHop }
  delete inheritedHop[to]
  return { ...state, inheritedHop }
}
