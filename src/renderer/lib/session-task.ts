import type { AgentSession, Project } from '../../shared/types'

/** What a lane is working on RIGHT NOW — or, failing that, the last thing it did.
 *
 *  Order matters, and every step deliberately takes the LAST match rather than the
 *  first: a plan grows over time, so the first entry is the oldest, and showing it
 *  makes a lane look stuck on work it finished long ago.
 *
 *  1. The in-progress plan item — the truest "doing this now".
 *  2. Else the most recently COMPLETED item — "just finished this".
 *  3. Else a project task still marked running on this lane (dispatched work that
 *     hasn't produced a plan yet), latest first.
 *  4. Only as a last resort, the session summary — which is derived from the FIRST
 *     user prompt, so it describes where the session STARTED, not where it is.
 */
/** Last element matching `pred`, or undefined. (Array.prototype.at isn't in this
 *  project's TS target, and the "last, not first" choice is the whole point here.) */
function findLast<T>(arr: readonly T[], pred: (v: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i]
  return undefined
}

export function currentTaskOf(session: AgentSession, project?: Project): string | undefined {
  const todos = session.todos ?? []
  const inProgress = findLast(todos, (t) => t.status === 'in_progress')
  if (inProgress) return inProgress.content

  const lastDone = findLast(todos, (t) => t.status === 'completed')
  if (lastDone) return lastDone.content

  const running = findLast(
    project?.tasks ?? [],
    (t) => t.status === 'running' && t.terminalId === session.terminalId,
  )
  if (running) return running.text

  return session.summary
}
