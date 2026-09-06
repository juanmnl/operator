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
    name: typeof d.name === 'string' ? d.name : undefined,
    cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
  }
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
      if (s) out.set(s.sessionId, s)
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
