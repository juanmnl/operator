// A QUEUED TASK GOES STALE, and a stale task does not dispatch without you saying so.
//
// What happened: eight rows sat in a project's board from 2026-07-21/22. Twelve days later they
// were assigned and sent, one after another, into a live session. **Six of the eight described
// work that was already done.** Two cited line numbers that now point at unrelated code; every
// one carried a test count between 158 and 184 when the suite was 521. Acting on them would have
// meant re-doing finished work against a codebase that had moved.
//
// The board cannot know a task is obsolete. It CAN know it is old, and old work in a fast-moving
// repo is the case where "are you sure?" is worth a keystroke. So age is a gate at the dispatch
// boundary, never a silent filter: a skip the user cannot see is the same class of bug as the
// silent file.

import type { ProjectTask } from '../../shared/types'

/** The horizon, in days.
 *
 *  SEVEN, not fourteen — and this is the one number in here worth arguing about. Fourteen would
 *  reuse `STALE_DAYS` from lib/project-shelf, which is a real argument (one notion of stale in
 *  the app). It is also the wrong number for this: the rows that caused the incident were TWELVE
 *  AND THIRTEEN days old, so a 14-day horizon would have let every one of them through. A guard
 *  that would not have caught the thing it was written for is decoration.
 *
 *  Seven is also the honest read of what a week means here: a lane can rewrite the file a task
 *  names in an afternoon, and a task nobody has sent in a week is one nobody is waiting on. */
export const STALE_TASK_DAYS = 7
const DAY_MS = 86_400_000

/** How old, in whole days. Always `createdAt`: `startedAt` is absent on a queued task and
 *  `lastActiveAt` is a different clock (the lane's, not the task's). */
export function taskAgeDays(task: Pick<ProjectTask, 'createdAt'>, now: number): number {
  const at = Date.parse(task.createdAt)
  if (!Number.isFinite(at)) return 0 // an unparseable date is not evidence of age
  return Math.max(0, Math.floor((now - at) / DAY_MS))
}

export function isStaleTask(task: Pick<ProjectTask, 'createdAt'>, now: number): boolean {
  return taskAgeDays(task, now) >= STALE_TASK_DAYS
}

/** Split what was asked for into what will be sent and what needs confirming.
 *
 *  Pure and total, because the caller's job is then trivially auditable: it must dispatch `fresh`
 *  and REPORT `stale`, and there is no third branch where something quietly disappears. */
export function splitStale<T extends Pick<ProjectTask, 'createdAt'>>(
  tasks: readonly T[],
  now: number,
): { fresh: T[]; stale: T[] } {
  const fresh: T[] = []
  const stale: T[] = []
  for (const t of tasks) (isStaleTask(t, now) ? stale : fresh).push(t)
  return { fresh, stale }
}

/** One line for the user when a send was held back. Lives here so the wording is testable next
 *  to the rule, and so "no silent caps" is a property of the module rather than a convention. */
export function describeSkipped(stale: readonly Pick<ProjectTask, 'createdAt' | 'text'>[], now: number): string {
  if (stale.length === 1) return `“${stale[0].text.slice(0, 48)}” is ${taskAgeDays(stale[0], now)} days old`
  const oldest = Math.max(...stale.map((t) => taskAgeDays(t, now)))
  return `${stale.length} tasks up to ${oldest} days old`
}
