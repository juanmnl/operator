import type { DispatchRecord, Role } from '../../shared/types'

// Planning a HUMAN message sent from the project channel. Pure, so the two rules that matter can
// be tested without a pty: the length cap, and the refusal to launch anything.
//
// Where a human message LIVES: `Project.dispatches`, as a `DispatchRecord` with `fromHuman: true`.
// chat.db is strictly tailer-write / frontend-read, and a message typed into a pty is
// indistinguishable from the human typing directly in that lane's transcript — so there is nowhere
// else for it to be recorded. DispatchRecord already models an addressed message with a delivery
// outcome, a stable id and a capped tail, and the channel already renders it.

/** Hard cap on a channel message.
 *
 *  Not a style preference. There is **no delivery acknowledgment anywhere in the write path**:
 *  success is inferred from timing by `nudgeDelayFor`, which its own comment calls a heuristic
 *  stand-in for the closed-loop confirmation that doesn't exist, and which caps out at 6s. The
 *  prefix-submits-tail-strands bug lived exactly there. Past a few KB the risk is unbounded and
 *  unmeasurable, so the composer refuses rather than gambling — and never truncates, because a
 *  silently shortened message is worse than a rejected one. */
export const CHANNEL_MAX_CHARS = 2000
/** Show the remaining count from here, so the limit is visible before it bites. */
export const CHANNEL_COUNT_FROM = 1800

/** `everyone` fans out to the live lanes; anything else is a single roster id. */
export type ChannelTarget = 'everyone' | string

export interface ChannelValidation {
  ok: boolean
  /** Present when `ok` is false — shown verbatim, never a silent failure. */
  error?: string
  /** Characters over the cap, for the composer's counter. */
  over: number
}

/** The one validator, called by the composer AND again before submit — a paste followed
 *  immediately by ⌘↵ must not outrun the composer's own check. */
export function validateChannelMessage(text: string): ChannelValidation {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'Nothing to send.', over: 0 }
  const over = trimmed.length - CHANNEL_MAX_CHARS
  if (over > 0) {
    return {
      ok: false,
      over,
      error: `${trimmed.length} characters — ${over} over the ${CHANNEL_MAX_CHARS} limit. Delivery past this length isn't confirmable, so shorten it (or put the detail in a file and link it).`,
    }
  }
  return { ok: true, over: 0 }
}

/** A lane a channel message can be addressed to. */
export interface ChannelLane {
  role: Role
  /** The live terminal for this lane, if it has one. Absent = idle. */
  terminalId?: string
}

export interface PlannedSend {
  /** One per addressed lane. `sent` ones carry a terminalId to write to. */
  records: (Pick<DispatchRecord, 'fromHuman' | 'toRoleId' | 'task' | 'outcome' | 'groupId'> & { terminalId?: string })[]
  /** Lanes that were addressed but are idle — reported, never launched. */
  skipped: Role[]
}

/** Plan a send. Decides outcomes; writes nothing.
 *
 *  AN IDLE LANE IS NEVER LAUNCHED. This differs from `OPERATOR-DISPATCH` **on purpose**: a dispatch
 *  is work, so spawning a session to do it is proportionate. A message is not work — spinning up a
 *  whole Claude session because somebody typed "nice" is wrong, and it turns a text box into an
 *  unbounded spawn button. An idle target's message is recorded `queued` and arrives the next time
 *  that lane runs. Do not "fix" this by calling the launch path.
 *
 *  Fan-out is bounded by the roster: one record per live lane, no repeats, sharing a `groupId`. */
export function planChannelSend(
  text: string,
  target: ChannelTarget,
  lanes: ChannelLane[],
  groupId: string,
): PlannedSend {
  const task = text.trim()
  const addressed = target === 'everyone'
    ? lanes
    : lanes.filter((l) => l.role.id === target)
  const fanout = addressed.length > 1
  const records: PlannedSend['records'] = []
  const skipped: Role[] = []
  for (const lane of addressed) {
    if (!lane.terminalId) {
      // Recorded, not delivered, and NOT launched.
      records.push({ fromHuman: true, toRoleId: lane.role.id, task, outcome: 'queued', ...(fanout ? { groupId } : {}) })
      skipped.push(lane.role)
      continue
    }
    records.push({
      fromHuman: true, toRoleId: lane.role.id, task, outcome: 'sent',
      terminalId: lane.terminalId,
      ...(fanout ? { groupId } : {}),
    })
  }
  return { records, skipped }
}

/** How a fan-out row summarises itself: "delivered 4/6 · 2 queued". */
export function summariseGroup(records: DispatchRecord[]): string {
  const total = records.length
  const delivered = records.filter((r) => r.outcome === 'sent' || r.outcome === 'launched').length
  const queued = records.filter((r) => r.outcome === 'queued').length
  const parts = [`delivered ${delivered}/${total}`]
  if (queued) parts.push(`${queued} queued`)
  return parts.join(' · ')
}
