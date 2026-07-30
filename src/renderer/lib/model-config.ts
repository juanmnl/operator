import type { Project, Role } from '../../shared/types'
import { rolePresets } from './roster'

// PER-ROLE DEFAULTS, and the one cascade that resolves them.
//
// The user story this exists for: "I want from now on, Operator to use Opus instead of Fable. I
// should be able to config once." So this is not one model for every agent — it is a global,
// user-owned roster template that every project inherits.
//
// `rolePresets()` was already that template; it just lived in source and couldn't be edited. This
// module adds the editable layer above it and the resolver below it, and NOTHING else may decide a
// launch's model/effort/permission mode. Two resolvers is how the two launch paths drift apart.

/** Per-role-id overrides, keyed the same way the roster is: 'operator' | 'code' | … | custom.
 *  Every field optional — an absent field means "inherit", which is the default state. */
export type GlobalRoleDefaults = Record<string, {
  model?: string
  effort?: 'high' | 'normal' | 'low'
  permissionMode?: string
  /** Plain boolean HERE (a global either isolates a lane or doesn't). Tri-state at the ROLE
   *  level — see `useWorktree` on `ResolvedAgentConfig` below. */
  useWorktree?: boolean
}>

/** The fields a launch needs, all of them resolved — the launch path can't take `undefined`. */
export interface ResolvedAgentConfig {
  model: string
  effort: 'high' | 'normal' | 'low'
  permissionMode: string
  useWorktree: boolean
}

/** The floor. Reached only when nothing above it is set (a custom lane with no preset). */
export const HARD_FALLBACK: ResolvedAgentConfig = {
  model: 'sonnet', effort: 'high', permissionMode: 'default', useWorktree: false,
}

/** "Not set" is `undefined` OR `''`, for STRING fields.
 *
 *  The empty string matters: `Project.defaults` in real data stores `model: ''`, so treating it as
 *  a value would pin a lane to nothing and the cascade would stop at a blank. */
const set = <T>(v: T | undefined | null): v is T => v !== undefined && v !== null && v !== ''

/** …and `useWorktree` is the exception: it is a BOOLEAN, where `false` is a meaningful explicit
 *  choice. "Definitely do not isolate this lane" is not "no preference", so only `undefined` means
 *  unset. Using the generic truthy check here would silently swallow every deliberate opt-out —
 *  the lane keeps isolating after you turned it off, which is the one bug that would make the whole
 *  feature untrustworthy. It has its own test. */
const setBool = (v: boolean | undefined | null): v is boolean => v !== undefined && v !== null

/** Resolve one lane's launch config.
 *
 *  Precedence, FIRST DEFINED WINS, evaluated **per field**:
 *
 *    1. the project's role override (`Role.model` / `.effort` / `.permissionMode`)
 *    2. the global role default for that role id
 *    3. the project's own `defaults` (effort / permission mode only — it has no per-role model)
 *    4. the built-in `rolePresets()` entry for that role id
 *    5. HARD_FALLBACK
 *
 *  Per field, not per source: a lane that pins only `effort` must still inherit the global model.
 *  Resolving the whole object from the first source that has anything is the bug this ordering is
 *  written to avoid. */
export function resolveAgentConfig(
  role: Role,
  globals?: GlobalRoleDefaults,
  projectDefaults?: Project['defaults'],
): ResolvedAgentConfig {
  const g = globals?.[role.id]
  const preset = rolePresets().find((p) => p.id === role.id)
  const model = [role.model, g?.model, preset?.model].find(set) ?? HARD_FALLBACK.model
  const effort = [role.effort, g?.effort, projectDefaults?.effortLevel, preset?.effort].find(set) ?? HARD_FALLBACK.effort
  const permissionMode = [role.permissionMode, g?.permissionMode, projectDefaults?.permissionMode, preset?.permissionMode]
    .find(set) ?? HARD_FALLBACK.permissionMode
  // Tri-state, and deliberately NOT `.find(set)`: `false` is a pin, not an absence.
  const useWorktree = [role.useWorktree, g?.useWorktree].find(setBool) ?? HARD_FALLBACK.useWorktree
  return { model, effort, permissionMode, useWorktree }
}

/** Which SOURCE each field came from, for the UI. `RosterPanel` has to be able to say "this is
 *  inherited" rather than showing a resolved value that looks identical to a pin — without that,
 *  nobody can tell what the global setting is doing or why one lane ignores it. */
export type ConfigOrigin = 'pinned' | 'global' | 'project' | 'preset' | 'fallback'

export function configOrigins(
  role: Role,
  globals?: GlobalRoleDefaults,
  projectDefaults?: Project['defaults'],
): Record<keyof ResolvedAgentConfig, ConfigOrigin> {
  const g = globals?.[role.id]
  const preset = rolePresets().find((p) => p.id === role.id)
  const pick = (...layers: [ConfigOrigin, unknown][]): ConfigOrigin =>
    layers.find(([, v]) => set(v))?.[0] ?? 'fallback'
  return {
    model: pick(['pinned', role.model], ['global', g?.model], ['preset', preset?.model]),
    effort: pick(['pinned', role.effort], ['global', g?.effort], ['project', projectDefaults?.effortLevel], ['preset', preset?.effort]),
    permissionMode: pick(['pinned', role.permissionMode], ['global', g?.permissionMode], ['project', projectDefaults?.permissionMode], ['preset', preset?.permissionMode]),
    // Same tri-state rule: an explicit `false` is `pinned`, not a fall-through. A toggle that
    // looks identical when inherited-on and pinned-on is what makes the global look broken.
    useWorktree: setBool(role.useWorktree) ? 'pinned' : setBool(g?.useWorktree) ? 'global' : 'fallback',
  }
}

/** The three states of a lane's worktree toggle, for the control that has to show which it is in. */
export type WorktreeState = 'inherit' | 'on' | 'off'
export function worktreeStateOf(role: Role): WorktreeState {
  return role.useWorktree === undefined ? 'inherit' : role.useWorktree ? 'on' : 'off'
}
/** inherit → on → off → inherit. `undefined` is a real member of the cycle, which is what gives a
 *  pinned lane a route home — the old unconditional `!role.useWorktree` had none. */
export function nextWorktreeState(current: WorktreeState): boolean | undefined {
  return current === 'inherit' ? true : current === 'on' ? false : undefined
}

/** True when this role id has global defaults worth mentioning. */
export function hasGlobalFor(globals: GlobalRoleDefaults | undefined, roleId: string): boolean {
  const g = globals?.[roleId]
  return !!g && (set(g.model) || set(g.effort) || set(g.permissionMode) || setBool(g.useWorktree))
}

/** The shipped starting point for the global layer, seeded once when the store is empty.
 *
 *  Only `useWorktree`, and only because it is the field where "no preference" is the least useful
 *  answer: a worktree earns its cost for lanes that WRITE and mostly gets in the way for lanes that
 *  read and coordinate. Model and effort are deliberately left absent — `rolePresets()` is already
 *  a considered tiering, and duplicating it into the user's own file would turn every preset into a
 *  pin, which is the exact mistake §4 exists to undo. */
export function seedGlobalDefaults(): GlobalRoleDefaults {
  return {
    code: { useWorktree: true },
    design: { useWorktree: true },
    operator: { useWorktree: false },
    research: { useWorktree: false },
    review: { useWorktree: false },
    qa: { useWorktree: false },
  }
}

/** Drop empty entries so the store never accumulates `{ code: {} }` rows that read as configured. */
export function pruneGlobals(globals: GlobalRoleDefaults): GlobalRoleDefaults {
  const out: GlobalRoleDefaults = {}
  for (const [id, g] of Object.entries(globals)) {
    const kept: GlobalRoleDefaults[string] = {}
    if (set(g?.model)) kept.model = g.model
    if (set(g?.effort)) kept.effort = g.effort
    if (set(g?.permissionMode)) kept.permissionMode = g.permissionMode
    if (setBool(g?.useWorktree)) kept.useWorktree = g.useWorktree
    if (Object.keys(kept).length) out[id] = kept
  }
  return out
}

// --- Reconciling the seeded values -------------------------------------------------------
//
// THE CRUX. Every stored role entry already carries an explicit `model`, because it was SEEDED
// from a preset when the project was created. A seeded value is indistinguishable from a
// deliberate override, so without this a new global default would be silently ignored forever.
//
// The signal: a field that EQUALS the built-in preset for its role id was almost certainly seeded;
// one that DIFFERS was chosen. Clearing a field that equals the preset is a **no-op today** — the
// cascade falls straight through to the same preset value — and becomes meaningful the moment a
// global default is set. That is what makes this safe to run on hydrate.

/** Clear seeded `model` / `effort` on a project's roster, leaving deliberate overrides pinned.
 *  Returns the same object when there is nothing to do, so hydrate can early-bail and the
 *  migration is idempotent by construction. */
export function clearSeededRoleFields(p: Project): Project {
  const roster = p.roster
  if (!roster?.length) return p
  const presets = rolePresets()
  let changed = false
  const next = roster.map((r) => {
    const preset = presets.find((x) => x.id === r.id)
    if (!preset) return r // a custom lane has no preset to compare against — never touch it
    const out: Role = { ...r }
    let hit = false
    if (r.model === preset.model) { delete (out as Partial<Role>).model; hit = true }
    if (r.effort !== undefined && r.effort === preset.effort) { delete out.effort; hit = true }
    if (!hit) return r
    changed = true
    return out
  })
  return changed ? { ...p, roster: next } : p
}

/** How many fields `clearSeededRoleFields` would clear, and how many stay pinned — for the
 *  confirm copy on the explicit reset, which must name a count rather than say "some". */
export function seededFieldCounts(projects: Project[]): { clear: number; pinned: number; projects: number } {
  const presets = rolePresets()
  let clear = 0, pinned = 0, touched = 0
  for (const p of projects) {
    let any = false
    for (const r of p.roster ?? []) {
      const preset = presets.find((x) => x.id === r.id)
      if (!preset) continue
      if (r.model === preset.model) { clear++; any = true } else if (set(r.model)) pinned++
      if (r.effort !== undefined) {
        if (r.effort === preset.effort) { clear++; any = true } else pinned++
      }
    }
    if (any) touched++
  }
  return { clear, pinned, projects: touched }
}

/** The harder case: a user who DID pin models per project and now wants the global to win.
 *  Clears every pinned model/effort on every roster — not only the seeded ones. Explicit,
 *  confirmed, and undoable from the backup; never a side effect of anything. */
export function clearAllPinnedRoleFields(projects: Project[]): Project[] {
  return projects.map((p) => {
    if (!p.roster?.length) return p
    let changed = false
    const roster = p.roster.map((r) => {
      if (!set(r.model) && r.effort === undefined) return r
      changed = true
      const out: Role = { ...r }
      delete (out as Partial<Role>).model
      delete out.effort
      return out
    })
    return changed ? { ...p, roster } : p
  })
}

/** Every pinned model/effort across all projects — the count the reset must name. */
export function pinnedFieldCounts(projects: Project[]): { fields: number; lanes: number; projects: number } {
  let fields = 0, lanes = 0, touched = 0
  for (const p of projects) {
    let any = false
    for (const r of p.roster ?? []) {
      let laneHit = false
      if (set(r.model)) { fields++; laneHit = true }
      if (r.effort !== undefined) { fields++; laneHit = true }
      if (laneHit) { lanes++; any = true }
    }
    if (any) touched++
  }
  return { fields, lanes, projects: touched }
}
