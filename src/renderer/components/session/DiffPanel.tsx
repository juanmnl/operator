import { useEffect, useState, useCallback } from 'react'
import type { WorktreeDiff } from '../../../shared/types'
import { DiffBody } from './DiffBody'

// The Review surface: the same diff every other surface shows, plus the verbs that are
// genuinely this panel's own — commit, merge into base, discard the branch.
//
// It used to carry a SECOND `parseDiff` and its own renderer (~90 lines duplicating DiffBody),
// reached from the footer's Review button while the side panel's Diff tab and a task card's
// inline expander both went through DiffBody. Run over real git output the two parsers
// disagreed on four things — see parseDiff's comment in DiffBody. Two of them were bugs here:
// a path containing a space parsed to `?`, and since the file list matched blocks by path, that
// file could be selected but its diff NEVER appeared; and a rename resolved to the OLD path,
// which the file list (built from git status) never holds either. Both are gone with the
// duplicate. The left-hand file list went with it: DiffBody's collapsible per-file sections are
// that list, and its status letter is the one thing the two-pane layout carried that the
// sections didn't.

interface DiffPanelProps {
  worktreePath: string
  branch?: string
  baseBranch?: string
  sourceRoot?: string
  onClose: () => void
  /** Called after a successful merge or discard so the host can drop the session/tab. */
  onSessionEnded?: () => void
}

export function DiffPanel({ worktreePath, branch, baseBranch, sourceRoot, onClose, onSessionEnded }: DiffPanelProps) {
  const [data, setData] = useState<WorktreeDiff | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<null | 'commit' | 'merge' | 'discard'>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setData(await window.operator.worktreeDiff(worktreePath))
  }, [worktreePath])

  useEffect(() => { reload() }, [reload])

  const hasChanges = (data?.files.length ?? 0) > 0
  const canMerge = !!sourceRoot && !!branch && !!baseBranch

  const handleCommit = async () => {
    setBusy('commit')
    setError(null)
    const message = commitMessage.trim() || `Operator session changes on ${branch || 'worktree'}`
    const result = await window.operator.worktreeCommit(worktreePath, message)
    setBusy(null)
    if (!result.ok) {
      setError(result.error || 'Commit failed')
      return
    }
    setCommitMessage('')
    reload()
  }

  const handleMerge = async () => {
    if (!canMerge || !sourceRoot || !branch || !baseBranch) return
    setBusy('merge')
    setError(null)
    // Auto-commit pending changes first so the merge has something coherent to consume.
    if (hasChanges) {
      const message = commitMessage.trim() || `Operator session changes on ${branch}`
      const c = await window.operator.worktreeCommit(worktreePath, message)
      if (!c.ok) {
        setBusy(null)
        setError(c.error || 'Commit failed')
        return
      }
    }
    const result = await window.operator.worktreeMerge(worktreePath, sourceRoot, branch, baseBranch)
    setBusy(null)
    if (!result.ok) {
      setError(result.message || 'Merge failed')
      return
    }
    onSessionEnded?.()
  }

  const handleDiscard = async () => {
    if (!sourceRoot || !branch) return
    setBusy('discard')
    setError(null)
    const result = await window.operator.worktreeDiscard(worktreePath, sourceRoot, branch)
    setBusy(null)
    if (!result.ok) {
      setError(result.error || 'Discard failed')
      return
    }
    onSessionEnded?.()
  }

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      fontFamily: "var(--font-body)",
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg)' }}>Review changes</span>
        {data?.branch && (
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', }}>
            {data.branch}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', }}>
          {data ? `${data.files.length} file${data.files.length === 1 ? '' : 's'}` : 'loading…'}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', color: 'var(--fg-muted)',
            cursor: 'pointer', fontSize: 14, padding: '0 6px', fontFamily: 'inherit',
          }}
          title="Back to terminal"
        >
          ×
        </button>
      </div>

      {/* Body — the one diff renderer. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {data
          ? <DiffBody diff={data} />
          : <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 11 }}>Loading diff…</div>}
      </div>

      {/* Action bar */}
      {data && (sourceRoot && branch) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', borderTop: '1px solid var(--border)',
          background: 'var(--bg-surface)', flexShrink: 0,
        }}>
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder={hasChanges ? `Commit message — defaults to "Operator session changes on ${branch}"` : 'Nothing to commit'}
            disabled={!hasChanges || !!busy}
            style={{
              flex: 1, minWidth: 0,
              padding: '5px 10px', fontSize: 11,
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
              background: 'var(--bg-terminal)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 5,
              outline: 'none', boxSizing: 'border-box',
              opacity: hasChanges ? 1 : 0.5,
            }}
          />
          <button
            onClick={handleCommit}
            disabled={!hasChanges || !!busy}
            style={actionBtn('var(--fg)', false)}
            title="Stage all and commit"
          >
            {busy === 'commit' ? 'Committing…' : 'Commit'}
          </button>
          <button
            onClick={handleMerge}
            disabled={!canMerge || !!busy}
            style={actionBtn('var(--color-success)', true)}
            title={`Merge ${branch} into ${baseBranch || 'base branch'} and close session`}
          >
            {busy === 'merge' ? 'Merging…' : `Merge → ${baseBranch || 'base'}`}
          </button>
          <button
            onClick={handleDiscard}
            disabled={!sourceRoot || !branch || !!busy}
            style={actionBtn('var(--color-error)', false)}
            title="Delete branch and close session"
          >
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
        </div>
      )}
      {error && (
        <div style={{
          padding: '6px 14px', flexShrink: 0,
          background: 'var(--bg-surface)',
          color: 'var(--color-error)',
          fontSize: 11, borderTop: '1px solid var(--border)',
        }}>
          {error}
        </div>
      )}
    </div>
  )
}

function actionBtn(color: string, filled: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
    background: filled ? color : 'transparent',
    color: filled ? 'var(--fg-on-accent)' : color,
    border: filled ? 'none' : `1px solid ${color}`,
    borderRadius: 5,
    cursor: 'pointer',
    flexShrink: 0,
  }
}
