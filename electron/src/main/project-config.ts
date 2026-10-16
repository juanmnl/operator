// A project's own launch layers, read out of `projects.json`. Shared by the lane launch
// (`projectConfig` in ipc.ts) and by the transcript lookup, which has to know the config dir a
// lane's Claude Code writes under. Kept apart from ipc.ts so it can be tested without Electron.
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import * as store from './store'
import {
  resolveEnv, resolveSkills, envForSettingsFile, envNamesToUnset,
  skillOverridesForSettingsFile, enabledPluginsForSettingsFile,
} from '../../../src/renderer/lib/resolve-session-config'
import { denyReason } from '../../../src/renderer/lib/env-policy'
import type { Project, SkillMode } from '../../../src/shared/types'

export interface ProjectLayers {
  env?: Record<string, string>
  unsetEnv?: string[]
  skillOverrides?: Record<string, SkillMode>
  enabledPlugins?: Record<string, boolean>
}

/** The project's layers, or null when no project has this id. `store.loadProjects` reads an
 *  unreadable file as empty, so that case is null too. May throw from the resolvers. */
export async function readProjectConfig(projectId: string): Promise<ProjectLayers | null> {
  const projects = (await store.loadProjects()) as Project[]
  const project = projects.find((p) => p?.id === projectId)
  if (!project) return null
  const rows = resolveEnv([{ origin: 'project', entries: project.env }])
  const skills = resolveSkills([{ origin: 'project', policy: project.skills }])
  // The denylist runs again on the way out. The UI refuses these names at entry, but
  // `projects.json` is a file on the user's disk and an older build never knew the rule —
  // and a stale `PORT` reaching a lane would hand every one of them the same port.
  const env = envForSettingsFile(rows, (n) => denyReason(n) != null)
  const unsetEnv = envNamesToUnset(rows)
  const skillOverrides = skillOverridesForSettingsFile(skills)
  const enabledPlugins = enabledPluginsForSettingsFile(skills)
  return {
    env: Object.keys(env).length ? env : undefined,
    unsetEnv: unsetEnv.length ? unsetEnv : undefined,
    skillOverrides: Object.keys(skillOverrides).length ? skillOverrides : undefined,
    enabledPlugins: Object.keys(enabledPlugins).length ? enabledPlugins : undefined,
  }
}

/** The `CLAUDE_CONFIG_DIR` a lane's Claude Code runs under, from the env `terminals.ts` gives the
 *  pty: Operator's own env, then the project's variables, then its tombstones. Null when the value
 *  is not an absolute path, since where Claude Code resolves that from is not known here. */
export function effectiveConfigDir(layers: Pick<ProjectLayers, 'env' | 'unsetEnv'>, inherited: NodeJS.ProcessEnv, home = homedir()): string | null {
  const own = layers.env?.CLAUDE_CONFIG_DIR
  const value = own !== undefined ? own : layers.unsetEnv?.includes('CLAUDE_CONFIG_DIR') ? undefined : inherited.CLAUDE_CONFIG_DIR
  if (value === undefined) return join(home, '.claude')
  return isAbsolute(value) ? value : null
}

/** The directory a lane of this project keeps its transcripts in: `<config dir>/projects`. A lane
 *  with no project gets Operator's own env. Null when it cannot be told: the project id matches no
 *  project, or its config dir is not an absolute path. */
export async function laneProjectsDir(projectId: string | undefined, inherited: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  let layers: ProjectLayers | null
  try { layers = projectId ? await readProjectConfig(projectId) : {} } catch { return null }
  if (!layers) return null
  const dir = effectiveConfigDir(layers, inherited)
  return dir ? join(dir, 'projects') : null
}
