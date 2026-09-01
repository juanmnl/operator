// THE EFFORT LADDER, and the two conversions that keep it honest.
//
// The ladder itself is `EffortLevel` (shared/types) — Claude Code's own, ascending, read out of
// the installed 2.1.257 binary rather than the docs. This module owns everything derived from it,
// for the same reason `model-config` owns the launch cascade: the union used to be re-spelled at
// ten call sites, and a set that is spelled ten times is a set that drifts. It drifted — the value
// Operator wrote most often, `normal`, was never in the CLI's enum at all.
//
// TWO SEAMS, and they are not the same seam:
//
//   the FLAG      `--effort <level>` at launch, `/effort <level>` mid-session. Takes all five,
//                 `max` included. This is how a LANE's effort travels.
//   the FILE      `settings.json`'s `effortLevel`, whose schema is
//                 `enum(["low","medium","high","xhigh"]).catch(undefined)` — four values, and an
//                 out-of-enum one is dropped with no error and no warning. This is the app-wide
//                 default for sessions started outside Operator, and nothing else.
//
// `settingsEffort()` is the bridge between them, and it exists because the failure mode of getting
// it wrong is silence: the write succeeds, the file holds the value, and Claude Code ignores it.
import type { EffortLevel, SettingsEffortLevel, Project, Role, SavedSession } from '../../shared/types'

/** Ascending. The UI ladder is this order — a control that reads low → max the way the CLI's own
 *  help does, not the descending high/normal/low it used to draw. */
export const EFFORT_OPTIONS: ReadonlyArray<{ id: EffortLevel; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
]

export const EFFORT_LEVELS: ReadonlyArray<EffortLevel> = EFFORT_OPTIONS.map((o) => o.id)

/** What `settings.json` will actually keep. Rendered by the Preferences screen, which edits that
 *  file directly and must not offer a value the file silently discards. */
export const SETTINGS_EFFORT_LEVELS: ReadonlyArray<SettingsEffortLevel> = ['low', 'medium', 'high', 'xhigh']

/** The value Operator used to write. Not a Claude Code effort level — see `migrateEffort`. The
 *  literal lives HERE, once, so a grep for it finds the migration and nothing else. */
const LEGACY_EFFORT = 'normal'

/** An effort as it may appear in data written before the ladder was fixed. */
export type StoredEffort = EffortLevel | typeof LEGACY_EFFORT

/** `normal` → `medium`, everything on the ladder unchanged, anything else `undefined`.
 *
 *  MIGRATE, DON'T DEFAULT. `normal` sat between low and high in Operator's own UI and that is the
 *  faithful reading of what the user chose; falling back to the resolver's `high` would silently
 *  promote every lane that was deliberately turned down. Returns `undefined` for absent or junk so
 *  the caller can leave the field unset and let the cascade answer. */
export function migrateEffort(v: string | undefined | null): EffortLevel | undefined {
  if (v === LEGACY_EFFORT) return 'medium'
  return EFFORT_LEVELS.includes(v as EffortLevel) ? (v as EffortLevel) : undefined
}

/** Clamp a ladder value to what `settings.json`'s enum accepts: `max` → `xhigh`.
 *
 *  THE ONE PLACE this is allowed to happen. `max` is a real level for `--effort` and `/effort`,
 *  but the file's schema is `enum(["low","medium","high","xhigh"]).catch(undefined)` — writing
 *  `max` there does not fail, it just leaves the file holding a value Claude Code throws away on
 *  the next read, which looks exactly like the setting not working. */
export function settingsEffort(level: EffortLevel): SettingsEffortLevel {
  return level === 'max' ? 'xhigh' : level
}

/** The sidebar's one-glyph effort badge. `medium` and `max` both start with an M, so the first
 *  letter stopped being an identifier the moment the ladder grew — this is the mapping instead. */
export function effortCode(level: string): string {
  switch (level) {
    case 'low': return 'L'
    case 'medium': return 'M'
    case 'high': return 'H'
    case 'xhigh': return 'XH'
    case 'max': return 'MAX'
    default: return level.slice(0, 1).toUpperCase()
  }
}

// --- Hydrate-time migration ----------------------------------------------------------------
//
// Same shape as `clearSeededRoleFields` / `clearCoordinatorWorktree` in lib/model-config: content-
// sniffing, idempotent, and returning the SAME object when there is nothing to do — so hydrate can
// early-bail and running it twice is free.

/** Migrate a project's stored efforts: every roster pin, plus its own `defaults.effortLevel`. */
export function migrateProjectEfforts(p: Project): Project {
  let changed = false
  const out: Project = { ...p }

  if (p.defaults?.effortLevel !== undefined) {
    const next = migrateEffort(p.defaults.effortLevel)
    if (next !== p.defaults.effortLevel) {
      out.defaults = { ...p.defaults, effortLevel: next }
      changed = true
    }
  }

  if (p.roster?.length) {
    let rosterChanged = false
    const roster = p.roster.map((r) => {
      if (r.effort === undefined) return r
      const next = migrateEffort(r.effort)
      if (next === r.effort) return r
      rosterChanged = true
      const role: Role = { ...r }
      // An unrecognisable value becomes "inherit" rather than a pin to nothing — see `Role.effort`.
      if (next === undefined) delete role.effort
      else role.effort = next
      return role
    })
    if (rosterChanged) { out.roster = roster; changed = true }
  }

  return changed ? out : p
}

/** Migrate the efforts stored on saved sessions. Returns the input by reference when there is
 *  nothing to do, and a count so the caller can say what it touched. */
export function migrateSavedEfforts(list: SavedSession[]): { sessions: SavedSession[]; migrated: number } {
  let migrated = 0
  const next = list.map((s) => {
    if (s.effortLevel === undefined) return s
    const level = migrateEffort(s.effortLevel)
    if (level === s.effortLevel) return s
    migrated++
    const out: SavedSession = { ...s }
    if (level === undefined) delete out.effortLevel
    else out.effortLevel = level
    return out
  })
  return migrated ? { sessions: next, migrated } : { sessions: list, migrated: 0 }
}

/** True when a stored value is the one Operator used to write and Claude Code never accepted.
 *  Takes `unknown` on purpose: every field it is asked about is TYPED as an `EffortLevel`, which
 *  `normal` is not — the types describe what we write from now on, the data on disk predates them. */
export function isLegacyEffort(v: unknown): boolean {
  return v === LEGACY_EFFORT
}

/** How many stored `normal`s the store still carries — reporting only, so a migration can say what
 *  it did rather than claiming it ran. */
export function countLegacyEfforts(projects: Project[], saved: SavedSession[]): number {
  const inProjects = projects.reduce((n, p) => n
    + (isLegacyEffort(p.defaults?.effortLevel) ? 1 : 0)
    + (p.roster ?? []).filter((r) => isLegacyEffort(r.effort)).length, 0)
  return inProjects + saved.filter((s) => isLegacyEffort(s.effortLevel)).length
}
