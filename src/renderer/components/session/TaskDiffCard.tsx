import { useEffect, useState } from 'react'
import type { ProjectTask, WorktreeDiff } from '../../../shared/types'
import { fetchTaskDiff } from '../../lib/task-diff'
import { DiffBody } from './DiffBody'

// A task's actual code change, expanded inline under its row in the queue. Resolves the
// diff from the task's provenance (live working dir → surviving branch fallback) and, for
// closed worktree lanes, offers the terminal verbs: Merge into base / Discard branch.
// Merge commits any leftover uncommitted work first so nothing silently drops.

export function TaskDiffCard({ task, laneLive }: { task: ProjectTask; laneLive: boolean }) {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'merge' | 'discard' | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchTaskDiff(task).then((d) => { if (!cancelled) { setDiff(d); setLoaded(true) } })
    return () => { cancelled = true }
  }, [task.id, task.cwd, task.worktreeBranch])

  // The merge verbs need the surviving branch and a lane that's no longer running (a live
  // lane's review belongs to its session — View → Review there instead).
  const canMerge = !laneLive && !!task.sourceCwd && !!task.worktreeBranch && !!task.worktreeBase

  const runMerge = async () => {
    if (!task.sourceCwd || !task.worktreeBranch || !task.worktreeBase) return
    setBusy(true); setConfirm(null)
    // Sweep uncommitted worktree edits into the branch first (no-op when clean or dir gone).
    if (task.cwd) await window.operator.worktreeCommit(task.cwd, `Task: ${task.text.slice(0, 72)}`)
    const res = await window.operator.worktreeMerge(task.cwd ?? '', task.sourceCwd, task.worktreeBranch, task.worktreeBase)
    setBusy(false)
    setNotice(res.ok ? `Merged into ${task.worktreeBase} ✓` : (res.message ?? 'Merge failed'))
  }

  const runDiscard = async () => {
    if (!task.sourceCwd || !task.worktreeBranch) return
    setBusy(true); setConfirm(null)
    const res = await window.operator.worktreeDiscard(task.cwd ?? '', task.sourceCwd, task.worktreeBranch)
    setBusy(false)
    setNotice(res.ok ? 'Branch discarded' : (res.error ?? 'Discard failed'))
  }

  const btn: React.CSSProperties = {
    fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 9px', borderRadius: 6,
    border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', outline: 'none',
  }

  return (
    <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--bg-terminal)' }}>
      {!loaded && (
        <div style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-muted)' }}>Resolving diff…</div>
      )}
      {loaded && !diff && (
        <div style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-muted)' }}>
          No diff to show — no changes, or the worktree and branch are gone.
        </div>
      )}
      {loaded && diff && (
        <div style={{ height: 300, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-body)' }}>
          <DiffBody diff={diff} compact />
        </div>
      )}
      {(canMerge || notice) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderTop: '1px solid var(--border)' }}>
          {notice ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg)' }}>{notice}</span>
          ) : busy ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-muted)' }}>Working…</span>
          ) : confirm ? (
            <>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg)' }}>
                {confirm === 'merge' ? `Merge ${task.worktreeBranch} into ${task.worktreeBase}?` : `Delete branch ${task.worktreeBranch}?`}
              </span>
              <button onClick={confirm === 'merge' ? runMerge : runDiscard} style={{ ...btn, marginLeft: 'auto', color: 'var(--accent)' }}>Confirm</button>
              <button onClick={() => setConfirm(null)} style={{ ...btn, color: 'var(--fg-muted)' }}>Cancel</button>
            </>
          ) : (
            <>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>{task.worktreeBranch}</span>
              <button onClick={() => setConfirm('merge')} style={{ ...btn, marginLeft: 'auto', color: 'var(--accent)' }} title={`Merge ${task.worktreeBranch} into ${task.worktreeBase}`}>Merge ↩</button>
              <button onClick={() => setConfirm('discard')} style={{ ...btn, color: 'var(--fg-muted)' }} title="Delete the branch (change is lost)">Discard</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
