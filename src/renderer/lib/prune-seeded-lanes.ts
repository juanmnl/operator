import type { Project, Role, SavedSession } from '../../shared/types'
import { isCoordinator, NO_COMMISSIONING, rolePresets } from './roster'

// THE ONE-TIME PRUNE of seeded-but-never-used lanes.
//
// Until 2026-07-28 every new project was born with six lanes (Operator/Research/Code/Review/
// Design/QA). That seeding is gone — a project now starts empty and grows on demand — but the
// projects created before the change still carry their six, and most of those lanes were never
// launched and never touched. They sit in the sidebar looking like they are waiting for
// something, which is the exact complaint that killed the seeding in the first place.
//
// So this finishes the job backwards, ONCE, and only where it is provably safe: a lane goes only
// if it has NO history in this project AND still holds exactly what the seeder gave it. Anything
// the user launched, renamed, re-modelled, re-coloured or re-charted stays. It is deliberately a
// separate module with a shelf life: when the last pre-2026-07-28 store is gone, delete the file.
//
// The caller runs it behind a one-shot flag and offers Undo — see DashboardView's hydrate effect.

/** "Not set" is `undefined` OR `''` — same rule (and same reason) as lib/model-config's `set`:
 *  real stored rosters carry empty strings where nothing was ever chosen. */
const unset = (v: string | undefined): boolean => v === undefined || v === ''

/** The coordinator charter's two PREVIOUS wordings. Both were rewrites rather than additions, so
 *  unlike the worker charters (whose only edit was appending NO_COMMISSIONING) they cannot be
 *  derived from today's text and have to be frozen here. This list never grows: it is history,
 *  and nothing seeds a roster any more. Verified against the real store — every one of the 60
 *  persisted charters there is a stock text, i.e. no user has ever edited one. */
const LEGACY_COORDINATOR_CHARTERS = [
  'You are Operator, this project’s coordinator. Know the team (the lanes below), and route each ' +
  'task to the best-suited one via OPERATOR-DISPATCH — several precise dispatches beat one vague ' +
  'one. Track who has what, and check returned work against the goal. If no lane fits a task, or the ' +
  'right one isn’t available, do it yourself rather than forcing a bad fit.',
  'Coordinate — don’t implement. Break goals into small, verifiable tasks and hand each to the ' +
  'best-suited lane via OPERATOR-DISPATCH. Track what you delegated; when work comes back, check ' +
  'it against the goal and dispatch follow-ups for gaps. Prefer several precise dispatches over ' +
  'one vague one, and keep a running summary of who is doing what.',
]

/** The preset behind a roster id, mapping either coordinator id onto the canonical lane.
 *  (`migrateLegacyCoordinator` normally runs first, but this must not depend on the order.) */
function presetOf(roleId: string): Role | undefined {
  return rolePresets().find((p) => p.id === roleId || (isCoordinator(roleId) && isCoordinator(p.id)))
}

/** Every charter text this app has ever SEEDED for a role — today's, and each predecessor.
 *  A lane whose prompt is one of these got it from the seeder, not from the user. */
export function stockPrompts(roleId: string): string[] {
  const prompt = presetOf(roleId)?.prompt
  if (!prompt) return []
  const out = [prompt]
  // Every worker charter gained NO_COMMISSIONING in one edit; the text before it is the rest.
  if (prompt.endsWith(NO_COMMISSIONING)) out.push(prompt.slice(0, -NO_COMMISSIONING.length))
  if (isCoordinator(roleId)) out.push(...LEGACY_COORDINATOR_CHARTERS)
  return out
}

/** Is this lane still exactly what seeding produced? A field that is absent counts as stock —
 *  absent means "inherit" (see Role.model), and the earlier `clearSeededRoleFields` migration
 *  deliberately empties preset-equal model/effort into that state.
 *
 *  Reads as a list of veto clauses on purpose: every branch is a reason NOT to touch someone's
 *  lane, and adding a Role field later should mean adding a veto here, not a silent hole. */
export function isStockLane(role: Role): boolean {
  const preset = presetOf(role.id)
  if (!preset) return false // a custom lane has no seeded original — never ours to remove
  if (role.name !== preset.name) return false
  if (!unset(role.model) && role.model !== preset.model) return false
  if (role.effort !== undefined && role.effort !== preset.effort) return false
  if (!unset(role.accent) && role.accent !== preset.accent) return false
  if (!unset(role.permissionMode)) return false // no preset pins one, so any value is the user's
  if (!unset(role.agentName)) return false
  // Same shape as model/effort above, and it did NOT used to be: this was
  // `role.useWorktree !== undefined` — any value at all meant the user had decided — which was
  // right only while no preset set the field. The one-altitude collapse moved the worktree
  // posture onto the presets (it was the one field the deleted global tier seeded), so an
  // explicit value can now be the stock one, and the test is whether it DIFFERS.
  if (role.useWorktree !== undefined && role.useWorktree !== preset.useWorktree) return false
  if (role.prompt !== undefined && !stockPrompts(role.id).includes(role.prompt)) return false
  return true
}

/** Has this lane ever been used in this project? Three independent traces, any one of which
 *  means hands off:
 *   - a saved session launched against it (the restore list is PRUNED over time, so its silence
 *     is not proof of never — which is why the other two matter),
 *   - a task assigned to it, ever, at any status,
 *   - a dispatch to or from it in the project's log.
 *  Live terminals aren't consulted: at hydrate none have reattached yet, and a lane with a live
 *  pty necessarily left one of the traces above when it launched. */
export function laneHasHistory(project: Project, roleId: string, saved: SavedSession[]): boolean {
  if (saved.some((s) => s.projectId === project.id && s.roleId === roleId)) return true
  if (project.tasks?.some((t) => t.roleId === roleId)) return true
  if (project.dispatches?.some((d) => d.toRoleId === roleId || d.fromRoleId === roleId)) return true
  return false
}

/** OPERATOR IS THE FLOOR. The migration never removes the coordinator lane, however stock and
 *  however unused it is.
 *
 *  Without this the prune takes a six-lane project to ZERO, and zero is not "tidy" — it is a dead
 *  end. `OPERATOR-DISPATCH [lane] …` addresses a lane by id, so a project with no roster has
 *  nothing to talk to and nothing that can create the others; the entry point is gone. Six-or-none
 *  was never the choice anyone wanted, and one — Operator — is the answer to both.
 *
 *  Keyed on `isCoordinator` rather than the literal 'operator' so a roster still holding the
 *  pre-rename 'orchestrator' id is protected too. The brief asked for the explicit id exemption
 *  because it is predictable; this is that rule, with the one alias it has ever had.
 *
 *  Scoped to the MIGRATION. A user who deletes their way to an empty roster is exercising a
 *  decision, and `removeRoleFrom` is deliberately not touched — this floor exists because nobody
 *  asked for the migration, not because empty is forbidden. */
function isFloorLane(role: Role): boolean {
  return isCoordinator(role.id)
}

/** Would the prune drop this lane? The single predicate both the count and the action read, so a
 *  toast promising 49 can never be followed by 43 actually going. */
function isPrunable(project: Project, role: Role, saved: SavedSession[]): boolean {
  return !isFloorLane(role) && isStockLane(role) && !laneHasHistory(project, role.id, saved)
}

/** What the prune would do, without doing it — the counts the toast has to name. */
export function seededIdleLaneCounts(projects: Project[], saved: SavedSession[]): { lanes: number; projects: number } {
  let lanes = 0, touched = 0
  for (const p of projects) {
    const n = (p.roster ?? []).filter((r) => isPrunable(p, r, saved)).length
    if (n) { lanes += n; touched++ }
  }
  return { lanes, projects: touched }
}

/** Drop every stock, never-used lane from every project — except the coordinator, which is the
 *  floor (see `isFloorLane`). Idempotent and content-sniffing: a second run finds nothing (the
 *  caller's one-shot flag is about not re-pruning lanes the user ADDED BACK, not about correctness
 *  here). Projects with nothing to drop are returned by reference, so the caller can count
 *  rewrites the way the other hydrate migrations do. */
export function pruneSeededIdleLanes(
  projects: Project[],
  saved: SavedSession[],
): { projects: Project[]; lanes: number; touched: number } {
  let lanes = 0, touched = 0
  const next = projects.map((p) => {
    const roster = p.roster
    if (!roster?.length) return p
    const kept = roster.filter((r) => !isPrunable(p, r, saved))
    if (kept.length === roster.length) return p
    lanes += roster.length - kept.length
    touched++
    return { ...p, roster: kept }
  })
  return { projects: lanes ? next : projects, lanes, touched }
}
