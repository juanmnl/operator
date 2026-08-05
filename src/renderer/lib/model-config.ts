import type { Project, Role } from '../../shared/types'
import { rolePresets, isCoordinator } from './roster'

// A LANE'S LAUNCH CONFIG, and the one cascade that resolves it.
//
// TWO ALTITUDES, and that is the whole model:
//
//   the PRESET   what this kind of lane is for — `rolePresets()`, tuned per role and shipped.
//   the PIN      what THIS lane does instead. Absent = inherit.
//
// …with ONE documented exception, `permissionMode`, which reads the PROJECT instead of a preset.
// See `resolveAgentConfig`. It is not a fourth altitude sneaking back: permission mode has never
// been offered in any UI at any level, so it was never part of the paperwork the collapse existed
// to remove — it was removed as collateral, and that turned out to break new projects.
//
// It used to be three. Above the preset sat a user-owned global layer (`role-defaults.json`,
// edited on Agents → Defaults) and, for effort and permission mode, the project's own
// `defaults` as well — reconciled per field, with an "inherited from…" label under every
// control so you could tell which of the three you were looking at. The cascade worked. The
// problem was that it existed at all: the same decision was offered in three places, and a
// lane could not answer "what will this launch with" without a resolver and a legend.
//
// Collapsing it is `migrateGlobalsToLanePins` below, which writes the old answer down as pins
// wherever the two altitudes would disagree — so removing the tier changed nobody's config.
//
// NOTHING ELSE MAY DECIDE A LAUNCH'S MODEL/EFFORT/PERMISSION MODE. Two resolvers is how the two
// launch paths drift apart.

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
 *  Per FIELD, first defined wins: the lane's own pin → its preset → `HARD_FALLBACK`. Per field,
 *  not per source: a lane that pins only `effort` must still take its model from the preset.
 *  Resolving the whole object from the first source that has anything is the bug this ordering
 *  is written to avoid, and it survives the collapse from three altitudes to two.
 *
 *  `permissionMode` IS THE EXCEPTION, and takes `projectDefaults` instead of a preset layer:
 *  `pin → the project's default → HARD_FALLBACK ('default')`.
 *
 *  Why it is not on the presets, which would have been the tidier-looking answer: permission mode
 *  is a trust decision about a repository and a moment, not a property of what kind of work a lane
 *  does. Shipping `code: { permissionMode: 'auto' }` would auto-approve tool use for everyone who
 *  adds a Code lane — a security posture nobody asked for, applied by a default. No preset can
 *  honestly hold a value here.
 *
 *  Why it is not simply dropped: it had exactly one source, `Project.defaults.permissionMode`, and
 *  the collapse removed it. Existing rosters were covered by the migration (37 of the real store's
 *  56 pins were this field) but a NEW project had no such cover — its lanes silently stopped
 *  honouring the project's permission mode and would stall on prompts they used to pass. And those
 *  37 pins would have been un-editable: no screen writes `Role.permissionMode`.
 *
 *  Restoring the project as the source fixes both ends at once. It also makes the migration write
 *  ZERO permissionMode pins by construction — both cascades now read the same value, so
 *  "resolve both ways and compare" finds nothing to write. No special case was needed for that. */
export function resolveAgentConfig(role: Role, projectDefaults?: Project['defaults']): ResolvedAgentConfig {
  const preset = rolePresets().find((p) => p.id === role.id)
  const model = [role.model, preset?.model].find(set) ?? HARD_FALLBACK.model
  const effort = [role.effort, preset?.effort].find(set) ?? HARD_FALLBACK.effort
  const permissionMode = [role.permissionMode, projectDefaults?.permissionMode].find(set) ?? HARD_FALLBACK.permissionMode
  // Tri-state, and deliberately NOT `.find(set)`: `false` is a pin, not an absence.
  //
  // …EXCEPT FOR A COORDINATOR, WHICH IS NOT A CASCADE AT ALL. A coordinator always runs in the
  // repository itself, whatever is pinned on it, so this overrides the pin instead of ranking
  // below it. That inversion is the whole point: changing the preset alone would fix only the
  // lanes that never expressed an opinion, and five real projects have `useWorktree: true`
  // PERSISTED on their coordinator from when the preset said so. Their stored value is backfilled
  // separately (`clearCoordinatorWorktree`), but a migration is a one-shot on data we can see —
  // this is the invariant, and it holds for a roster restored from a backup, synced from another
  // machine, or hand-edited.
  //
  // WHY THE RULE. The coordinator merges lane branches, reaps worktrees and launches every other
  // lane. In its own worktree it does all three from a checkout nobody is looking at: it merges
  // into a branch that is not main, and — before the fix in `worktree.rs` — handed its own stale
  // HEAD to every lane it spawned. That is the reported "stale branches picked up", and it is why
  // work went missing rather than merely being untidy.
  const useWorktree = isCoordinator(role.id)
    ? false
    : [role.useWorktree, preset?.useWorktree].find(setBool) ?? HARD_FALLBACK.useWorktree
  return { model, effort, permissionMode, useWorktree }
}

/** The three states of a lane's worktree toggle, for the control that has to show which it is in. */
export type WorktreeState = 'inherit' | 'on' | 'off'
export function worktreeStateOf(role: Role): WorktreeState {
  return role.useWorktree === undefined ? 'inherit' : role.useWorktree ? 'on' : 'off'
}

// --- Collapsing the three altitudes to two -----------------------------------------------
//
// Removing a tier is only safe if nothing that was resolved THROUGH it changes answer. These
// two functions are that guarantee, and they are frozen history: they describe the cascade as
// it shipped, so they never need updating.

/** Per-role-id overrides as `~/.operator/role-defaults.json` stores them. Read once, by the
 *  migration, and never again — the file is left on disk as the record of what was there. */
export type LegacyGlobalDefaults = Record<string, {
  model?: string
  effort?: 'high' | 'normal' | 'low'
  permissionMode?: string
  useWorktree?: boolean
}>

/** THE OLD CASCADE, verbatim: pin → global → project defaults → preset → fallback. Kept only so
 *  the migration can ask "what did this lane launch with yesterday?" and get the true answer
 *  rather than a reconstruction. Note the two layers that are gone: the global tier, and
 *  `Project.defaults` for effort/permission mode (which had no per-role model to contribute). */
function legacyResolve(
  role: Role,
  globals: LegacyGlobalDefaults | undefined,
  projectDefaults: Project['defaults'] | undefined,
): ResolvedAgentConfig {
  const g = globals?.[role.id]
  const preset = rolePresets().find((p) => p.id === role.id)
  return {
    model: [role.model, g?.model, preset?.model].find(set) ?? HARD_FALLBACK.model,
    effort: [role.effort, g?.effort, projectDefaults?.effortLevel, preset?.effort].find(set) ?? HARD_FALLBACK.effort,
    permissionMode: [role.permissionMode, g?.permissionMode, projectDefaults?.permissionMode, preset?.permissionMode]
      .find(set) ?? HARD_FALLBACK.permissionMode,
    useWorktree: [role.useWorktree, g?.useWorktree].find(setBool) ?? HARD_FALLBACK.useWorktree,
  }
}

/** Write the old cascade's answer down as per-lane pins, wherever the two altitudes disagree.
 *
 *  MINIMAL BY CONSTRUCTION. It would be easier to pin every field on every lane, and it would
 *  also be wrong: that turns every preset into a pin, so no future preset improvement could ever
 *  reach anyone — the exact mistake the old `clearSeededRoleFields` existed to undo. So a field
 *  is pinned ONLY where dropping the tier would actually change the value. A lane inheriting
 *  `opus` from its preset via a global that also said `opus` keeps inheriting.
 *
 *  The check is the definition of correctness rather than a proxy for it: resolve each lane both
 *  ways and compare. `useWorktree` is where this earns its keep — the deleted global seed is the
 *  only place four of the six lanes were ever told to isolate, and without this they would all
 *  quietly fall to the hard fallback (off). Returns the input by reference when nothing applies. */
export function migrateGlobalsToLanePins(
  projects: Project[],
  globals: LegacyGlobalDefaults | undefined,
): { projects: Project[]; pins: number; lanes: number } {
  let pins = 0, lanes = 0
  const next = projects.map((p) => {
    if (!p.roster?.length) return p
    let changed = false
    const roster = p.roster.map((r) => {
      const before = legacyResolve(r, globals, p.defaults)
      const after = resolveAgentConfig(r, p.defaults)
      const out: Role = { ...r }
      let hit = false
      if (before.model !== after.model) { out.model = before.model; hit = true }
      if (before.effort !== after.effort) { out.effort = before.effort; hit = true }
      if (before.permissionMode !== after.permissionMode) { out.permissionMode = before.permissionMode; hit = true }
      // …EXCEPT a coordinator's worktree, which is no longer a preference to preserve.
      //
      // This function's whole contract is "what did this lane launch with yesterday? write it
      // down" — and for every other field that is still what we want. But the old global tier is
      // exactly where the coordinator was told to isolate (`role-defaults.json` carried
      // `useWorktree: true` for it), so without this clause the two cascades disagree by
      // construction on every coordinator and the migration DUTIFULLY RE-CREATES the pin that
      // `clearCoordinatorWorktree` exists to delete — on the same hydrate, from a file we do not
      // even read any more. A rule cannot be migrated back into a preference.
      const worktreeIsAPreference = !isCoordinator(r.id)
      if (worktreeIsAPreference && before.useWorktree !== after.useWorktree) { out.useWorktree = before.useWorktree; hit = true }
      if (!hit) return r
      pins += Number(before.model !== after.model) + Number(before.effort !== after.effort)
        + Number(before.permissionMode !== after.permissionMode)
        + Number(worktreeIsAPreference && before.useWorktree !== after.useWorktree)
      lanes++
      changed = true
      return out
    })
    return changed ? { ...p, roster } : p
  })
  return pins ? { projects: next, pins, lanes } : { projects, pins: 0, lanes: 0 }
}

// --- Reconciling seeded values ------------------------------------------------------------
//
// Every stored role entry written before 2026-07-28 carries an explicit `model`, because it was
// SEEDED from a preset when the project was created. A seeded value is indistinguishable from a
// deliberate override, so those lanes read as "pinned" on a control that means "I chose this",
// and they would not follow a preset change.
//
// The signal: a field that EQUALS the built-in preset for its role id was almost certainly
// seeded; one that DIFFERS was chosen. Clearing a field that equals the preset is a **no-op**
// for the launch — the cascade falls straight through to the same value — which is what makes
// it safe to run on hydrate. It only ever changes what the lane's control DRAWS (a redundant
// pin ring) and whether a future preset revision reaches it.

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

/** Drop a `useWorktree` pin from a COORDINATOR role, so the stored data stops disagreeing with
 *  what actually happens.
 *
 *  Five real projects carry `useWorktree: true` on their coordinator, written when the preset said
 *  so. `resolveAgentConfig` already ignores it — that is the load-bearing fix and it does not
 *  depend on this running — but a stored `true` is a lie that outlives the session: it draws a
 *  pinned control, it is what a backup restores, and it is what anyone reading `projects.json`
 *  would believe.
 *
 *  DELETED, NOT SET TO `false`. The pin means "I chose this", and nobody chose it — a preset wrote
 *  it. Writing `false` would replace one fiction with another and leave the lane looking
 *  deliberately opted out of a choice it is not offered. Absent is the truth: it inherits, and
 *  what it inherits is a rule.
 *
 *  Same shape as `clearSeededRoleFields` — returns the SAME object when there is nothing to do, so
 *  hydrate can early-bail and running it twice is free. */
export function clearCoordinatorWorktree(p: Project): Project {
  const roster = p.roster
  if (!roster?.length) return p
  let changed = false
  const next = roster.map((r) => {
    if (!isCoordinator(r.id) || r.useWorktree === undefined) return r
    changed = true
    const out: Role = { ...r }
    delete out.useWorktree
    return out
  })
  return changed ? { ...p, roster: next } : p
}
