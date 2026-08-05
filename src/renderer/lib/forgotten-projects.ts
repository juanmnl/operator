// THE PROJECTS THE USER FORGOT — durable, because forgetting has to outlive the renderer that
// was told about it.
//
// "Forget" removes a project from the store entirely: no row, no roster, no `archivedAt` to hang
// a flag on. What it deliberately does NOT do is kill the project's agents — the ptys keep
// running, unstamped, reachable from the gallery's activity view. That combination is what made
// forgetting reversible-by-accident:
//
//   forget → the record is gone, the ptys are not
//   restart (or a renderer respawn, which WebKit does on its own under memory pressure)
//   → the cwd-resolution effect sees a live pty with no project
//   → resolves its folder → upserts → THE PROJECT IS BACK, with a fresh roster and a bumped
//     `lastActiveAt`, so it sorts to the top as your most recent work
//
// The guard against that re-adoption lived in a `useRef(new Set())`, which is empty in a new
// process — so it held for exactly as long as nobody restarted. This is the same list, written
// down. It is the ONLY record that a forget ever happened, which is why it is stored rather than
// derived.
//
// SMALL AND UNBOUNDED ON PURPOSE: it is a list of ids the user explicitly forgot, so it grows
// only by deliberate acts, and an entry is removed the moment the project is deliberately opened
// again (`rememberProjectOpened`). Capping it would silently re-arm the resurrection for the
// oldest entries.

const KEY = 'operator.forgottenProjects'

export function loadForgottenProjects(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    // Defensive: a hand-edited or half-written value must not throw on the hydrate path, and a
    // non-array here would make `new Set(...)` do something surprising rather than nothing.
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  } catch {
    return []
  }
}

export function saveForgottenProjects(ids: Iterable<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(ids)]))
  } catch {
    /* quota — the in-memory guard still holds for this run */
  }
}

/** Record a forget. Returns the new list so the caller can keep its in-memory Set in step. */
export function rememberProjectForgotten(id: string, current: Iterable<string>): string[] {
  const next = [...new Set([...current, id])]
  saveForgottenProjects(next)
  return next
}

/** Un-record it. Called when the user DELIBERATELY brings the project back — opening the folder,
 *  launching a lane in it, or undoing the forget.
 *
 *  This is the counterpart that keeps the list honest: without it, a project you forgot in March
 *  and re-opened in April would keep failing to be adopted by its own running agents, which is
 *  the same class of "a decision no longer matches reality" bug pointing the other way. */
export function rememberProjectOpened(id: string, current: Iterable<string>): string[] {
  const next = [...current].filter((x) => x !== id)
  saveForgottenProjects(next)
  return next
}
