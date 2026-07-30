import type { Project } from '../../shared/types'
import type { ProjectActivity } from './project-status'

// Durable membership + ordering + query over the project store. Deliberately NOT part of
// lib/project-status: that module answers "what is this project doing right now" (pure over
// sessions, no notion of the store), this one answers "which shelf is it on, and in what
// order" (pure over Project[]). Keeping them apart is what keeps `projectActivity` free of
// any archive concept. The dependency runs one way only — this file reads ProjectActivity,
// project-status knows nothing about shelves.

/** Above this many rows a list earns a type-to-filter field. One definition for the switcher
 *  popover and the gallery — they had none and 8 respectively. */
export const FILTER_THRESHOLD = 8

/** Days without a run before we OFFER to shelve. Advisory only; never written automatically. */
export const STALE_DAYS = 14

/** Is this project on the ACTIVE shelf? `archivedAt` is the user's decision — but a project
 *  with a live session is active whatever the record says, because a running agent must never
 *  hide inside a collapsed section. Tolerates a missing activity entry (first frame, before
 *  the activity map is built), which reads as "nothing live here". */
export function isActiveProject(p: Project, activity?: ProjectActivity): boolean {
  return !p.archivedAt || (activity?.live ?? 0) > 0
}

/** Live first, then most recently RUN. The one ordering, shared by the gallery grid and the
 *  switcher popover, which each carried a copy. */
export function byActivityThenRecency(
  activities: Record<string, ProjectActivity>,
): (a: Project, b: Project) => number {
  return (a, b) =>
    ((activities[b.id]?.live ?? 0) > 0 ? 1 : 0) - ((activities[a.id]?.live ?? 0) > 0 ? 1 : 0)
    || b.lastActiveAt.localeCompare(a.lastActiveAt)
}

/** Split the store into the two shelves, each already ordered: active = live-first then
 *  last-run desc; previous = most recently shelved first, with a `lastActiveAt` tiebreak so
 *  the order is total (two projects shelved in the same bulk tidy share an `archivedAt`). */
export function partitionProjects(
  projects: Project[],
  activities: Record<string, ProjectActivity>,
): { active: Project[]; previous: Project[] } {
  const active: Project[] = []
  const previous: Project[] = []
  for (const p of projects) (isActiveProject(p, activities[p.id]) ? active : previous).push(p)
  active.sort(byActivityThenRecency(activities))
  previous.sort((a, b) =>
    (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')
    || b.lastActiveAt.localeCompare(a.lastActiveAt))
  return { active, previous }
}

/** Name-or-path substring match, case-insensitive — the switcher's filter, now shared. An
 *  empty query matches everything, so a caller can filter unconditionally. Matching the PATH
 *  is what makes the three `fastrack` casings findable. */
export function matchProject(p: Project, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
}

/** Active projects with nothing running that haven't run in STALE_DAYS — what the tidy prompt
 *  will offer later. `now` is injectable so the boundary is testable. Anything already shelved
 *  is excluded even if handed in: the prompt offers a decision, it doesn't repeat one. */
export function staleProjects(
  active: Project[],
  activities: Record<string, ProjectActivity>,
  now: number = Date.now(),
): Project[] {
  const cutoff = now - STALE_DAYS * 86_400_000
  return active.filter((p) =>
    !p.archivedAt
    && (activities[p.id]?.live ?? 0) === 0
    && Date.parse(p.lastActiveAt) <= cutoff)
}
