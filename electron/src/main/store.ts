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

/** `~/.operator`, or wherever `OPERATOR_DIR` points.
 *
 *  The override exists for TESTS. Everything under here is real user data — the session roster,
 *  the project store, the worktree provenance — and a test that exercises the real paths would
 *  be writing into it. The Rust tests take temp dirs as parameters for the same reason; an env
 *  var is the version of that which works when the path is read from three modules. */
export const operatorDir = (): string => process.env.OPERATOR_DIR || join(homedir(), '.operator')

const sessionsFile = () => join(operatorDir(), 'sessions.json')
const projectsFile = () => join(operatorDir(), 'projects.json')
const roleDefaultsFile = () => join(operatorDir(), 'role-defaults.json')

/** Write JSON through a temp file and an atomic rename. Failures are swallowed on the save
 *  path for the same reason the Rust version ignores them: these are fire-and-forget commands
 *  (`void invoke`) with no caller to report to, and throwing here would surface as an
 *  unhandled rejection rather than as anything a user could act on. */
/** Serialize the way `serde_json::to_string_pretty` does — 2-space indent, and **keys sorted**.
 *
 *  The sort is the non-obvious half. serde_json without the `preserve_order` feature backs a
 *  JSON object with a `BTreeMap`, so it writes keys alphabetically; `JSON.stringify` writes them
 *  in insertion order. Round-tripping a Rust-written file hides this (its keys are already
 *  sorted), but the FIRST fresh save from the frontend would have rewritten every object in a
 *  different order — so a user moving between the two builds would see the whole file churn on
 *  each save, and no diff of `projects.json` would ever be readable again.
 *
 *  Key order carries no meaning in JSON; matching it costs one comparator and makes the two
 *  shells produce identical bytes for identical state. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    }
    return v
  }, 2)
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, stableStringify(value), 'utf8')
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
