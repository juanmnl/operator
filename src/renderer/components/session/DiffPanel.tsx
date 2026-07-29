import { useEffect, useState, useMemo, useCallback } from 'react'
import type { WorktreeDiff } from '../../../shared/types'

interface DiffPanelProps {
  worktreePath: string
  branch?: string
  baseBranch?: string
  sourceRoot?: string
  onClose: () => void
  /** Called after a successful merge or discard so the host can drop the session/tab. */
  onSessionEnded?: () => void
}

interface FileBlock {
  path: string
  header: string
  lines: string[]
}

function parseDiff(text: string): FileBlock[] {
  const blocks: FileBlock[] = []
  let current: FileBlock | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current)
      const match = line.match(/diff --git a\/(\S+) b\/\S+/)
      current = { path: match?.[1] || '?', header: line, lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) blocks.push(current)
  return blocks
}

function lineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---')) return { color: 'var(--fg-muted)', opacity: 0.7 }
  if (line.startsWith('@@')) return { color: 'var(--accent)', opacity: 0.8 }
  if (line.startsWith('+')) return { color: 'var(--add-fg)', background: 'var(--add-bg)' }
  if (line.startsWith('-')) return { color: 'var(--del-fg)', background: 'var(--del-bg)' }
  return { color: 'var(--fg)', opacity: 0.75 }
}

export function DiffPanel({ worktreePath, branch, baseBranch, sourceRoot, onClose, onSessionEnded }: DiffPanelProps) {
  const [data, setData] = useState<WorktreeDiff | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<null | 'commit' | 'merge' | 'discard'>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const d = await window.operator.worktreeDiff(worktreePath)
    setData(d)
    setSelected((prev) => prev && d.files.some((f) => f.path === prev) ? prev : d.files[0]?.path ?? null)
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

  const blocks = useMemo(() => data ? parseDiff(data.diff) : [], [data])
  const currentBlock = selected ? blocks.find((b) => b.path === selected) : null

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

      {/* Body — file list left, diff right */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        <div style={{
          width: 220, flexShrink: 0,
          borderRight: '1px solid var(--border)', overflow: 'auto',
          padding: '6px 0',
        }}>
          {(data?.files || []).map((f) => (
            <button
              key={f.path}
              onClick={() => setSelected(f.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                width: '100%', padding: '4px 12px',
                background: selected === f.path ? 'var(--bg-surface)' : 'transparent',
                border: 'none', cursor: 'pointer',
                fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                fontSize: 11, color: 'var(--fg)', textAlign: 'left',
              }}
            >
              <span style={{
                fontSize: 9, color: 'var(--fg-muted)', width: 14, flexShrink: 0,
                textAlign: 'center',
              }}>
                {f.status.trim() || '·'}
              </span>
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
              }}>
                {f.path}
              </span>
              {(f.added > 0 || f.removed > 0) && (
                <span style={{ fontSize: 9, color: 'var(--fg-muted)', flexShrink: 0 }}>
                  {f.added > 0 && <span style={{ color: 'var(--add-fg)' }}>+{f.added}</span>}
                  {f.added > 0 && f.removed > 0 && ' '}
                  {f.removed > 0 && <span style={{ color: 'var(--del-fg)' }}>-{f.removed}</span>}
                </span>
              )}
            </button>
          ))}
          {data && data.files.length === 0 && (
            <div style={{ padding: '12px', fontSize: 11, color: 'var(--fg-muted)', }}>
              No changes
            </div>
          )}
        </div>
        <div style={{
          flex: 1, overflow: 'auto', minWidth: 0,
          background: 'var(--bg-terminal)',
          fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
          fontSize: 11, lineHeight: 1.5,
        }}>
          {currentBlock ? (
            <pre style={{ margin: 0, padding: '8px 0', whiteSpace: 'pre' }}>
              {currentBlock.lines.map((line, i) => (
                <div key={i} style={{ ...lineStyle(line), padding: '0 12px' }}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 11, }}>
              {data ? 'Select a file to see its diff' : 'Loading diff…'}
            </div>
          )}
        </div>
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
