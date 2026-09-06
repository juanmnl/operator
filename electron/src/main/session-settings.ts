// The per-session settings FILE — `claude --settings <path>` instead of `--settings <json>`.
//
// S0 of `dev/results/session-settings-design.md`. Until now the launch line carried the settings
// inline as a JSON string (`--settings {"tui":"default"}`), which works for exactly one scalar
// and nothing else: env blocks, skill overrides and plugin toggles are objects, and a growing
// JSON literal on an `-ilc` command line is one quoting bug away from a lane that won't start.
// A file is also the only form the user can read afterwards to see what a lane was given.
//
// WHAT `--settings` DOES, verified rather than assumed. The help text calls it "additional
// settings", and an experiment (recorded in `dev/results/session-settings-s0-s3.md`) confirms it
// MERGES over the user's `~/.claude/settings.json` at highest precedence rather than replacing
// it: a file containing only `{"skillOverrides":{"framer-code-components":"on"}}` turned that
// skill on while leaving the user's other two global overrides off. That was the single biggest
// risk in the brief, and it is retired — we can write only our own keys.
//
// MODE 600. The file lives outside the repo, is written by Operator, and outlives the run. It
// carries configuration, never a secret value — secrets resolve into the pty environment at
// spawn and are never written here — but 600 is what makes "only this user can read it" true
// rather than merely intended.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Claude Code's four listing modes for a skill. Absent = on.
 *
 *  Its own words, from the CLI binary, kept verbatim because the UI copy must not paraphrase
 *  them into something less exact: `"name-only"` lists the skill without its description;
 *  `"user-invocable-only"` hides it from the model but keeps `/name`; `"off"` hides it from
 *  both. */
export type SkillMode = 'on' | 'name-only' | 'user-invocable-only' | 'off'

/** Exactly the keys Operator writes. Deliberately NOT `[key: string]: unknown` — this file is
 *  merged at the highest precedence there is, so anything that lands in it silently outranks
 *  every other settings file on the machine. The narrow type is the guard. */
export interface SessionSettings {
  tui: 'default' | 'fullscreen'
  /** Config only. A secret's VALUE never appears here; see the module header. */
  env?: Record<string, string>
  skillOverrides?: Record<string, SkillMode>
  enabledPlugins?: Record<string, boolean>
  /** Start Claude Code's Remote Control bridge for this lane. See `buildSessionSettings` for why
   *  it is the one key written even when false. */
  remoteControlAtStartup?: boolean
}

/** `~/.operator/sessions/<sessionId>` — one directory per lane, so anything else we ever need to
 *  hand a session (an mcp config, a prompt file) has an obvious home next to this. */
export const sessionDir = (sessionId: string): string =>
  join(process.env.OPERATOR_DIR || join(homedir(), '.operator'), 'sessions', sessionId)

export const sessionSettingsPath = (sessionId: string): string =>
  join(sessionDir(sessionId), 'settings.json')

/** Drop the keys that carry nothing, so the file stays readable and a merge stays minimal.
 *
 *  An EMPTY object is not the same as an absent key here and the difference is not academic:
 *  `"enabledPlugins": {}` is a well-formed instruction that happens to say nothing, and writing
 *  it invites a future reader (or a future merge) to treat it as an intentional empty set.
 *  Pure, so the shape of what gets written is testable without a filesystem. */
export function buildSessionSettings(input: SessionSettings): SessionSettings {
  const out: SessionSettings = { tui: input.tui }
  if (input.env && Object.keys(input.env).length) out.env = input.env
  if (input.skillOverrides && Object.keys(input.skillOverrides).length) out.skillOverrides = input.skillOverrides
  if (input.enabledPlugins && Object.keys(input.enabledPlugins).length) out.enabledPlugins = input.enabledPlugins
  // THE ONE KEY WRITTEN EVEN WHEN FALSE, and the exception is the whole feature.
  //
  // Every other key here is dropped when it says nothing, because an absent key and an empty one
  // mean the same thing to a merge. Not this one: absent means "fall through", and what it falls
  // through to is an org default that is currently ON
  // (`remote_control_auto_on_by_default`) — which is why the Claude phone app started listing
  // every open lane. Writing `false` is the only way to say off.
  //
  // Read out of the installed binary (2.1.261), not the help text. `remoteControlAtStartup`
  // resolves as: project/local settings `false` wins outright; otherwise the first of
  // `["policySettings","flagSettings","userSettings"]`; then the legacy global config; then the
  // org default. A `--settings` file is `flagSettings`, so it outranks the user's own
  // `~/.claude/settings.json` and only an org policy beats it. Note the asymmetry the binary
  // logs about: a repo-scoped `true` is IGNORED, so this would not work from
  // `.claude/settings.json` even if we wrote there.
  if (input.remoteControlAtStartup !== undefined) out.remoteControlAtStartup = input.remoteControlAtStartup
  return out
}

/** Write the file and return its path, or `null` if it could not be written.
 *
 *  SYNCHRONOUS on purpose. The caller is `buildCommand`, which is sync and whose result is the
 *  argv the pty is about to exec; an async write here would be a race between the file existing
 *  and `claude` reading it, and losing that race means a lane launched with settings it was
 *  supposed to have and doesn't. The file is a few hundred bytes, once per lane.
 *
 *  A failure returns null rather than throwing, and the caller falls back to the inline JSON
 *  form. Never being able to launch a lane because a directory was not writable would be a
 *  strictly worse outcome than launching one without its env block. */
export function writeSessionSettings(sessionId: string, settings: SessionSettings): string | null {
  try {
    const dir = sessionDir(sessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = sessionSettingsPath(sessionId)
    writeFileSync(path, `${JSON.stringify(buildSessionSettings(settings), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return path
  } catch (e) {
    console.error('[session-settings] could not write, falling back to inline JSON:', e)
    return null
  }
}
