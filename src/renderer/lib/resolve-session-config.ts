// The cascade — project → lane → run — for env and skills, resolved PER ROW.
//
// S3 of `dev/results/session-settings-design.md`, and the design is emphatic about why this is
// one module with one rule:
//
//   > env and skills are SETS, not scalars. A lane that adds one variable must not shadow the
//   > project's whole block; a run that turns one skill off must not silently drop the project's
//   > other twelve.
//
// That is the thing most likely to be built wrong, so it is built once, here, and both surfaces
// render this output rather than each merging for itself.
//
// `role-defaults.json` — the retired user-global tier — is NOT revived. `model-config.ts` holds
// the line that lane launch config resolves through preset → lane pin and nothing else; this is
// a separate cascade for a separate kind of value, and the two are never reconciled into one
// legend.
import type { EnvEntry, SkillMode, SkillPolicy } from '../../shared/types'

export type { EnvEntry, SkillMode, SkillPolicy }

/** Where a row was set. `repo` is the project's own `.claude/settings.json` — read as an
 *  inherited layer, never written by these surfaces (one writer per file). */
export type EnvOrigin = 'repo' | 'project' | 'lane' | 'run'

export interface ResolvedEnvRow {
  name: string
  value?: string
  /** Secret NAME. Resolved into the pty environment at spawn; never written to a settings file
   *  and never returned to the renderer as a value. */
  secret?: string
  /** A tombstone won: the name is masked and must not be exported at all. */
  unset?: boolean
  origin: EnvOrigin
  /** What the layer below said — drives the restore affordance and the tooltip. */
  shadowed?: { value?: string; secret?: string; unset?: boolean; origin: EnvOrigin }
}

/** One altitude's contribution. */
export interface EnvLayer {
  origin: EnvOrigin
  entries?: readonly EnvEntry[]
}

/** Merge by NAME, last writer wins, origin recorded per row.
 *
 *  Layers are given low-to-high. A later layer that mentions a name replaces that ROW and
 *  nothing else — the rows it does not mention keep the lower layer's value and the lower
 *  layer's origin, which is the whole point.
 *
 *  Insertion order is preserved: a name first seen at the project layer keeps the project's
 *  position even when a run overrides its value, so the list does not reshuffle as someone
 *  edits it. */
export function resolveEnv(layers: readonly EnvLayer[]): ResolvedEnvRow[] {
  const rows = new Map<string, ResolvedEnvRow>()
  for (const layer of layers) {
    for (const entry of layer.entries ?? []) {
      if (!entry.name) continue
      const prev = rows.get(entry.name)
      const next: ResolvedEnvRow = { name: entry.name, origin: layer.origin }
      if ('value' in entry) next.value = entry.value
      else if ('secret' in entry) next.secret = entry.secret
      else next.unset = true
      // Only record a shadow when something was actually displaced, and never let a row shadow
      // itself: re-stating the same value at a higher altitude is not an override worth a
      // restore affordance.
      if (prev && !sameRow(prev, next)) {
        // Only the key that was actually set — a shadow carrying `secret: undefined` alongside
        // its value reads as "there was a secret here too" to anything that inspects it.
        const shadowed: NonNullable<ResolvedEnvRow['shadowed']> = { origin: prev.origin }
        if (prev.value != null) shadowed.value = prev.value
        if (prev.secret != null) shadowed.secret = prev.secret
        if (prev.unset) shadowed.unset = true
        next.shadowed = shadowed
      } else if (prev?.shadowed && sameRow(prev, next)) {
        next.shadowed = prev.shadowed
      }
      rows.set(entry.name, next)
    }
  }
  return [...rows.values()]
}

function sameRow(a: ResolvedEnvRow, b: ResolvedEnvRow): boolean {
  return a.value === b.value && a.secret === b.secret && !!a.unset === !!b.unset
}

/** What actually goes into the per-session settings file's `env` block.
 *
 *  THREE THINGS ARE DROPPED, and each for its own reason:
 *  - a tombstone (`unset`), because the file has no way to say "remove this name" — a key with
 *    any value is a key that gets set. Masking is enforced by not writing the name at all,
 *    which is correct for the project/lane cascade (the name simply never appears);
 *  - a secret, because its value must never be written to a file Operator creates on disk;
 *  - a name the denylist refuses, which the UI should already have prevented — this is the
 *    backstop for a `projects.json` hand-edited or written by an older build. */
export function envForSettingsFile(
  rows: readonly ResolvedEnvRow[],
  isDenied: (name: string) => boolean = () => false,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.unset || r.secret != null || r.value == null) continue
    if (isDenied(r.name)) continue
    out[r.name] = r.value
  }
  return out
}

/** The names a tombstone masks — what the spawn path must DELETE from the inherited environment.
 *
 *  This is the other half of the drop above: the settings file cannot express "unset", so the
 *  only place a tombstone can be honoured is the pty env, by removing the name before exec. */
export function envNamesToUnset(rows: readonly ResolvedEnvRow[]): string[] {
  return rows.filter((r) => r.unset).map((r) => r.name)
}

/** The secret NAMES a spawn must resolve from the secret store. Values never pass through here.*/
export function secretNames(rows: readonly ResolvedEnvRow[]): string[] {
  return rows.filter((r) => r.secret != null).map((r) => r.secret!)
}

// ── skills ───────────────────────────────────────────────────────────────────────────────────

export interface SkillLayer {
  origin: EnvOrigin
  policy?: SkillPolicy
}

export interface ResolvedSkillRow {
  name: string
  mode: SkillMode
  origin: EnvOrigin
}

export interface ResolvedSkills {
  /** Per-skill listing mode, with the altitude that decided it. */
  overrides: ResolvedSkillRow[]
  /** Per-plugin on/off, with the altitude that decided it. */
  plugins: Array<{ plugin: string; enabled: boolean; origin: EnvOrigin }>
}

/** Same rule as `resolveEnv`, same reason: merge by NAME, last writer wins, per row.
 *
 *  Turning one skill off at the run altitude must not drop the project's other twelve, and the
 *  only way to guarantee that is to never replace the map wholesale. */
export function resolveSkills(layers: readonly SkillLayer[]): ResolvedSkills {
  const overrides = new Map<string, ResolvedSkillRow>()
  const plugins = new Map<string, { plugin: string; enabled: boolean; origin: EnvOrigin }>()
  for (const layer of layers) {
    for (const [name, mode] of Object.entries(layer.policy?.overrides ?? {})) {
      if (!name) continue
      overrides.set(name, { name, mode, origin: layer.origin })
    }
    for (const [plugin, enabled] of Object.entries(layer.policy?.plugins ?? {})) {
      if (!plugin) continue
      plugins.set(plugin, { plugin, enabled, origin: layer.origin })
    }
  }
  return { overrides: [...overrides.values()], plugins: [...plugins.values()] }
}

/** The `skillOverrides` block for the settings file.
 *
 *  `on` IS WRITTEN, not dropped, and that is deliberate: absent means on only when nothing below
 *  says otherwise, and the user's own `~/.claude/settings.json` frequently does say otherwise.
 *  Verified on this machine — a per-session `{"framer-code-components":"on"}` turned a skill on
 *  that the user's global settings had off. Dropping `on` as "the default" would throw away the
 *  only way to re-enable it for a project. */
export function skillOverridesForSettingsFile(resolved: ResolvedSkills): Record<string, SkillMode> {
  const out: Record<string, SkillMode> = {}
  for (const r of resolved.overrides) out[r.name] = r.mode
  return out
}

export function enabledPluginsForSettingsFile(resolved: ResolvedSkills): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const p of resolved.plugins) out[p.plugin] = p.enabled
  return out
}
