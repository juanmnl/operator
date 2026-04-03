import { useEffect, useRef } from 'react'
import { AgentSession, OperatorRequest } from '../../../shared/types'

interface Props {
  session: AgentSession
  pendingRequests: OperatorRequest[]
}

export function SessionActivityView({ session, pendingRequests }: Props) {
  const timelineRef = useRef<HTMLDivElement>(null)
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
      {/* Header */}
      <div style={{ padding: '0 20px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <StatusDot phase={session.phase} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>{session.projectName}</span>
          {session.activeSubagents > 0 && (
            <span style={{ fontSize: 10, color: 'var(--fg-muted)', background: 'var(--bg-surface)', borderRadius: 8, padding: '1px 6px' }}>
              {session.activeSubagents} subagent{session.activeSubagents > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', gap: 16 }}>
          <span>{session.workingDirectory}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 4, display: 'flex', gap: 16 }}>
          <span>Started {started}</span>
          <span>Last activity {lastActivity}</span>
          {session.lastToolName && <span>Tool: {session.lastToolName}</span>}
        </div>
      </div>

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
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', textAlign: 'center', marginTop: 40 }}>
            Waiting for activity...
          </p>
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
