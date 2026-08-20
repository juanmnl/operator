// The durable JSON stores under `~/.operator` — `sessions.json`, `projects.json`,
// `role-defaults.json`, and the pre-migration backup.
//
// Mirrors the `save_*`/`load_*` commands in `lib.rs`, including the thing that makes them
// worth their own module: the CRASH-SAFE WRITE. Every save goes to `<name>.json.tmp` and is
// then `rename`d over the target, because `rename` within a filesystem is atomic — a crash
// mid-write leaves the previous good file, never a half-written one. `fs.writeFile` straight
// onto the target does not have that property, and the file it would corrupt is the user's
// whole session and project roster.
//
// The contents stay OPAQUE, exactly as in Rust: these are `serde_json::Value` there and
// `unknown` here. The shapes live in the frontend (`Project`, `AgentSession`,
// `GlobalRoleDefaults`), so there is no schema here to drift out of sync with them.
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const operatorDir = (): string => join(homedir(), '.operator')

const sessionsFile = () => join(operatorDir(), 'sessions.json')
const projectsFile = () => join(operatorDir(), 'projects.json')
const roleDefaultsFile = () => join(operatorDir(), 'role-defaults.json')

/** Write JSON through a temp file and an atomic rename. Failures are swallowed on the save
 *  path for the same reason the Rust version ignores them: these are fire-and-forget commands
 *  (`void invoke`) with no caller to report to, and throwing here would surface as an
 *  unhandled rejection rather than as anything a user could act on. */
async function writeAtomic(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (e) {
    console.error(`[store] failed to write ${path}:`, e)
  }
}

/** Read JSON, falling back to `fallback` for a missing OR unparseable file. A corrupt store
 *  must read as empty rather than throw: the alternative is an app that cannot boot because
 *  one file got truncated, which is strictly worse than one that boots empty. */
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export const saveSessions = (sessions: unknown[]) => writeAtomic(sessionsFile(), sessions)
export const loadSessions = () => readJson<unknown[]>(sessionsFile(), [])

export const saveProjects = (projects: unknown[]) => writeAtomic(projectsFile(), projects)
export const loadProjects = () => readJson<unknown[]>(projectsFile(), [])

export const saveRoleDefaults = (defaults: unknown) => writeAtomic(roleDefaultsFile(), defaults)
/** An OBJECT, not an array: keyed by role id. Empty means "inherit everything", which is
 *  exactly the state before the user has configured anything. */
export const loadRoleDefaults = () => readJson<Record<string, unknown>>(roleDefaultsFile(), {})

/** Copy `projects.json` to `~/.operator/backups/projects-<stamp>.json` before a migration
 *  rewrites rosters.
 *
 *  THIS ONE REJECTS RATHER THAN SWALLOWING. The caller's contract is "no backup, no write" —
 *  a migration that silently proceeds without one is how a roster gets lost with nothing to
 *  restore from. So unlike the saves above, a failure here has a caller who will act on it. */
export async function backupProjects(stamp: string): Promise<string> {
  const dir = join(operatorDir(), 'backups')
  await mkdir(dir, { recursive: true })
  const dest = join(dir, `projects-${stamp}.json`)
  await copyFile(projectsFile(), dest)
  return dest
}
