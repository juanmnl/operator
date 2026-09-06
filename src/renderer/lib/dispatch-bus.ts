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
import { routeDispatch, type RoutableTab } from './dispatch'

/** What a lane is told to do next. */
export type DispatchOutcome = 'send' | 'launching' | 'refused'

export interface DispatchVerdict {
  outcome: DispatchOutcome
  /** `uds:/tmp/cc-socks/<pid>.sock` — present only on `send`. */
  to?: string
  /** The text to send, already wrapped with the same header the pty path types today, so the
   *  receiving lane reads an identical message whichever transport carried it. */
  text?: string
  /** The task this dispatch created or matched, so the lane's `SendMessage` result can be
   *  recorded against it. */
  taskId?: string
  /** Why, for `refused` — and for `launching`, what Operator is doing instead. */
  reason?: string
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
        reason: `no lane "${req.lane}" in this project, and no preset by that name. `
          + `Roster: ${roster.map((r) => r.id).join(', ') || '(empty)'}`,
      },
    }
  }
  const targetRoleId = route.role.id

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
    verdict: { outcome: 'send', to, text: `${deliveryPrefix(req.fromLabel)}${text}` },
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
