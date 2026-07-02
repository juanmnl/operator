import type { AgentSession } from '../../../shared/types'
import { StatusWave } from '../sidebar/StatusWave'
import { RecentLists, type RecentSession, type RecentProject } from './RecentLists'
import { relativeTime } from '../../lib/format'
import { sessionWaveStatus } from '../../lib/session-status'

interface ActivityDashboardProps {
  sessions: AgentSession[]
  customNames: Record<string, string>
  onSelectSession: (s: AgentSession) => void
  onNewSession: () => void
  // Continuity shelf — shown below the active list so an all-ended workspace
  // still offers a way back in.
  restorableSessions: RecentSession[]
  recentProjects: RecentProject[]
  onRestore: (s: RecentSession, resume: boolean) => void
  onForget: (key: string) => void
  onOpenFolder: (path: string) => void
}

export function ActivityDashboard({
  sessions, customNames, onSelectSession, onNewSession,
  restorableSessions, recentProjects, onRestore, onForget, onOpenFolder,
}: ActivityDashboardProps) {
  const active = sessions.filter((s) => s.status === 'active')

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      fontFamily: "var(--font-body)",
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px 10px', flexShrink: 0,
      }}>
        <div>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
            {active.length > 0
              ? `${active.length} agent${active.length === 1 ? '' : 's'} at work`
              : 'All quiet for now'}
          </h2>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '2px 0 0', opacity: 0.6 }}>
            {active.length > 0
              ? "Here's what they're up to right now."
              : 'Pick up a session below, or start something new.'}
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
              <StatusWave status={sessionWaveStatus(session)} size={15} seed={session.id} />

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
                {relativeTime(session.lastActivityAt, { subMinuteSeconds: true })}
              </span>
            </button>
          )
        })}

        <div style={{ width: '100%' }}>
          <RecentLists
            sessions={restorableSessions}
            projects={recentProjects}
            onRestore={onRestore}
            onForget={onForget}
            onOpenFolder={onOpenFolder}
          />
        </div>
      </div>
    </div>
  )
}
