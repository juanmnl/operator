// THE DEV SERVERS THE REAPER IS NOT ALLOWED TO TOUCH, listed so a person can decide.
//
// `refuseStray` and `staleTaggedRows` both refuse a row with no `OPERATOR_APP_PID`, and that
// refusal is correct and must stay: terminal ids are `t0`, `t1`, … per app RUN, so a row carrying
// `OPERATOR_TERMINAL_ID=t0` and nothing else could be this run's t0, an eleven-day-old t0 from a
// different project, or — measured on this machine while writing this — a Homebrew `postgres` and
// an Xcode `Python3` that merely inherited the variable from a shell somebody had exported it in.
// Killing on that evidence is how a reaper takes down a database.
//
// So the automatic path stops there, permanently, and this module is the other half the comment
// in reap.ts always deferred to: show the user what is running, say exactly how each row is
// attributed, and kill only what they confirm.
//
// EVIDENCE, NOT GUESSES. Everything below comes from ONE `ps -eww -o pid,ppid,pgid,lstart,command
// -E` — the same shape the reaper already takes, plus start time. No per-pid `lsof`: that is the
// call that fires a macOS TCC prompt per inspected process, which is why the port a row is
// actually bound to is never known here. `OPERATOR_DEV_PORT` is the lane's RESERVATION, and the
// column says so rather than implying a process was observed holding it.

import type { PsRow, TaggedRow } from './reap'

/** How confident we are about who owns a row, worst to best. The UI orders and warns on this. */
export type DevServerOwner =
  /** Tagged with a lane that is open in THIS Operator right now. Killing it kills a live lane's
   *  server — offered, but it is the one the user should think about. */
  | 'live-lane'
  /** Tagged with an Operator pid that is no longer running. The safest thing on the list. */
  | 'dead-app'
  /** Tagged with THIS Operator, but no such lane is open. The lane closed and left this behind. */
  | 'abandoned-lane'
  /** A dev-server command line under a known project path, with no Operator tag at all. Might be
   *  ours from before the tag existed; might be something the user started in their own terminal.
   *  Unprovable either way, which is the entire reason this list exists. */
  | 'untagged'

export interface DevServerRow {
  pid: number
  ppid: number
  /** The lane's RESERVATION from `OPERATOR_DEV_PORT`, not an observed binding. Absent when the
   *  row carries no tag. */
  reservedPort?: number
  terminalId?: string
  appPid?: number
  /** Best-effort working directory, read out of the command line — see `projectPathOf`. */
  cwd?: string
  /** The argv with the environment dump stripped off. */
  command: string
  /** Seconds since the process started, when `ps` gave us a parseable `lstart`. */
  ageSeconds?: number
  owner: DevServerOwner
}

/** Dev-server-shaped commands. Deliberately a short list of the things this app's projects
 *  actually run: a broad "anything with `node` in it" would sweep in the user's editor servers,
 *  language servers and Electron helpers, and this list is a kill button. */
const DEV_SERVER_RE = /\b(vite|next(?:-server)?|astro|webpack(?:-dev-server)?|nuxt|remix|parcel|rollup|tsx\s+watch|nodemon)\b/

/** Things that look like a dev server and are not one. `--mcp-serve` is Operator's OWN artifact
 *  helper riding on every lane; it carries the full tag set and would otherwise dominate the
 *  list, and killing it does nothing for a port. */
const NOT_A_SERVER_RE = /--mcp-serve|Operator Helper|\bclaude\b\s+--settings/

/** Strip the environment `ps -E` appends, so the row shows a command and not 4KB of exports.
 *  The env begins at the first `KEY=value` token that follows the argv — anchored on a space so
 *  an `=` inside an argument does not truncate the command. */
export function stripEnvDump(command: string): string {
  const m = / [A-Z_][A-Z0-9_]*=/.exec(command)
  return (m ? command.slice(0, m.index) : command).trim()
}

/** The project or worktree a command belongs to, inferred from the first absolute path in it that
 *  sits under one of the known roots. Absent when nothing matches — which is itself a signal, and
 *  the reason an unattributable row is not offered as "probably yours". */
export function projectPathOf(command: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    if (!root) continue
    const i = command.indexOf(root)
    if (i >= 0) {
      // Up to the `node_modules` boundary when there is one, so `/p/node_modules/.bin/vite`
      // reads as `/p` rather than as a path nobody recognises.
      const rest = command.slice(i)
      const cut = rest.indexOf('/node_modules')
      return cut > 0 ? rest.slice(0, cut) : root
    }
  }
  return undefined
}

/** `ps` prints `lstart` as `Fri Sep  5 14:02:11 2026`. Returns undefined rather than a wrong
 *  number when it cannot be read — an age column that lies is worse than a blank one on a list
 *  whose whole job is helping someone decide what to kill. */
export function ageSecondsFrom(lstart: string, now: number): number | undefined {
  const t = Date.parse(lstart)
  if (Number.isNaN(t)) return undefined
  const secs = Math.floor((now - t) / 1000)
  return secs >= 0 ? secs : undefined
}

export interface InventoryInput {
  /** Tagged rows, from the same sweep the reaper uses. */
  tagged: readonly TaggedRow[]
  /** The full process table, for untagged dev-server-shaped commands. */
  ps: readonly PsRow[]
  /** Terminal ids open in THIS Operator right now. */
  openTerminalIds: ReadonlySet<string>
  appPid: number
  selfPid: number
  /** Project and worktree roots, so an untagged row can be tied to something the user owns. */
  roots: readonly string[]
  isAppAlive: (pid: number) => boolean
  /** pid → seconds alive, from the same snapshot. */
  ages?: ReadonlyMap<number, number>
}

/** Everything worth showing, newest evidence first. Pure, so the classification is tested against
 *  a fabricated table rather than against whatever is running — which matters here more than
 *  usual, because every row is a kill button. */
export function devServerInventory(input: InventoryInput): DevServerRow[] {
  const out = new Map<number, DevServerRow>()

  for (const r of input.tagged) {
    if (r.pid <= 1 || r.pid === input.selfPid) continue
    const command = stripEnvDump(r.command)
    if (NOT_A_SERVER_RE.test(command)) continue
    // A TAGGED row is listed whether or not its command looks like a server: the tag is stronger
    // evidence than the command shape, and a leaked `node server.mjs` (measured on this machine,
    // t14) matches no dev-server pattern at all.
    out.set(r.pid, {
      pid: r.pid,
      ppid: 0,
      reservedPort: r.devPort,
      terminalId: r.terminalId,
      appPid: r.appPid,
      cwd: projectPathOf(command, input.roots),
      command,
      ageSeconds: input.ages?.get(r.pid),
      owner: ownerOf(r, input),
    })
  }

  for (const r of input.ps) {
    if (r.pid <= 1 || r.pid === input.selfPid || out.has(r.pid)) continue
    const command = stripEnvDump(r.command)
    if (!DEV_SERVER_RE.test(command) || NOT_A_SERVER_RE.test(command)) continue
    // Untagged rows must be tied to a root the user owns. Without that this becomes a list of
    // every `vite` on the machine, including ones belonging to work that has nothing to do with
    // Operator — and offering to kill those is exactly the overreach the tag rule prevents.
    const cwd = projectPathOf(command, input.roots)
    if (!cwd) continue
    out.set(r.pid, { pid: r.pid, ppid: r.ppid, cwd, command, ageSeconds: input.ages?.get(r.pid), owner: 'untagged' })
  }

  // Safest first: a user scanning this should meet the rows they can kill without thinking before
  // the ones that would take a live lane's server down.
  const rank: Record<DevServerOwner, number> = { 'dead-app': 0, 'abandoned-lane': 1, untagged: 2, 'live-lane': 3 }
  return [...out.values()].sort((a, b) => rank[a.owner] - rank[b.owner] || a.pid - b.pid)
}

function ownerOf(r: TaggedRow, input: InventoryInput): DevServerOwner {
  if (r.appPid == null) return 'untagged'
  if (r.appPid !== input.appPid) return input.isAppAlive(r.appPid) ? 'live-lane' : 'dead-app'
  return r.terminalId && input.openTerminalIds.has(r.terminalId) ? 'live-lane' : 'abandoned-lane'
}

// ── the impure half ──────────────────────────────────────────────────────────────────────────

/** One `ps` pass that also carries start times, so the list can show an age.
 *
 *  `lstart` is a fixed-width 24-char field, which is why it is sliced rather than split: it
 *  contains spaces (`Fri Sep  5 14:02:11 2026`) and would otherwise eat the command.
 */
export async function ageSnapshot(now: () => number = Date.now): Promise<Map<number, number>> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const ages = new Map<number, number>()
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,lstart='], { maxBuffer: 16 * 1024 * 1024 })
    const t = now()
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.{24})/.exec(line)
      if (!m) continue
      const secs = ageSecondsFrom(m[2].trim(), t)
      if (secs != null) ages.set(Number(m[1]), secs)
    }
  } catch { /* an age column is a nicety; the list is still useful without it */ }
  return ages
}
