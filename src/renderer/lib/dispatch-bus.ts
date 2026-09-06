// DISPATCH OVER THE SESSION BUS — the decision, separated from the plumbing.
//
// Brief: `dev/briefs/dispatch-over-bus.md`. Spike: `dev/results/session-bus-spike.md`.
//
// THE SHAPE, and it is the whole point: Operator stays the router, the bus is the transport, and
// the LANE does the send. A lane asks Operator where a dispatch should go; Operator applies
// exactly what the sentinel path applies — brakes, role resolution, the task and its board entry
// — and answers with an address and the text to send. The lane then calls Claude Code's own
// `SendMessage`. Operator never speaks the socket protocol: the wire framing and the peer token's
// role are unconfirmed, and the blast radius of guessing is every live lane on the machine.
//
// WHY THE DECISION IS NOT IN THE MCP SERVER. `--mcp-serve` is a separate short-lived process per
// call. The brakes are a pure function over state that lives in the app's memory
// (`deliveryStateRef`), and the roster, the task list and the board are the app's data. A server
// process could re-derive the durable half from disk but never the brake state, so it would apply
// three of the four rules and silently drop the one that exists to stop a runaway. The server
// asks; the app answers.

import type { Project, Role } from '../../shared/types'
import { evaluateDelivery, deliveryPrefix, truncateForDelivery, type DeliveryState } from './agent-delivery'
import { routeDispatch, dispatchNeedsApproval, type RoutableTab } from './dispatch'

/** What a lane is told to do next. */
export type DispatchOutcome = 'send' | 'launching' | 'refused'

export interface DispatchVerdict {
  outcome: DispatchOutcome
  /** `uds:/tmp/cc-socks/<pid>.sock` — present only on `send`. */
  to?: string
  /** The text to send, already wrapped with the same header the pty path types today, so the
   *  receiving lane reads an identical message whichever transport carried it. */
  text?: string
  /** The task this dispatch created, so the lane's `SendMessage` result can be recorded against
   *  it. NOT set here: the board entry is minted by the caller after this verdict is decided, so
   *  the caller fills it in on the way to the wire. Declared here because it is part of the
   *  verdict a lane receives. */
  taskId?: string
  /** Why, for `refused` — and for `launching`, what Operator is doing instead. */
  reason?: string
  /** Who the dispatch was routed to, on a `send`. Returned rather than left to the caller to
   *  reverse-engineer from the address: the router already resolved this lane, and re-deriving it
   *  by matching `to` back against the address map was a second, weaker resolution that silently
   *  produced nothing on a miss — costing the board entry AND, once delivery confirmation existed,
   *  the confirmation too. Internal, like `held`; the wire fields are named explicitly in
   *  `mcp-serve`. */
  target?: { roleId: string; terminalId: string }
  /** Set when the refusal is the AUTHORITY GATE rather than a brake or a bad lane name: the
   *  dispatch was recorded for the user to approve, and Operator delivers it itself if they do.
   *  The caller writes the `pending-approval` record from this; it never reaches the wire, which
   *  is enforced by `mcp-serve` naming the five wire fields explicitly. */
  held?: { toRoleId?: string; toLabel?: string }
}

export interface DispatchRequest {
  /** The lane being addressed, by role id or name — the same token the sentinel accepts. */
  lane: string
  task: string
  /** The lane doing the dispatching. */
  fromRoleId: string
  fromLabel: string
  /** Which project this is scoped to. A lane may never address outside it. */
  projectId: string
}

/** A lane as the router sees it, plus the two facts the bus needs. `RoutableTab`'s own shape is
 *  what `routeDispatch` matches on; the session uuid is what `session-bus` addresses by. */
export interface BusLane extends RoutableTab {
  claudeSessionId?: string
}

export interface DispatchContext {
  project: Project | undefined
  lanes: readonly BusLane[]
  /** Bus addresses by Claude session uuid, from `session-bus`. */
  addresses: ReadonlyMap<string, string>
  brakes: DeliveryState
  chatterPaused: boolean
  now: number
}

/** Decide what happens to one dispatch, and return the new brake state with it.
 *
 *  Pure, so every branch is exercised against a fabricated fleet rather than against whatever
 *  happens to be running — which matters here because the failure modes are a dispatch that
 *  vanishes and a dispatch that should have been stopped and was not. */
export function resolveDispatch(
  req: DispatchRequest,
  ctx: DispatchContext,
): { verdict: DispatchVerdict; brakes: DeliveryState } {
  const roster: Role[] = ctx.project?.roster ?? []

  // SCOPED TO THE PROJECT, always — `routeDispatch` takes the project id and only matches lanes
  // inside it, so a lane cannot reach another project's fleet through Operator. (A lane can still
  // call `SendMessage` with a free-form name and reach anything on the bus; that is outside
  // Operator's hands and is noted rather than pretended away.)
  const route = routeDispatch(req.lane, roster, [...ctx.lanes], req.projectId)

  if (route.kind === 'unassigned') {
    return {
      brakes: ctx.brakes,
      verdict: {
        outcome: 'refused',
        // Refused outright rather than held for approval, even from a non-coordinator. The
        // sentinel HOLDS an unassigned dispatch because its unassigned path files a backlog
        // task, and that is commissioning work; this path files nothing, so there is nothing to
        // approve and naming the roster is the more useful answer to what is usually a typo.
        reason: `no lane "${req.lane}" in this project, and no preset by that name. `
          + `Roster: ${roster.map((r) => r.id).join(', ') || '(empty)'}`,
      },
    }
  }
  const targetRoleId = route.role.id

  // AUTHORITY GATE, and it belongs here rather than only on the sentinel path. Only the
  // coordinator commissions work unsupervised; every other lane's dispatch is recorded
  // `pending-approval` and delivered by Operator only if the user approves it. The bus path
  // shipped without this and that was the hole: `dispatchNeedsApproval` had one call site, the
  // sentinel subscription, so `mcp__operator__dispatch` — offered to every lane regardless of
  // role — routed around the one guardrail that decides whether a lane may put work into
  // another lane at all. The brakes are a different rule: they cap how MUCH traffic flows, not
  // who is allowed to commission it.
  //
  // BEFORE THE LAUNCH BRANCH, deliberately, and the sentinel's own comment says why: filing a
  // task into the backlog is still commissioning work, so EVERY route is held — including a
  // launch, which is the most consequential of them.
  //
  // The wire outcome is `refused` because from the calling lane's side that is the whole truth:
  // nothing was sent and it must not retry. `held` carries the rest, for the board.
  if (dispatchNeedsApproval(req.fromRoleId)) {
    const toLabel = roster.find((r) => r.id === targetRoleId)?.name
    return {
      brakes: ctx.brakes,
      verdict: {
        outcome: 'refused',
        held: { toRoleId: targetRoleId, toLabel },
        reason: `held for approval: only the coordinator dispatches work directly. Your task for `
          + `"${toLabel ?? targetRoleId}" is in this project's dispatch log awaiting the user's `
          + `approval and has NOT been delivered. Do not retry — recommend it in your report.`,
      },
    }
  }

  // A DORMANT LANE IS LAUNCHED BY OPERATOR, and the task becomes its opening brief — exactly as
  // the sentinel path does today. The calling lane sends nothing: a second message to a lane that
  // is still starting is the one that gets silently dropped
  // (`project_dispatch_lost_on_lane_launch`), and this is the shape that avoids it.
  //
  // DECIDED BEFORE THE BRAKES, and that ordering is the rule rather than an optimisation.
  // `evaluateDelivery` blocks any message to a lane that is not live — "a message NEVER launches
  // one" is its own stated rule — so consulting it here would refuse every launch as a brake
  // failure. A launch is not a message: nothing is delivered to a peer, Operator starts a lane
  // and hands it an opening brief, and the hop budget that exists to stop lanes talking in
  // circles has nothing to count.
  if (route.kind === 'queue' || route.kind === 'create') {
    return {
      brakes: ctx.brakes,
      verdict: {
        outcome: 'launching',
        reason: route.kind === 'create'
          ? `${targetRoleId} is not on the roster; Operator is adding it from its preset and launching it with this task as its opening brief`
          : `${targetRoleId} is not running; Operator is launching it with this task as its opening brief`,
      },
    }
  }

  // THE BRAKES, on the one path that is actually a message, and before anything is created: a
  // board entry for a message that was never delivered is the same lie as a delivered-looking
  // dispatch that vanished, told the other way round.
  const evaluated = evaluateDelivery({
    from: req.fromRoleId,
    to: targetRoleId,
    text: req.task,
    targetLive: true,
    state: ctx.brakes,
    paused: ctx.chatterPaused,
    now: ctx.now,
  })
  if (evaluated.decision.kind === 'block') {
    return {
      brakes: evaluated.state,
      verdict: { outcome: 'refused', reason: `delivery brake: ${evaluated.decision.note}` },
    }
  }

  const lane = route.tab as BusLane
  const to = lane?.claudeSessionId ? ctx.addresses.get(lane.claudeSessionId) : undefined
  if (!to) {
    // ON THE ROSTER AND RUNNING, but not on the bus — it has not finished starting, or it exited
    // without Operator noticing. Refusing beats handing back an address assembled from a pid,
    // which would look valid and refuse to connect.
    return {
      brakes: evaluated.state,
      verdict: {
        outcome: 'refused',
        reason: `${targetRoleId} is running but not reachable on the session bus yet`,
      },
    }
  }

  // THE SAME TEXT THE PTY PATH TYPES, header and truncation included, so a lane reads an
  // identical message whichever transport carried it — and so the two paths can run side by side
  // for a release without the receiving end being able to tell them apart.
  // `evaluateDelivery` already truncated and wrapped for the pty path; reuse ITS text so the two
  // transports cannot drift on what a lane actually receives.
  const text = evaluated.decision.kind === 'deliver'
    ? evaluated.decision.text
    : truncateForDelivery(req.task).text
  return {
    brakes: evaluated.state,
    verdict: {
      outcome: 'send', to, text: `${deliveryPrefix(req.fromLabel)}${text}`,
      target: { roleId: targetRoleId, terminalId: lane.id },
    },
  }
}

// ── delivery outcome, from the lane's own tool result ─────────────────────────────────────────

/** What `SendMessage` reported. */
export type DeliveryOutcome = 'delivered' | 'failed'

export interface DeliveryReport {
  outcome: DeliveryOutcome
  /** The CLI's own message id on success, its own error text on failure. Never paraphrased —
   *  a delivery failure the user reads is the CLI's sentence, not ours. */
  detail?: string
}

/** Read a `SendMessage` tool result into a delivery outcome.
 *
 *  THIS REPLACES THE PTY WATCHDOG for bus dispatches. The old path had no confirmation at all: it
 *  typed bytes into a terminal and inferred delivery from whether a turn started, which is why a
 *  long dispatch could split and a second one to a launching lane could vanish with nothing to
 *  show for it. `SendMessage` answers `{success, msg_id}` or a structured failure, and the tailer
 *  already parses every `tool_result` — so this is reading a signal Operator has always had
 *  flowing through it, not new capability.
 *
 *  Tolerant of shape on purpose: the result arrives as text in a `tool_result` block, and it is
 *  the CLI's format rather than ours. Anything that is not recognisably a success is reported as
 *  a failure carrying whatever was said, because a dispatch wrongly marked delivered is the
 *  failure this whole change exists to end. */
export function readDeliveryResult(resultText: string | undefined | null): DeliveryReport {
  const raw = (resultText ?? '').trim()
  if (!raw) return { outcome: 'failed', detail: 'no result recorded' }
  try {
    const d = JSON.parse(raw) as Record<string, unknown>
    if (d.success === true) {
      return { outcome: 'delivered', detail: typeof d.msg_id === 'string' ? d.msg_id : undefined }
    }
    const msg = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : raw
    return { outcome: 'failed', detail: msg }
  } catch {
    // Not JSON. The CLI prints a human sentence for some outcomes, so match the shape of a
    // success line rather than assuming a failure — but keep the text either way.
    return /"?success"?\s*[:=]\s*true|\bmessage queued\b|\bdelivered\b/i.test(raw)
      ? { outcome: 'delivered', detail: raw.slice(0, 200) }
      : { outcome: 'failed', detail: raw.slice(0, 200) }
  }
}

// ── unconfirmed sends, and why they need a book rather than a map ─────────────────────────────

/** How long an unconfirmed send stays claimable.
 *
 *  The lane is blocked up to 15s on the verdict and then sends within its turn, so the real
 *  window is seconds. This is loose enough never to cut off a slow one and tight enough that a
 *  `SendMessage` the lane makes hours later, for its own reasons, cannot be mistaken for it. An
 *  entry that expires is simply never judged — the task stays as it is, which is the honest
 *  outcome for "nobody ever found out". */
export const SEND_CONFIRM_TTL_MS = 10 * 60_000

export interface PendingSend {
  taskId: string
  projectId: string
  /** When the address was handed out, for the TTL above. */
  at: number
}

/** Sends handed out and not yet confirmed, keyed by SENDER and address.
 *
 *  Keyed by both, and holding a QUEUE per key, because neither alone is enough — Review found
 *  both halves in the first version, which kept one entry per address:
 *
 *  - **A queue, not a slot.** Two dispatches to the same lane collapsed: the second write
 *    overwrote the first, and that first task never got a verdict at all.
 *  - **The sender in the key.** The tool result carries only a tool_use id and the `to` it was
 *    called with, so ANY lane's send to that address consumed the entry — including a send some
 *    other lane made for its own reasons, which could mark a delivered dispatch abandoned.
 *
 *  Neither half is fully decidable from the transcript: a lane told to send to a peer that also
 *  messages that peer on its own account produces two indistinguishable results. Matching the
 *  sender, taking them oldest-first and expiring the stale ones is as close as this gets, and it
 *  fails toward "never judged" rather than "judged wrong". */
export type SendBook = Map<string, PendingSend[]>

const sendKey = (terminalId: string, to: string) => `${terminalId} ${to}`

/** Record a send Operator handed out, waiting on the lane's own result. */
export function trackSend(book: SendBook, terminalId: string, to: string, entry: PendingSend): void {
  const q = book.get(sendKey(terminalId, to))
  if (q) q.push(entry)
  else book.set(sendKey(terminalId, to), [entry])
}

/** Claim the send a `SendMessage` result belongs to, oldest first, or undefined if there is none.
 *
 *  Removes what it returns: a result is one lane's one send, and a second result must not re-judge
 *  a task that has already been decided. Expired entries are dropped here rather than on a timer,
 *  because this is the only moment the answer matters. */
export function takeSend(book: SendBook, terminalId: string, to: string, now: number): PendingSend | undefined {
  const key = sendKey(terminalId, to)
  const q = book.get(key)
  if (!q) return undefined
  let hit: PendingSend | undefined
  while (q.length) {
    const next = q.shift()!
    // Expired entries are dropped and the loop moves on, so one stale entry cannot shield the
    // live one behind it from ever being claimed.
    if (now - next.at <= SEND_CONFIRM_TTL_MS) { hit = next; break }
  }
  if (!q.length) book.delete(key)
  return hit
}
