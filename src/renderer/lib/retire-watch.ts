import { isBetweenTurns } from './comms'

// A DISPATCH REFUSED BECAUSE ITS LANE IS STILL FINISHING, and the one message that answers it.
//
// A lane that called `worktree_done` is retired when work is dispatched to its role, but only
// between turns (lib/dispatch). Mid-turn the dispatch is refused as `finishing`. Telling the
// dispatcher to "retry once it is idle" gave it no way to see idleness, so it polled; on the
// sentinel path the refusal note itself started the next turn, which dispatched again, with no
// human in the loop (review of 2026-09-27, M1).
//
// So Operator watches instead. The first refusal opens a watch on that lane and promises ONE
// message; repeats while it is open are answered without a new note. The message goes out when
// the lane is idle, took new work, ended, or after a ceiling, and then the watch is gone. Kept in
// renderer memory: a renderer respawn loses it, which the refusal covers by telling the dispatcher
// what to do if nothing arrives.

/** How long a watch waits for a lane to go idle before it gives up and says so. */
export const FINISHING_WATCH_MAX_MS = 30 * 60_000

export interface FinishingWatch {
  projectId: string
  roleId: string
  roleName: string
  /** The released lane being watched. A different lane on the role is a different watch. */
  laneTerminalId: string
  /** Who to tell: the dispatchers' terminals, deduped. Empty for an approval by the user, who is
   *  told with a toast instead. */
  notify: string[]
  since: number
  /** Refusals answered while this watch was open, the first included. */
  refusals: number
  /** Operator had no phase for the lane at all when the watch opened. */
  unseen?: boolean
  /** An approval by the user is waiting on this lane too, so the user is told with a toast even
   *  when dispatchers are also being told (review round 2, R2-7). Sticky once set. */
  toastUser?: boolean
}

export type WatchBook = Map<string, FinishingWatch>

// ONE WATCH PER LANE, not per role (review round 2, R2-7): a refusal against a second lane of the
// same role used to replace the first watch, and the first watch's dispatchers never got the
// message they were promised.
const key = (projectId: string, roleId: string, laneTerminalId: string) => `${projectId}:${roleId}:${laneTerminalId}`

/** The open watch on this lane, if any. */
export function watchFor(book: ReadonlyMap<string, FinishingWatch>, projectId: string, roleId: string, laneTerminalId: string): FinishingWatch | undefined {
  return book.get(key(projectId, roleId, laneTerminalId))
}

/** Record a `finishing` refusal. `repeat` is true when a watch on the same lane was already open,
 *  and the caller then sends no new note: the one message is already promised. */
export function noteFinishing(
  book: WatchBook,
  r: { projectId: string; roleId: string; roleName: string; laneTerminalId: string; notify?: string; now: number; unseen?: boolean; approving?: boolean },
): { repeat: boolean; watch: FinishingWatch } {
  const open = watchFor(book, r.projectId, r.roleId, r.laneTerminalId)
  if (open) {
    open.refusals += 1
    if (r.notify && !open.notify.includes(r.notify)) open.notify.push(r.notify)
    if (r.approving) open.toastUser = true
    return { repeat: true, watch: open }
  }
  const watch: FinishingWatch = {
    projectId: r.projectId, roleId: r.roleId, roleName: r.roleName, laneTerminalId: r.laneTerminalId,
    notify: r.notify ? [r.notify] : [], since: r.now, refusals: 1, unseen: r.unseen,
    ...(r.approving ? { toastUser: true } : {}),
  }
  book.set(key(r.projectId, r.roleId, r.laneTerminalId), watch)
  return { repeat: false, watch }
}

/** Drop the watch on this lane: it was retired or its message went out. */
export function clearWatch(book: WatchBook, projectId: string, roleId: string, laneTerminalId: string): void {
  book.delete(key(projectId, roleId, laneTerminalId))
}

export type WatchSignal = 'idle' | 'took-work' | 'ended' | 'timeout'

/** What a watch needs to know about its lane. */
export interface WatchedLane { id: string; ended?: boolean; released?: boolean; phase?: string; settling?: boolean }

/** Which watches have something to say now. Pure; the caller sends and deletes. */
export function dueSignals(book: ReadonlyMap<string, FinishingWatch>, lanes: readonly WatchedLane[], now: number): Array<{ watch: FinishingWatch; signal: WatchSignal }> {
  const out: Array<{ watch: FinishingWatch; signal: WatchSignal }> = []
  for (const watch of book.values()) {
    const lane = lanes.find((l) => l.id === watch.laneTerminalId)
    let signal: WatchSignal | undefined
    if (!lane || lane.ended) signal = 'ended'
    else if (!lane.released) signal = 'took-work'
    else if (lane.phase && isBetweenTurns(lane.phase) && !lane.settling) signal = 'idle'
    else if (now - watch.since >= FINISHING_WATCH_MAX_MS) signal = 'timeout'
    if (signal) out.push({ watch, signal })
  }
  return out
}

/** The one line a dispatcher is sent. Carries no OPERATOR-DISPATCH token, so it is not parsed. */
export function signalLine(watch: FinishingWatch, signal: WatchSignal): string {
  const n = watch.roleName
  switch (signal) {
    case 'idle':
      return `[Operator] ${n} is idle now. Dispatch your task to it again: Operator will end that lane and launch a fresh one with it.`
    case 'took-work':
      return `[Operator] ${n} took new work after releasing its worktree, so it is working again and will not be retired. A dispatch to it now goes into that lane.`
    case 'ended':
      return `[Operator] ${n} has ended. A dispatch to it now launches a fresh lane.`
    case 'timeout':
      return watch.unseen
        ? `[Operator] Operator still cannot read ${n}'s state after ${FINISHING_WATCH_MAX_MS / 60_000} minutes and stopped watching it. Do not dispatch to it again; tell the user ${n} needs checking.`
        : `[Operator] ${n} has not gone idle in ${FINISHING_WATCH_MAX_MS / 60_000} minutes, so Operator stopped watching it. Dispatch again later, or do the work yourself.`
  }
}

/** The refusal a dispatcher reads. The first one promises the message; a repeat says it was
 *  already promised. `unseen`: no phase at all, so there is nothing to watch. */
export function finishingReason(roleName: string, o: { unseen: boolean; repeat: boolean; refusals?: number }): string {
  if (o.repeat) {
    return `${roleName} is still finishing its turn and you were already refused${o.refusals ? ` (${o.refusals} times)` : ''}. `
      + `Nothing was sent. Operator will message you once when it is idle. Do not dispatch to it again before then.`
  }
  if (o.unseen) {
    return `${roleName} released its worktree, but Operator cannot read its state, so it will not end it. Nothing was `
      + `sent. Operator will message you once: when it can see ${roleName} idle, working again or ended, or after `
      + `${FINISHING_WATCH_MAX_MS / 60_000} minutes. Do not dispatch to it before that message.`
  }
  return `${roleName} released its worktree and is still finishing its turn. Nothing was sent. Operator will message `
    + `you once when it is idle, then dispatch again. Do not dispatch to it before that message, and do not ask the `
    + `user to close it. If no message arrives within ${FINISHING_WATCH_MAX_MS / 60_000} minutes, dispatch again.`
}

/** What the sentinel/approval delivery path does with a `finishing` route. Pure over the book,
 *  which it updates.
 *
 *  - An APPROVAL (or Retry, or Assign) keeps its record as it is, so the card stays in Waiting
 *    with its buttons; the watch tells the user with a toast (review M3).
 *  - A first refusal records `finishing` and types the reason into the dispatcher.
 *  - A repeat records `finishing` and types NOTHING: the note starts the dispatcher's next turn,
 *    and that turn dispatching again was the loop (review M1). */
export function finishingDelivery(
  book: WatchBook,
  r: { projectId: string; roleId: string; roleName: string; laneTerminalId: string; unseen: boolean; approving: boolean; dispatcher?: string; now: number },
): { record?: { outcome: 'finishing'; note: string }; feedback?: string; reason: string } {
  const { repeat, watch } = noteFinishing(book, {
    projectId: r.projectId, roleId: r.roleId, roleName: r.roleName, laneTerminalId: r.laneTerminalId,
    notify: r.approving ? undefined : r.dispatcher, now: r.now, unseen: r.unseen, approving: r.approving,
  })
  const reason = finishingReason(r.roleName, { unseen: r.unseen, repeat, refusals: watch.refusals })
  if (r.approving) return { reason }
  return { record: { outcome: 'finishing', note: reason }, feedback: repeat ? undefined : reason, reason }
}
