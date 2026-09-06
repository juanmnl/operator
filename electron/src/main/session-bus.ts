// CLAUDE CODE'S OWN SESSION BUS, as far as Operator needs to see it.
//
// Spike: `dev/results/session-bus-spike.md`. Each `claude` process listens on its own Unix domain
// socket and publishes a descriptor beside it; there is no broker. This module reads the
// descriptors. It does NOT speak the socket protocol, and must not: the wire framing and the
// peer token's role are unconfirmed, and the blast radius of guessing wrong is every live lane on
// the machine. The lane itself does the sending, with its native `SendMessage`; Operator only
// says who to send to.
//
// ADDRESSING BY `sessionId`, NOT BY PID. The brief takes the address as computable from the pid
// of the `claude` Operator spawned. That is true and it is the weaker key: Operator's pty pid is
// the login shell, which may or may not have exec'd into `claude` depending on the shell's own
// optimisation, so it is right by coincidence rather than by construction. The descriptor carries
// `sessionId`, and that IS the uuid Operator assigns with `--session-id` — verified against a
// live lane (pid 19287 ↔ `479123b8-…`, matching the `--settings` path Operator wrote). Matching
// on it is exact and needs no assumption about process shape.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One live Claude Code session, as its own descriptor reports it. */
export interface BusSession {
  pid: number
  /** The Claude session uuid — Operator's `--session-id`, and the join key. */
  sessionId: string
  /** `/tmp/cc-socks/<pid>.sock`, taken from the descriptor rather than assembled. */
  socketPath: string
  /** Live: `idle` / `busy` / `shell`, updated in real time by the session itself. */
  status: string
  /** The name the Claude phone app and `ListAgents` show. */
  name?: string
  cwd?: string
  /** Epoch ms the session started, from the descriptor. The tie-break when two descriptors claim
   *  the same session — see `preferSession`. */
  startedAt?: number
}

const sessionsDir = () => join(homedir(), '.claude', 'sessions')

/** Parse one descriptor. Returns null rather than throwing for anything malformed — this reads
 *  files another program owns and rewrites constantly, so a half-written one is expected, not
 *  exceptional. */
export function parseBusSession(raw: string): BusSession | null {
  let d: Record<string, unknown>
  try { d = JSON.parse(raw) } catch { return null }
  const sessionId = typeof d.sessionId === 'string' ? d.sessionId : ''
  const socketPath = typeof d.messagingSocketPath === 'string' ? d.messagingSocketPath : ''
  const pid = typeof d.pid === 'number' ? d.pid : 0
  // All three are required. A descriptor without a socket path cannot be addressed, and one
  // without a session id cannot be attributed to a lane — either way there is nothing to return
  // that a caller could act on.
  if (!sessionId || !socketPath || !pid) return null
  return {
    pid,
    sessionId,
    socketPath,
    status: typeof d.status === 'string' ? d.status : 'unknown',
    startedAt: typeof d.startedAt === 'number' ? d.startedAt : undefined,
    name: typeof d.name === 'string' ? d.name : undefined,
    cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
  }
}

/** Is this process still there?
 *
 *  `kill(pid, 0)` sends no signal — it only asks. EPERM is a LIVE answer: the process exists and
 *  belongs to someone else, which is a distinction that matters because getting it backwards would
 *  drop a real lane from the registry.
 *
 *  Deliberately not `lsof`: a per-pid `lsof` fires a macOS TCC consent prompt per process, which is
 *  a rule this repo learned the expensive way. `kill(pid, 0)` and a `stat` are free and silent. */
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Which of two descriptors for the same session is the one to address.
 *
 *  Operator's own restore path spawns with `--resume <same uuid>`, so a crashed process's leftover
 *  descriptor and the live one differ only by pid. Before this, `out.set(sessionId, …)` ran inside
 *  a `Promise.all` and the winner was whichever `readFile` happened to resolve last — nondeterministic,
 *  and free to be the dead one.
 *
 *  NEWEST `startedAt` WINS, with the higher pid breaking an exact tie. A descriptor with no
 *  `startedAt` loses to one that has it: an unstamped file is the older format, and the fallback has
 *  to be an order rather than a coin toss. */
export function preferSession(a: BusSession, b: BusSession): BusSession {
  if (a.startedAt !== b.startedAt) return (b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a
  return b.pid > a.pid ? b : a
}

/** Every live session, by `sessionId`.
 *
 *  The directory is world-readable and holds one file per session; the owner-only `.key` siblings
 *  are never touched — the peer token is not ours to hold, and Operator never sends on the socket
 *  itself. An unreadable directory reads as "no sessions", because a router that refuses to answer
 *  is worse than one that says it can reach nobody. */
export async function readBusSessions(): Promise<Map<string, BusSession>> {
  const out = new Map<string, BusSession>()
  let files: string[]
  try { files = await readdir(sessionsDir()) } catch { return out }
  await Promise.all(files.map(async (f) => {
    if (!f.endsWith('.json')) return
    try {
      const s = parseBusSession(await readFile(join(sessionsDir(), f), 'utf8'))
      if (!s) return
      // LIVENESS, because a descriptor outlives its process. A `claude` killed with SIGKILL never
      // gets to clean up, and the file it leaves behind makes a dead lane look addressable —
      // Operator would then answer `send` with a socket that refuses to connect. `addressOf`'s
      // own comment argued that null is a real answer; this is what makes null actually happen.
      // (Measured on a healthy machine: 20 of 20 descriptors live, so this is the crash path
      // rather than routine hygiene.)
      if (!pidAlive(s.pid) || !existsSync(s.socketPath)) return
      const prior = out.get(s.sessionId)
      if (prior) {
        const winner = preferSession(prior, s)
        // Logged rather than silent: two descriptors for one session means a process died in a
        // way that left its file, and that is worth being able to see afterwards.
        console.warn(`[bus] two descriptors for session ${s.sessionId} (pid ${prior.pid} and ${s.pid}); using ${winner.pid}`)
        out.set(s.sessionId, winner)
        return
      }
      out.set(s.sessionId, s)
    } catch { /* the file went away between readdir and read — ordinary here */ }
  }))
  return out
}

/** The address a lane's peer should be sent to, or null when that lane is not on the bus.
 *
 *  Null is a real answer and the caller must render it as one: a lane Operator believes is open
 *  can be absent here because it has not finished starting, or because it exited without Operator
 *  noticing yet. Guessing `/tmp/cc-socks/<pid>.sock` from a pid Operator holds would produce an
 *  address that looks valid and refuses to connect. */
export function addressOf(sessions: Map<string, BusSession>, claudeSessionId: string | undefined): string | null {
  if (!claudeSessionId) return null
  const hit = sessions.get(claudeSessionId)
  return hit ? `uds:${hit.socketPath}` : null
}
