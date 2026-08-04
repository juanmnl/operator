// WHICH TABS THE BACKEND SAYS ARE GONE.
//
// `TerminalTab.ended` is set from one place: the `terminal:exit` event (DashboardView's
// `onTerminalExit`). That is correct only while the renderer is alive to hear it — and this
// renderer is not reliably alive. WebKit kills and respawns the WebContent process under memory
// pressure (measured: 737MB resting on a project with eight mounted terminals), and every event
// fired while it was dead is simply gone. The respawned renderer then holds tabs marked live for
// ptys whose children exited minutes ago.
//
// That is not a cosmetic staleness. `routeDispatch` decides "is there a live lane for this role"
// from `ended`, so a stale tab makes a dispatch take the SEND path into a dead pty: the write is
// swallowed, the task is stamped with that dead terminal id and tracked as running, and nothing
// ever reports a failure. Measured on 2026-08-04: three dispatches, two filed as `running`
// against a pty whose process had been gone for five hours, zero delivered.
//
// So `ended` cannot be event-sourced alone; it has to be reconciled against the backend, which
// answers from `try_wait` on the real child rather than from the existence of a pty entry.
//
// Pure and exported so the rule can be tested without a DOM or a pty — the same shape as
// `partitionBoard` and `landingFor`.

export interface LivenessTab {
  id: string
  ended?: boolean
}

/** One row of `window.operator.terminalList()`. */
export interface LivenessRecord {
  id: string
  alive: boolean
}

/** Ids of tabs that must be marked `ended`, because the backend says their child is gone.
 *
 *  Two ways to be gone, and both are needed:
 *
 *  · **Present but not alive** — the pty entry survives, the child exited. This is the
 *    authoritative signal, straight from `try_wait`.
 *  · **Absent from the list entirely** — the pty was torn down while we were not listening.
 *    Safe to treat as death because a tab is only ever created from a RESOLVED spawn, so the
 *    backend knows about a pty before any tab referencing it exists. There is no window in
 *    which a live tab is legitimately missing from this list.
 *
 *  ONE DIRECTION ONLY: this never clears `ended`. Resurrecting a tab because a reused id turned
 *  up alive would be a fabrication, and "ended" is the safe end of the error — it routes a
 *  dispatch to a fresh launch, where being wrong costs a process; the other way, being wrong
 *  costs the task.
 *
 *  Returns only tabs whose state would actually CHANGE, so a caller can skip the state update
 *  entirely when nothing moved — this runs on an interval against a renderer that is already
 *  under memory pressure, and a `setState` per tick with an identical array is exactly the kind
 *  of avoidable re-render that got us here.
 */
export function endedByBackend<T extends LivenessTab>(tabs: readonly T[], live: readonly LivenessRecord[]): string[] {
  const aliveById = new Map(live.map((t) => [t.id, t.alive]))
  const out: string[] = []
  for (const t of tabs) {
    if (t.ended) continue
    const alive = aliveById.get(t.id)
    if (alive === undefined || alive === false) out.push(t.id)
  }
  return out
}
