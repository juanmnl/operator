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
  /** `"from>to"` → the hop of the last message delivered ON THAT ORDERED PAIR.
   *
   *  PER THREAD, NOT PER LANE, and that change is the fix for a measured cascade. This used to be
   *  `Record<roleId, number>`: one scalar per lane, meaning "the hop of the last message delivered
   *  INTO that lane, whoever sent it". Two unrelated senders talking to the same lane shared one
   *  counter, so ordinary hub-and-spoke fan-out — a coordinator addressing four lanes that each
   *  reply — could exhaust that lane's budget from unrelated volume and then, because exhaustion
   *  marks both ends, stop everyone talking to it. `project_delivery_brakes_stall.md` documents
   *  the deadlock; `dev/results/agent-comms-audit.md` §4 traces it to this field.
   *
   *  A conversation between A and B is now its own thread: a reply A→B inherits from what B last
   *  said to A (`chainHop["B>A"]`), so the depth that bounds it is the depth of THAT exchange and
   *  nothing else. Still a heuristic — there are no message ids — but a heuristic about the right
   *  pair instead of the right lane. */
  chainHop: Record<string, number>
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
   *  check — which cannot resurrect a dead chain, because passing the check is the whole point.
   *
   *  KEYED PER THREAD too (`"from>to"`), for the same reason as `chainHop`. Exhausting A↔B no
   *  longer silences A↔C — which is the cascade — but see `FANOUT_EXHAUSTED_LIMIT` for the
   *  property that had to be kept by other means. */
  exhausted: Record<string, true>
  /** roleId → agent-to-agent messages SENT since a human last addressed that lane. The ring
   *  backstop; see `LANE_SEND_LIMIT`. */
  laneSends: Record<string, number>
}

/** Total agent-to-agent messages ONE LANE may send before a human has to speak to it.
 *
 *  THE PROPERTY PER-THREAD ACCOUNTING LOSES, and it has to be replaced rather than dropped. The
 *  per-lane hop counter had one real virtue: it bounded runaway shapes that are not a PAIR. A ring
 *  — a→b→c→d→…→a — has a distinct pair at every step, so a per-thread budget sees a fresh hop-1
 *  conversation each time and never stops it. The old rule caught that; keyed per pair, nothing
 *  does.
 *
 *  So the ring is caught by a different measurement, one that cannot cascade: how much a single
 *  lane has said with no human in the loop, regardless of who it said it to. It is deliberately
 *  GENEROUS — a coordinator fanning out to five lanes and reading five replies is nowhere near it,
 *  which is the whole reason the old shared counter had to go — and it resets the moment a human
 *  speaks to that lane, exactly like the chain budget.
 *
 *  The trade, stated plainly: a ring now costs more messages before it stops than it used to
 *  (roughly this number times the ring's size, rather than HOP_LIMIT once). That is the price of
 *  not deadlocking ordinary fan-out, and ordinary fan-out is what actually happens. */
export const LANE_SEND_LIMIT = 24

export const emptyDeliveryState = (): DeliveryState => ({ chainHop: {}, laneSends: {}, pairHistory: {}, suspendedUntil: {}, exhausted: {} })

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
  const key = pairKey(from, to)
  const back = pairKey(to, from)
  // INHERIT FROM THE REVERSE DIRECTION — what `to` last said to `from` is what this message is a
  // reply to. That is the thread; anything else that happened to reach `from` is a different
  // conversation and does not deepen this one.
  const hop = (state.chainHop?.[back] ?? 0) + 1

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
  const threadDead = !!(state.exhausted?.[key] || state.exhausted?.[back])
  const runaway = (state.laneSends?.[from] ?? 0) >= LANE_SEND_LIMIT
  if (threadDead || runaway || hop >= HOP_LIMIT) {
    return {
      decision: {
        kind: 'block', reason: 'hop-limit', hop,
        note: runaway
          ? `"${from}" has sent ${LANE_SEND_LIMIT} agent-to-agent messages with no human in the loop. It is stopped until you send it a task.`
          : threadDead
            ? `"${from}" and "${to}" are in a chain that already reached ${HOP_LIMIT} hops. Send one of them a task to let it speak again.`
            : `Chain reached ${HOP_LIMIT} hops without a human in it. Delivery stopped; send "${to}" a task to restart the chain.`,
      },
      // BOTH DIRECTIONS OF THIS THREAD, and no others. The sender is over budget by this thread's
      // count; the addressee is the one that leaked, because nothing was delivered into it on this
      // pair so its side never moved. Marking one leaves the chain running at half rate — marking
      // every lane, which is what the per-lane version effectively did, is the cascade.
      state: { ...state, exhausted: { ...state.exhausted, [key]: true, [back]: true } },
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
      // Recorded on THIS pair, so the addressee's reply back continues this thread rather than
      // restarting it — and so a message it sends to somebody else does not inherit this depth.
      chainHop: { ...state.chainHop, [key]: hop },
      laneSends: { ...state.laneSends, [from]: (state.laneSends?.[from] ?? 0) + 1 },
      pairHistory: { ...state.pairHistory, [key]: [...recent, now] },
      suspendedUntil: state.suspendedUntil,
      // …and this delivery PASSED the budget, so whatever exhaustion this THREAD carried is
      // spent. It cannot revive a dead one — reaching here at all means the check above let it
      // through.
      exhausted: clearThread(state.exhausted, key, back),
    },
  }
}

/** Drop both directions of one thread, returning the same object when there is nothing to drop. */
function clearThread(exhausted: DeliveryState['exhausted'], a: string, b: string): DeliveryState['exhausted'] {
  if (!exhausted?.[a] && !exhausted?.[b]) return exhausted ?? {}
  const next = { ...exhausted }
  delete next[a]
  delete next[b]
  return next
}

/** A human message resets the addressee's chain depth: the human is the thing that makes a
 *  conversation legitimate again, and it's what lets the budget recover without a timer.
 *
 *  It clears the exhaustion mark for the same reason and by the same authority — otherwise a lane
 *  stopped by the budget could never speak again, since the mark has no timer of its own. */
export function resetChainFor(state: DeliveryState, to: string): DeliveryState {
  // EVERY THREAD THIS LANE IS IN. The human is now in the loop for this lane, which is exactly
  // what the budget measures the absence of — so all of its conversations restart, not just one.
  // Under the old per-lane keying this was a single delete; per-thread it is a sweep, and doing
  // less would leave a lane a human just addressed still unable to answer its other partners.
  const involves = (key: string) => { const [a, b] = key.split('>'); return a === to || b === to }
  const chainHop: Record<string, number> = {}
  for (const [k, v] of Object.entries(state.chainHop ?? {})) if (!involves(k)) chainHop[k] = v
  const exhausted: Record<string, true> = {}
  for (const k of Object.keys(state.exhausted ?? {})) if (!involves(k)) exhausted[k] = true
  const laneSends = { ...state.laneSends }
  delete laneSends[to]
  const unchanged = Object.keys(chainHop).length === Object.keys(state.chainHop ?? {}).length
    && Object.keys(exhausted).length === Object.keys(state.exhausted ?? {}).length
    && Object.keys(laneSends).length === Object.keys(state.laneSends ?? {}).length
  return unchanged ? state : { ...state, chainHop, exhausted, laneSends }
}
