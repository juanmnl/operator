import type { AgentSession } from '../../../shared/types'

interface ActivityDashboardProps {
  sessions: AgentSession[]
  customNames: Record<string, string>
  onSelectSession: (s: AgentSession) => void
  onNewSession: () => void
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function phaseColor(phase: string): string {
  switch (phase) {
    case 'running': return 'var(--color-success)'
    case 'compacting': return 'var(--cyan)'
    default: return 'var(--fg-muted)'
  }
}

export function ActivityDashboard({ sessions, customNames, onSelectSession, onNewSession }: ActivityDashboardProps) {
  const active = sessions.filter((s) => s.status === 'active')

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px 10px', flexShrink: 0,
      }}>
        <div>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
            {active.length} active session{active.length === 1 ? '' : 's'}
          </h2>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '2px 0 0', opacity: 0.6 }}>
            Live view of what your agents are doing.
          </p>
        </div>
        <button
          onClick={onNewSession}
          style={{
            padding: '6px 14px', fontSize: 11, fontWeight: 500,
            background: 'var(--btn-bg)', border: '1px solid var(--border)',
            borderRadius: 5, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer',
          }}
        >
          + New Session
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
        {active.map((session) => {
          const label = customNames[session.id] || session.summary || session.projectName || 'Session'
          const lastActivity = session.activity?.length
            ? session.activity[session.activity.length - 1]
            : null
          const isRunning = session.phase === 'running'

          return (
            <button
              key={session.id}
              onClick={() => onSelectSession(session)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', padding: '10px 12px',
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 8, marginBottom: 6,
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: phaseColor(session.phase),
                opacity: session.phase === 'idle' ? 0.4 : 1,
                animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : undefined,
                flexShrink: 0,
              }} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>
                    {label}
                  </span>
                  {session.activeSubagents > 0 && (
                    <span style={{
                      fontSize: 9, color: 'var(--fg-muted)', background: 'var(--bg-surface)',
                      borderRadius: 8, padding: '1px 6px',
                    }}>
                      {session.activeSubagents} sub
                    </span>
                  )}
                </div>
                <div style={{
                  fontSize: 10, color: 'var(--fg-muted)', marginTop: 2,
                  display: 'flex', gap: 8, alignItems: 'baseline',
                  fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                  overflow: 'hidden',
                }}>
                  {lastActivity ? (
                    <>
                      <span style={{ color: 'var(--fg)', opacity: 0.7, flexShrink: 0 }}>{lastActivity.toolName}</span>
                      {lastActivity.target && (
                        <span style={{
                          opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap', minWidth: 0,
                        }}>
                          {lastActivity.target}
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ opacity: 0.5 }}>{session.workingDirectory}</span>
                  )}
                </div>
              </div>

              <span style={{
                fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5,
                flexShrink: 0, width: 70, textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {relativeTime(session.lastActivityAt)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
