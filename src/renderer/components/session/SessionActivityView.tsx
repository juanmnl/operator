import { useEffect, useRef, useState } from 'react'
import { AgentSession, OperatorRequest } from '../../../shared/types'

interface Props {
  session: AgentSession
  pendingRequests: OperatorRequest[]
}

export function SessionActivityView({ session, pendingRequests }: Props) {
  const timelineRef = useRef<HTMLDivElement>(null)
  const [showDetails, setShowDetails] = useState(false)
  const activity = session.activity || []

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight
    }
  }, [activity.length])

  const started = new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const lastActivity = new Date(session.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter', system-ui, sans-serif",
        color: 'var(--fg)',
        minHeight: 0,
      }}
    >
      {/* Compact header — click to expand details */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 20px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          background: 'none',
          border: 'none',
          borderBottomStyle: 'solid',
          borderBottomWidth: 1,
          borderBottomColor: 'var(--border)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <StatusDot phase={session.phase} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>{session.projectName}</span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5 }}>
          {started}
        </span>
        {session.lastToolName && (
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5 }}>
            — {session.lastToolName}
          </span>
        )}
        {session.activeSubagents > 0 && (
          <span style={{ fontSize: 9, color: 'var(--fg-muted)', background: 'var(--bg-surface)', borderRadius: 8, padding: '1px 6px' }}>
            {session.activeSubagents} sub
          </span>
        )}
        <span style={{
          marginLeft: 'auto',
          fontSize: 7,
          color: 'var(--fg-muted)',
          opacity: 0.3,
          transform: showDetails ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.15s',
          display: 'inline-block',
        }}>
          &#9660;
        </span>
      </button>

      {/* Expandable details */}
      {showDetails && (
        <div style={{
          padding: '8px 20px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
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
          </div>
        </div>
      )}

      {/* Activity timeline */}
      <div
        ref={timelineRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {activity.length === 0 && pendingRequests.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 40 }}>
            <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              No activity recorded yet
            </p>
            <p style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5, marginTop: 8, lineHeight: 1.6 }}>
              This session was likely started before Operator launched.<br />
              Restart the Claude Code process to enable activity tracking.
            </p>
          </div>
        )}
        {activity.map((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '4px 8px',
                borderRadius: 4,
                background: entry.status === 'pending' ? 'rgba(234, 179, 8, 0.08)' : 'transparent',
                fontSize: 12,
              }}
            >
              <span style={{ fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0, width: 56, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
              <span style={{ fontWeight: 500, flexShrink: 0 }}>{entry.toolName}</span>
              {entry.target && (
                <span style={{ color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                  {entry.target}
                </span>
              )}
              <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: statusColor(entry.status) }}>
                {entry.status === 'auto' ? '' : entry.status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusDot({ phase }: { phase: string }) {
  const isRunning = phase === 'running'
  const isCompacting = phase === 'compacting'
  const color = isRunning ? 'var(--green)' : isCompacting ? 'var(--cyan)' : 'var(--fg-muted)'
  return (
    <span style={{
      width: 7, height: 7, borderRadius: '50%',
      background: 'transparent', border: `1.5px solid ${color}`,
      boxSizing: 'border-box',
      flexShrink: 0,
      animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : undefined,
    }} />
  )
}

function statusColor(status: string): string {
  switch (status) {
    case 'approved': return 'var(--green)'
    case 'denied': return 'var(--red)'
    case 'pending': return 'var(--yellow)'
    default: return 'var(--fg-muted)'
  }
}
