import { useState } from 'react'
import type { AgentSession } from '../../../shared/types'

interface SessionInfoBarProps {
  session: AgentSession
}

export function SessionInfoBar({ session }: SessionInfoBarProps) {
  const [expanded, setExpanded] = useState(false)
  const started = new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const lastActivity = new Date(session.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isRunning = session.phase === 'running'
  const isCompacting = session.phase === 'compacting'
  const dotColor = isRunning ? 'var(--green)' : isCompacting ? 'var(--cyan)' : 'var(--fg-muted)'

  return (
    <div style={{ flexShrink: 0, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '4px 14px',
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
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5 }}>
          {started}
        </span>
        {session.lastToolName && (
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5 }}>
            {session.lastToolName}
          </span>
        )}
        {session.activeSubagents > 0 && (
          <span style={{ fontSize: 9, color: 'var(--fg-muted)', background: 'var(--bg-surface)', borderRadius: 8, padding: '0px 5px' }}>
            {session.activeSubagents} sub
          </span>
        )}
        <span style={{
          marginLeft: 'auto',
          fontSize: 7,
          color: 'var(--fg-muted)',
          opacity: 0.3,
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
          opacity: 0.7,
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
