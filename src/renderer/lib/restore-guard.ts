// ONE PROCESS PER CONVERSATION, across every path that restores a saved lane.
//
// The resume card, Project Home's "Resume N agents", auto-resume at launch, the sidebar and ⌘K
// each take their list of lanes when they start, and one restore takes seconds (folder check,
// worktree rebuild, project resolve, spawn). Two of them reaching the same lane spawned two
// `claude --resume <id>` into one conversation; for a worktree lane, two agents in one checkout,
// or one resumed on a fresh branch without its commits (review H1, 2026-10-06).
//
// So a restore claims its key for its whole run, and is told how to ask "is it live now?" so it
// can ask once more right before the spawn: every await before that is a window in which a path
// that does not go through here (a launch reusing the lane, a re-attach) can have brought it back.

export type RestoreOutcome = 'started' | 'skipped' | 'failed'

/** Run `restore` for `key` unless that lane is live or another restore of it is under way.
 *  `inFlight` is shared by every caller; the key is released when `restore` settles. */
export async function restoreOnce(
  inFlight: Set<string>,
  key: string,
  isLive: () => Promise<boolean>,
  restore: (isLive: () => Promise<boolean>) => Promise<RestoreOutcome>,
): Promise<RestoreOutcome> {
  if (inFlight.has(key)) return 'skipped'
  inFlight.add(key)
  try {
    if (await isLive()) return 'skipped'
    return await restore(isLive)
  } finally {
    inFlight.delete(key)
  }
}

/** Is this saved lane live: a tab with its key, or (for a `--resume`) a running pty on its
 *  conversation, which is the check that also sees a pty the renderer has no tab for. */
export async function laneIsLive(
  saved: { key: string; claudeSessionId?: string },
  resume: boolean,
  tabs: () => ReadonlyArray<{ key: string }>,
  ptys: () => Promise<ReadonlyArray<{ alive: boolean; claudeSessionId?: string }> | undefined>,
): Promise<boolean> {
  if (tabs().some((t) => t.key === saved.key)) return true
  if (!resume || !saved.claudeSessionId) return false
  const list = await ptys().catch(() => undefined)
  return !!list?.some((p) => p.alive && p.claudeSessionId === saved.claudeSessionId)
}
