// WHICH SAVED SESSION BELONGS TO WHICH LIVE PTY, and whether a tab still counts as live.
//
// Both halves of the same bug: the rail would not let a project go. Measured 2026-08-10 — 52 saved
// sessions, 23 real `claude` processes, 9 projects pinned to the rail permanently, and closing one
// did not remove it.
//
// Pure and exported so the rules can be tested without a pty or a DOM, the same shape as
// `terminal-liveness` and `project-shelf`.

/** One row of `window.operator.terminalList()` — a pty the backend is actually holding. */
export interface LivePty {
  id: string
  cwd?: string
  /** The forced `--session-id`, recorded by the backend AT SPAWN (see `terminal_spawn`), not
   *  derived from the transcript. So every Operator-launched pty has one, and it is stable across
   *  a renderer respawn AND a backend restart. */
  claudeSessionId?: string
  projectId?: string
  grid?: boolean
}

/** A row of `~/.operator/sessions.json`. Only the fields the join reads. */
export interface SavedRow {
  key: string
  claudeSessionId?: string
  terminalId?: string
}

export interface ReattachPair<P extends LivePty, S extends SavedRow> {
  pty: P
  /** The saved row this pty really is, or `undefined` when nothing matches it. */
  saved?: S
}

/** PAIR LIVE PTYS WITH SAVED ROWS. On `claudeSessionId`, and only very reluctantly on anything else.
 *
 *  `terminalId` is a PER-RUN COUNTER — `format!("t{}", mgr.next.fetch_add(..))`, an in-process
 *  `AtomicU64` that restarts at zero with the backend. So `t3` in `sessions.json` and `t3` in a live
 *  list from a later run are, in general, different sessions that happen to share a name.
 *
 *  The previous join tried `claudeSessionId` first and then fell back to the id unconditionally,
 *  which meant a recycled id could staple one project's saved row — its `projectId`, `key`, `cwd`,
 *  `roleId` — onto another project's live pty. The result is a project showing a live lane it does
 *  not have: `projectActivity` counts it, `isOnRail` pins it, and Close cannot remove it, because
 *  the lane it would have to end belongs to somebody else.
 *
 *  So the id fallback survives only where it cannot lie:
 *   - the live pty reports NO `claudeSessionId` (a legacy or non-Claude pty — an Operator lane
 *     always has one), AND
 *   - the saved row has none either. A row that recorded a uuid and did not match one is a row
 *     from an earlier run; its id is a coincidence, not a link, and
 *   - the row has not already been claimed by a uuid match, so one record can never label two ptys.
 *
 *  A pty with no match is still returned, with `saved: undefined`. That is deliberate and is
 *  existing behaviour: an unlabelled live pty is recoverable (the 5s re-stamp heals it from the
 *  backend's own `projectId`), whereas a MISLABELLED one looks correct and never heals. */
export function joinReattach<P extends LivePty, S extends SavedRow>(
  live: readonly P[],
  saved: readonly S[],
): ReattachPair<P, S>[] {
  const bySession = new Map<string, S>()
  for (const s of saved) if (s.claudeSessionId) bySession.set(s.claudeSessionId, s)

  const claimed = new Set<S>()
  const pairs: ReattachPair<P, S>[] = live.map((pty) => {
    if (!pty.claudeSessionId) return { pty }
    const hit = bySession.get(pty.claudeSessionId)
    if (hit) claimed.add(hit)
    return { pty, saved: hit }
  })

  // Only now, and only for ptys that named no session of their own.
  const byId = new Map<string, S>()
  for (const s of saved) {
    if (s.terminalId && !s.claudeSessionId) byId.set(s.terminalId, s)
  }
  for (const pair of pairs) {
    if (pair.saved || pair.pty.claudeSessionId) continue
    const hit = byId.get(pair.pty.id)
    if (hit && !claimed.has(hit)) {
      claimed.add(hit)
      pair.saved = hit
    }
  }
  return pairs
}

/** IS THIS TAB STILL A LIVE SESSION, for the purposes of every activity rollup?
 *
 *  `TerminalTab.ended` is the reconciled truth — set from `terminal:exit` and, more importantly,
 *  from `endedByBackend` polling the backend's `try_wait`, which is the only signal that survives
 *  WebKit killing the renderer. Nothing was reading it here.
 *
 *  The projection that feeds `projectActivity` hardcoded `status: 'active'` for any tab the
 *  transcript observer was not tracking — and the observer DROPS a session when it ends
 *  (`get_sessions` returns only `status == "active"`). So a lane's death made its tracked session
 *  disappear, the projection fell through to the synthetic branch, and the dead lane came back as
 *  ACTIVE and stayed that way for the life of the window. Every rollup downstream believed it:
 *  `projectActivity.live`, `isOnRail`, the "N running" label, and `closePlan`.
 *
 *  The tab's own death outranks the observer's silence, in that direction only — a tab that has not
 *  ended defers to whatever the observer says. */
export function tabSessionStatus(
  tab: { ended?: boolean },
  tracked?: { status: string },
): 'active' | 'ended' {
  if (tab.ended) return 'ended'
  return tracked?.status === 'ended' ? 'ended' : 'active'
}
