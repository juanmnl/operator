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
      // `warn`, like the two brakes above it. It used to be `muted` — the same tone as `declined`
      // and `no matching lane`, i.e. the quietest ink in the feed — which drew a message that
      // reached NOBODY more faintly than one that landed. All three of these mean the same thing
      // (nothing was typed anywhere, and nothing retries on its own), so they read the same.
      return { label: 'held · agent↔agent paused', tone: 'warn' }
    default:
      // An outcome from a future version: show it verbatim rather than mislabelling it.
      return { label: String(outcome), tone: 'muted' }
  }
}

/** The chip for a collapsed fan-out row.
 *
 *  The label was always right; the TONE was hardcoded `accent`, so "delivered 6/6" and
 *  "delivered 4/6 · 2 queued" painted identically. The second one is the actionable case — two
 *  lanes have not been told anything and may never be — and it was rendering as success. */
export function chipForGroup(records: DispatchRecord[]): ChannelChip {
  const label = summariseGroup(records)
  const held = new Set(['pending-approval', 'hop-limit', 'pair-brake', 'paused'])
  if (records.some((r) => held.has(r.outcome))) return { label, tone: 'warn' }
  if (records.some((r) => r.outcome === 'queued')) return { label, tone: 'progress' }
  return { label, tone: 'accent' }
}

/** Is this chip a state the user may still need to DO something about? Drives a visual
 *  treatment, not just an ink: at 8.5px, colour alone was not carrying it. */
export function isActionableChip(chip: ChannelChip): boolean {
  return chip.tone === 'warn' || chip.tone === 'progress'
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

/** Enough of a session to attribute a reply. */
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
        // The group's own state, not any one member's — including its TONE.
        chip: chipForGroup(members),
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
      // Session gone → its id, verbatim. A blank author would read as "nobody said this".
      authorLabel: from?.name ?? session?.roleId ?? r.sessionId,
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

/** Group into day buckets for the separators, preserving order. */
export function groupByDay(entries: ChannelEntry[]): { day: string; entries: ChannelEntry[] }[] {
  const out: { day: string; entries: ChannelEntry[] }[] = []
  for (const e of entries) {
    const day = e.at.slice(0, 10)
    const last = out[out.length - 1]
    if (last && last.day === day) last.entries.push(e)
    else out.push({ day, entries: [e] })
  }
  return out
}

/** How long a run of one author's entries keeps reading as one block. Past this, the same lane
 *  speaking again is a NEW thing it said, not a continuation, and it gets its name back. */
export const CONTINUATION_WINDOW_MS = 8 * 60 * 1000

/** Does `entry` continue `prev`'s block — same author, close enough in time?
 *
 *  This exists because the real store's dominant shape is a LONG run of one author: the longest
 *  run in `~/.operator/projects.json` is 33 consecutive `operator` dispatches, then 29, then 25.
 *  Rendering an avatar and a name for each of those 33 spends the whole left edge of the feed
 *  repeating something that never changed, and leaves nothing for the eye to catch on.
 *
 *  Only the IDENTITY collapses. The target, time and chip stay on every row, because those are
 *  exactly what does vary inside a run — one `operator` block routinely goes to design, then
 *  code, then research, with a different outcome each time. Collapsing those would hide the
 *  only information the run carries. */
export function isContinuation(prev: ChannelEntry | undefined, entry: ChannelEntry): boolean {
  if (!prev) return false
  if (prev.authorLabel !== entry.authorLabel) return false
  // A human and a lane can share a label only by coincidence; provenance still separates them.
  if (!!prev.fromHuman !== !!entry.fromHuman) return false
  const gap = Date.parse(entry.at) - Date.parse(prev.at)
  return Number.isFinite(gap) && gap >= 0 && gap <= CONTINUATION_WINDOW_MS
}

/** Initials for a channel avatar. Two letters, from a lane name or a raw id. */
export function channelInitials(label: string): string {
  const parts = label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean)
  if (!parts.length) return '?'
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)
  return s.toUpperCase()
}
