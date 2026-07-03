import type { ProjectResolution } from '../../shared/types'
import { deriveProjectId } from './project-id'

// The single place that encodes "a session's Project = its canonical git repo root" (so a
// worktree session maps to its SOURCE repo, one project) and "a non-git folder is its own
// project". Callers pass `sourceCwd ?? cwd` so worktrees resolve to the source, never the
// worktree path. Reuses the existing inspect_repo command (git rev-parse --show-toplevel).
export async function resolveProject(sourceCwd: string): Promise<ProjectResolution> {
  let path = sourceCwd
  try {
    const info = await window.operator.inspectRepo(sourceCwd)
    if (info?.isRepo && info.root) path = info.root
  } catch { /* not a repo / command unavailable → fall back to the folder itself */ }
  const name = path.split('/').filter(Boolean).pop() || path
  return { id: deriveProjectId(path), path, name }
}
