// Deferred deletion for worktree directories: rename into a trash root, delete in the background.
//
// Ported from `src-tauri/src/worktree.rs` (`move_to_trash`, `sweep_trash`), which the Electron
// port never carried over. Two reasons it exists:
//
// 1. A removal returns as soon as the rename is done. A lane checkout is routinely hundreds of
//    thousands of files, and a recursive delete of one blocked `git worktree remove` for seconds.
// 2. Every removal ends in the same place. Manual removal from Settings, the reaper, a lane close
//    and the `--force` fallback all rename into one root that one sweep drains, so there is a
//    single path to audit rather than four.
//
// TRIMMED FROM THE RUST, deliberately. The Rust version falls back to a sibling trash root beside
// the directory when the canonical rename crosses a volume, and keeps a registry of those roots.
// Every directory this module is asked to trash is a worktree Operator created under
// `~/.operator/worktrees`, which is the same volume as the canonical root, so the fallback has no
// case to serve. A rename that fails is reported to the caller as a failure instead; nothing is
// deleted in place.
import { mkdir, readdir, rename, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { operatorDir } from './store'

export const TRASH_DIR_NAME = '.operator-worktree-trash'

export const trashRoot = (): string => join(operatorDir(), 'worktrees', TRASH_DIR_NAME)

let counter = 0

/** `wt-<epoch-ms>-<8 lowercase hex>`. The sweep deletes only names of this shape. */
export function trashEntryName(now = Date.now()): string {
  counter = (counter + 1) >>> 0
  const nonce = ((Math.random() * 0xffffffff) ^ counter) >>> 0
  return `wt-${now}-${nonce.toString(16).padStart(8, '0')}`
}

/** The sweep only ever deletes entries it can prove it named. That pattern match is the safety. */
export function isTrashEntryName(name: string): boolean {
  return /^wt-\d+-[0-9a-f]{8}$/.test(name)
}

/** Move `path` into the trash root. Returns the trash entry, or throws when the rename fails —
 *  in which case the directory is exactly where it was. */
export async function moveToTrash(path: string): Promise<string> {
  const root = trashRoot()
  await mkdir(root, { recursive: true })
  const st = await lstat(root)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`trash root ${root} is not a plain directory`)
  const entry = join(root, trashEntryName())
  await rename(path, entry)
  return entry
}

/** How many entries one sweep deletes. A cap on deletions, not on entries examined, so a later
 *  sweep always makes progress (see the Rust `TRASH_SWEEP_MAX_DELETES`). */
const SWEEP_MAX_DELETES = 200

export interface SweepReport { removed: number; failed: number; deferred: number }

/** Delete trash entries, one at a time. Never throws. */
export async function sweepTrash(): Promise<SweepReport> {
  const report: SweepReport = { removed: 0, failed: 0, deferred: 0 }
  let names: string[]
  try {
    names = (await readdir(trashRoot(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return report
  }
  for (const name of names) {
    if (!isTrashEntryName(name)) continue
    if (report.removed + report.failed >= SWEEP_MAX_DELETES) { report.deferred++; continue }
    try {
      await rm(join(trashRoot(), name), { recursive: true, force: true })
      report.removed++
    } catch (e) {
      report.failed++
      console.error(`[worktree-trash] could not delete ${name}:`, e)
    }
  }
  if (report.deferred) console.error(`[worktree-trash] sweep stopped at ${SWEEP_MAX_DELETES}; ${report.deferred} left for the next run`)
  return report
}

// ONE SWEEP AT A TIME. A burst of removals schedules one sweep and, if more arrive while it runs,
// exactly one more after it, so disk I/O is serialised and nothing queued is skipped.
let running: Promise<void> | null = null
let again = false

/** Start a background sweep. Returns immediately; the returned promise is for tests. */
export function scheduleSweep(): Promise<void> {
  if (running) { again = true; return running }
  running = (async () => {
    do {
      again = false
      await sweepTrash()
    } while (again)
  })().finally(() => { running = null })
  return running
}
