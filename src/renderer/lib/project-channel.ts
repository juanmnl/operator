import { localDay } from './local-time'
import type { DispatchRecord, ProjectReply, Role } from '../../shared/types'
import { summariseGroup } from './channel-send'

// The project channel's data layer: merge what ALREADY EXISTS into one time-ordered feed.
//
// Two stores hold the whole conversation and nothing displayed them together:
//   • Project.dispatches — who asked whom to do what, and how it landed
//   • chat.db replies    — OPERATOR-REPLY posts, read via projectReplies()
//
// Nothing here sends anything. The feed is history, and every state it shows is DERIVED from a
// `DispatchRecord.outcome` that some other code path already wrote — no state is invented here,
// which is what keeps the channel honest about what actually happened to a task.

/** A chip's visual tone. Mapped to tokens by the view — this module stays render-free so it can
 *  be unit-tested without a DOM. */
export type ChipTone = 'accent' | 'progress' | 'warn' | 'muted'

export interface ChannelChip {
  label: string
  tone: ChipTone
  /** Only a held dispatch is actionable, and only through the EXISTING approval handlers. */
  actionable?: boolean
}

export interface ChannelEntry {
  id: string
  kind: 'dispatch' | 'reply'
  /** The human sent it from the channel. Renders as `You →` with the neutral avatar — never as a
   *  lane, because provenance is the whole reason `fromHuman` exists. */
  fromHuman?: true
  /** For a fan-out send: the per-target records this row collapses, and their summary. */
  group?: { records: DispatchRecord[]; summary: string }
  /** ISO timestamp — the sole ordering key. */
  at: string
  /** Resolved lane, when it resolves. Absent for a sender we can't name. */
  authorRole?: Role
  /** What to print for the author: the lane's name, or a raw id we refuse to guess about. */
  authorLabel: string
  /** The addressee, when there is one. `null` for a broadcast reply. */
  targetLabel: string | null
  text: string
  chip: ChannelChip
}

/** `outcome` → chip. One row per outcome, no invented states. `pending-approval` is the only
 *  actionable one, and it routes to the approval handlers that already exist. */
export function chipForOutcome(outcome: DispatchRecord['outcome']): ChannelChip {
  switch (outcome) {
    case 'sent':
    case 'launched':
      return { label: 'delivered', tone: 'accent' }
    case 'queued':
      return { label: 'queued · behind current task', tone: 'progress' }
    case 'pending-approval':
      return { label: 'held · needs your approval', tone: 'warn', actionable: true }
    case 'rejected':
      return { label: 'declined', tone: 'muted' }
    case 'unassigned':
      return { label: 'no matching lane', tone: 'muted' }
    // The agent→agent brakes. All three mean nothing was typed anywhere, and none retries on its
    // own — so each one names WHY, because "not delivered" alone would send you reading code.
    case 'hop-limit':
      return { label: 'held · chain limit reached', tone: 'warn' }
    case 'pair-brake':
      return { label: 'held · pair sending too fast', tone: 'warn' }
    case 'paused':
      return { label: 'held · agent↔agent paused', tone: 'muted' }
    // Not "held": this one was SENT and then observed not to arrive, which is a different and
    // worse thing than never leaving. It says so, because the recovery is manual either way and
    // a user who reads "delivered" while the lane sits idle has no way to find out otherwise.
    case 'undelivered':
      return { label: 'sent · never started', tone: 'warn' }
    default:
      // An outcome from a future version: show it verbatim rather than mislabelling it.
      return { label: String(outcome), tone: 'muted' }
  }
}

/** A reply that nothing tried to hand on: it is in the channel, and that is its whole state.
 *  A broadcast (`to: project`) and any reply predating agent→agent delivery look like this. */
export const REPLY_CHIP: ChannelChip = { label: 'posted', tone: 'accent' }

/** A reply's chip once delivery has been ATTEMPTED. The reply row keeps being the one row for
 *  that reply — the delivery record is metadata about it, never a second entry in the feed —
 *  so the outcome is folded into this chip. `undefined` = no attempt, i.e. just posted. */
export function chipForReplyDelivery(outcome: DispatchRecord['outcome'] | undefined): ChannelChip {
  if (!outcome) return REPLY_CHIP
  if (outcome === 'sent' || outcome === 'launched') return { label: 'posted · delivered', tone: 'accent' }
  const chip = chipForOutcome(outcome)
  // Never actionable: a brake is released by time, a human message, or the kill switch — not by
  // an Approve button, which belongs to the dispatch gate and has different rules.
  return { label: `posted · ${chip.label.replace(/^held · /, '')}`, tone: chip.tone }
}

/** Enough of a session to attribute a reply — and it must be keyed by the CLAUDE session id,
 *  because that is what a reply carries (`OperatorReply.sessionId`, stamped by the tailer).
 *
 *  Three different identifiers live in this codebase and confusing them has cost real time: the
 *  Claude session uuid, Operator's saved-session `key`, and the per-run terminal id (`t0`, `t1`).
 *  A reply speaks the first one.
 *
 *  The list must also be DURABLE, not live. The channel renders history: a reply from a lane that
 *  has since ended is still a reply someone should be able to attribute, and a list built from the
 *  current run's ptys cannot contain it. Pass live sessions AND the saved-session store. */
export interface ChannelSession { id: string; roleId?: string }

/** Merge dispatches and replies into one ascending feed.
 *
 *  Identity: a dispatch carries `fromRoleId`/`toRoleId` and resolves against the roster directly.
 *  A reply carries only `sessionId` — no roleId — so it resolves session → roleId → Role, and when
 *  that fails (the session is gone) the raw id is printed rather than guessed at or blanked.
 *
 *  SUBAGENT PROSE IS NOT ATTRIBUTED. `NarrationEntry` has no caller field, so a subagent's words
 *  are indistinguishable from its parent lane's; everything is attributed to the lane. */
export function buildChannelFeed(
  dispatches: DispatchRecord[] | undefined,
  replies: ProjectReply[] | undefined,
  roster: Role[] | undefined,
  sessions: ChannelSession[] | undefined,
): ChannelEntry[] {
  const roles = roster ?? []
  const roleById = (id?: string) => (id ? roles.find((r) => r.id === id) : undefined)
  const entries: ChannelEntry[] = []

  // A fan-out send is N records sharing a groupId; collapse them into one row so "message to
  // everyone" reads as one message rather than six near-identical ones.
  const groups = new Map<string, DispatchRecord[]>()
  for (const d of dispatches ?? []) {
    if (!d.groupId || d.replyId) continue
    const g = groups.get(d.groupId)
    if (g) g.push(d)
    else groups.set(d.groupId, [d])
  }
  const seenGroups = new Set<string>()

  // A `replyId` record is the DELIVERY of a reply, not a message of its own. It folds into that
  // reply's row: one reply, one row, whatever happened to it. Newest wins, so a record written
  // after a brake released reflects the current truth.
  const deliveryByReply = new Map<string, DispatchRecord>()
  for (const d of dispatches ?? []) {
    if (!d.replyId) continue
    const prev = deliveryByReply.get(d.replyId)
    if (!prev || prev.at <= d.at) deliveryByReply.set(d.replyId, d)
  }

  for (const d of dispatches ?? []) {
    if (d.replyId) continue // folded into the reply's own row below
    const from = roleById(d.fromRoleId)
    const to = roleById(d.toRoleId)
    if (d.groupId) {
      if (seenGroups.has(d.groupId)) continue // already represented by its collapsed row
      seenGroups.add(d.groupId)
      const members = groups.get(d.groupId) ?? [d]
      entries.push({
        id: `group:${d.groupId}`,
        kind: 'dispatch',
        at: members.reduce((a, m) => (m.at < a ? m.at : a), members[0].at),
        fromHuman: d.fromHuman,
        authorRole: d.fromHuman ? undefined : from,
        authorLabel: d.fromHuman ? 'You' : (from?.name ?? d.fromRoleId ?? 'unknown lane'),
        targetLabel: 'everyone',
        text: d.task,
        // The group's own state, not any one member's.
        chip: { label: summariseGroup(members), tone: 'accent' },
        group: { records: members, summary: summariseGroup(members) },
      })
      continue
    }
    entries.push({
      id: `dispatch:${d.id}`,
      kind: 'dispatch',
      at: d.at,
      fromHuman: d.fromHuman,
      // A human has no lane accent to borrow — the neutral avatar is the point.
      authorRole: d.fromHuman ? undefined : from,
      // An unnamed sender is real (an ad-hoc session has no lane) — say so rather than inventing.
      authorLabel: d.fromHuman ? 'You' : (from?.name ?? d.fromRoleId ?? 'unknown lane'),
      targetLabel: to?.name ?? d.toRoleId ?? null,
      text: d.task,
      chip: chipForOutcome(d.outcome),
    })
  }

  for (const r of replies ?? []) {
    const session = (sessions ?? []).find((s) => s.id === r.sessionId)
    const from = roleById(session?.roleId)
    entries.push({
      id: `reply:${r.sessionId}:${r.timestamp}`,
      kind: 'reply',
      at: r.timestamp,
      authorRole: from,
      // Genuinely unresolvable → say UNKNOWN, never the id. A session uuid is not an author, and
      // it is worse than a blank one: it looks like data, so it reads as the answer rather than as
      // the failure it is. Matches the dispatch branch's `'unknown lane'`, which is the precedent.
      //
      // This used to be the NORMAL case rather than the last resort, because the caller searched a
      // list that could not contain the answer — see `ChannelSession` on what to pass.
      authorLabel: from?.name ?? session?.roleId ?? 'unknown lane',
      // `project` is the broadcast token: addressed to the room, not to a lane.
      targetLabel: r.to.toLowerCase() === 'project' ? null : (roleById(r.to.toLowerCase())?.name ?? r.to),
      text: r.text,
      chip: chipForReplyDelivery(deliveryByReply.get(r.id)?.outcome),
    })
  }

  // Ascending — a channel reads downward. Ties fall to the id so the order is total and a
  // re-render can't reshuffle two things stamped in the same second.
  return entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/** Entries newer than `lastReadAt`. No timestamp read yet → everything is unread. */
export function unreadEntries(entries: ChannelEntry[], lastReadAt: string | null): ChannelEntry[] {
  if (!lastReadAt) return entries
  return entries.filter((e) => e.at > lastReadAt)
}

/** Group into day buckets for the separators, preserving order.
 *
 *  Buckets on the LOCAL date, not the stored UTC one. `at.slice(0, 10)` took the UTC calendar day,
 *  which west of Greenwich is tomorrow's from early evening — at UTC−5, everything from 19:00
 *  local onward filed under the next day and the separator read a day ahead. It looked correct all
 *  afternoon and broke at dinner, which is why it survived.
 *
 *  `timeZone` is for tests only: a test written in the runner's own zone passes against the bug. */
export function groupByDay(entries: ChannelEntry[], timeZone?: string): { day: string; entries: ChannelEntry[] }[] {
  const out: { day: string; entries: ChannelEntry[] }[] = []
  for (const e of entries) {
    const day = localDay(e.at, timeZone)
    const last = out[out.length - 1]
    if (last && last.day === day) last.entries.push(e)
    else out.push({ day, entries: [e] })
  }
  return out
}

/** Initials for a channel avatar. Two letters, from a lane name or a raw id. */
export function channelInitials(label: string): string {
  const parts = label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean)
  if (!parts.length) return '?'
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)
  return s.toUpperCase()
}
