import { useEffect, useState } from 'react'
import type { AgentSession } from '../../../shared/types'

interface SessionInfoBarProps {
  session: AgentSession
  /** When set, polls `git status --porcelain` against this worktree to show change count. */
  worktreePath?: string | null
  onReviewChanges?: () => void
  onViewActivity?: () => void
  activityViewing?: boolean
}

export function SessionInfoBar({ session, worktreePath, onReviewChanges, onViewActivity, activityViewing }: SessionInfoBarProps) {
  const [expanded, setExpanded] = useState(false)
  const [changes, setChanges] = useState<number | null>(null)
  const started = new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const lastActivity = new Date(session.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isRunning = session.phase === 'running'
  const isCompacting = session.phase === 'compacting'
  const dotColor = isRunning ? 'var(--green)' : isCompacting ? 'var(--cyan)' : 'var(--fg-muted)'

  useEffect(() => {
    if (!worktreePath) {
      setChanges(null)
      return
    }
    let cancelled = false
    const tick = async () => {
      const status = await window.operator.worktreeStatus(worktreePath)
      if (!cancelled) setChanges(status.valid ? status.changes : null)
    }
    tick()
    const interval = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [worktreePath])

  return (
    <div style={{ flexShrink: 0, fontFamily: "var(--font-body)" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          height: 30,
          padding: '0 14px',
          boxSizing: 'border-box',
          background: 'none',
          border: 'none',
          borderBottom: '1px solid var(--border)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: dotColor, flexShrink: 0,
          animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : undefined,
        }} />
        <span
          title={`Session started ${started}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--fg-muted)', }}
        >
          {/* Clock glyph so the bare time reads as "when this session started". */}
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} aria-hidden>
            <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 4.6V8l2.4 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {started}
        </span>
        {session.lastToolName && (
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', }}>
            {session.lastToolName}
          </span>
        )}
        {session.activeSubagents > 0 && (
          <span style={{ fontSize: 9, color: 'var(--fg-muted)', background: 'var(--bg-surface)', borderRadius: 8, padding: '0px 5px' }}>
            {session.activeSubagents} sub
          </span>
        )}
        {changes !== null && changes > 0 && (
          <span
            onClick={(e) => { e.stopPropagation(); onReviewChanges?.() }}
            role={onReviewChanges ? 'button' : undefined}
            style={{
              fontSize: 9,
              color: 'var(--color-warning)',
              background: 'var(--bg-surface)',
              borderRadius: 8,
              padding: '0px 6px',
              opacity: 0.9,
              cursor: onReviewChanges ? 'pointer' : 'default',
              textDecoration: onReviewChanges ? 'underline dotted' : 'none',
              textUnderlineOffset: 2,
            }}
            title={onReviewChanges ? 'Review changes' : undefined}
          >
            {changes} change{changes === 1 ? '' : 's'}
          </span>
        )}
        {onViewActivity && (session.activity?.length ?? 0) > 0 && (
          <span
            onClick={(e) => { e.stopPropagation(); onViewActivity() }}
            role="button"
            style={{
              fontSize: 9,
              color: activityViewing ? 'var(--accent)' : 'var(--fg-muted)',
              background: 'var(--bg-surface)',
              borderRadius: 8,
              padding: '0px 6px',
              
              cursor: 'pointer',
              textDecoration: 'underline dotted',
              textUnderlineOffset: 2,
            }}
            title={activityViewing ? 'Back to terminal' : 'View activity timeline'}
          >
            {activityViewing ? 'terminal' : `${session.activity?.length ?? 0} acts`}
          </span>
        )}
        <span style={{
          marginLeft: 'auto',
          fontSize: 7,
          color: 'var(--fg-muted)',
          
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.15s',
          display: 'inline-block',
        }}>
          &#9660;
        </span>
      </button>
      {expanded && (
        <div style={{
          padding: '6px 14px',
          borderBottom: '1px solid var(--border)',
          fontSize: 10,
          color: 'var(--fg-muted)',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          
        }}>
          <span>{session.workingDirectory}</span>
          <div style={{ display: 'flex', gap: 16 }}>
            <span>Started {started}</span>
            <span>Last activity {lastActivity}</span>
            <span>Phase: {session.phase}</span>
          </div>
        </div>
      )}
    </div>
  )
}
