// The durable dev-port lease — the half of the reaper that has to survive a crash.
//
// `kill()` can only reap a tree it can still see. If Operator is force-quit, crashes, or its
// renderer takes the process down, nothing runs at all and the dev server outlives the app; the
// next launch is then the only chance to clean up, and by then the in-memory `portsByCwd` map
// and the `t0`/`t1` terminal ids are gone (the counter resets to `t0` every boot, so it is not
// a durable key for anything).
//
// So the lease is written to disk at SPAWN time, when the port is handed out, and deleted on a
// clean kill. Whatever is still in this file at boot is by definition a lane that never got a
// clean shutdown.
//
// KEYED BY `sessionId`, NOT `terminalId`: the Claude session uuid is stable across restarts and
// unique across concurrently running Operator instances, which `t0` is neither of.
//
// Same atomic write as `store.ts` (temp file + rename), for the same reason: a crash mid-write
// must leave the previous good file rather than a truncated one — and a crash is precisely the
// scenario this file exists to survive.
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { operatorDir } from './store'

/** One lane's claim on a dev port. */
export interface DevLease {
  /** Claude session uuid — the durable key. */
  sessionId: string
  /** Per-run terminal id (`t0`…). Not durable on its own; carried so a lease can be matched to
   *  the `OPERATOR_TERMINAL_ID` env tag on a surviving process. */
  terminalId: string
  /** The reserved port. Named `devPort` to match the field the rest of the app already uses. */
  devPort: number
  cwd: string
  /** Login-shell pid, for reporting. Useless for reaping after a restart — the shell is the
   *  first thing to die, which is what orphans the tree in the first place. */
  shellPid?: number
  /** The Operator instance that handed the port out. The one fact that tells a boot sweep
   *  whether a tagged survivor belongs to a DEAD Operator (reap it) or to a second one running
   *  right now (leave it alone). */
  appPid: number
  startedAt: string
}

const leasesFile = () => join(operatorDir(), 'dev-leases.json')

/** Read the lease file. A missing or corrupt file reads as empty, exactly as the other stores
 *  do: booting with no reap is bad, refusing to boot is worse. */
export async function loadLeases(): Promise<DevLease[]> {
  try {
    const parsed = JSON.parse(await readFile(leasesFile(), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((l): l is DevLease =>
      !!l && typeof l === 'object'
      && typeof (l as DevLease).sessionId === 'string'
      && Number.isInteger((l as DevLease).devPort))
  } catch {
    return []
  }
}

async function writeLeases(leases: DevLease[]): Promise<void> {
  const path = leasesFile()
  try {
    if (!leases.length) {
      // Don't leave an empty array lying around — an absent file is the same state and is one
      // less thing for a future reader to have to interpret.
      await unlink(path).catch(() => {})
      return
    }
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(leases, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (e) {
    console.error('[leases] failed to write:', e)
  }
}

/** Record a lease, replacing any previous claim by the same session.
 *
 *  Read-modify-write on every spawn is fine here: this file has one entry per open lane, so it
 *  is a few hundred bytes, and lanes are spawned at human speed. */
export async function claimLease(lease: DevLease): Promise<void> {
  const existing = await loadLeases()
  await writeLeases([...existing.filter((l) => l.sessionId !== lease.sessionId), lease])
}

/** Drop a lease — a clean kill happened, so there is nothing for the next boot to reap. */
export async function releaseLease(sessionId: string): Promise<void> {
  const existing = await loadLeases()
  const next = existing.filter((l) => l.sessionId !== sessionId)
  if (next.length !== existing.length) await writeLeases(next)
}

/** Drop every lease this Operator instance owns. The last step of the quit path: by then
 *  `killAll` has reaped the trees, so leaving the claims behind would have the NEXT boot sweep
 *  hunting for processes that no longer exist. */
export async function releaseLeasesOf(appPid: number): Promise<void> {
  const existing = await loadLeases()
  const next = existing.filter((l) => l.appPid !== appPid)
  if (next.length !== existing.length) await writeLeases(next)
}

/** Which leases have no live lane behind them.
 *
 *  `liveSessionIds` comes from `sessions.json` filtered to the lanes this run considers live —
 *  at boot that set is empty (nothing has been spawned yet), which is what makes every
 *  surviving lease stale by definition. The parameter exists so the same rule holds if this is
 *  ever run mid-session.
 *
 *  Pure, so the rule is testable without a process table or a home directory. */
export function staleLeases(
  leases: DevLease[],
  opts: { selfPid: number; isAppAlive: (pid: number) => boolean; liveSessionIds?: ReadonlySet<string> },
): DevLease[] {
  return leases.filter((l) => {
    if (l.appPid === opts.selfPid) return false
    if (opts.isAppAlive(l.appPid)) return false // a second Operator still owns this port
    if (opts.liveSessionIds?.has(l.sessionId)) return false
    return true
  })
}
