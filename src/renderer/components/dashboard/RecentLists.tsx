// The "pick up where you left off" shelf — saved sessions you can resume and
// folders you've worked in recently. Shared by the empty splash and the activity
// dashboard so continuity is reachable from both (an all-ended workspace is no
// longer a dead end).

import { relativeTime } from '../../lib/format'

export interface RecentSession {
  key: string
  cwd: string
  projectName: string
  customName?: string
  worktreeBranch?: string
  /** Present when the previous Claude conversation can be resumed. */
  claudeSessionId?: string
  lastActiveAt: string
}

export interface RecentProject {
  path: string
  name: string
  lastUsedAt: string
}

const sectionLabel: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--fg-muted)', opacity: 0.5,
  margin: '0 0 8px', textAlign: 'left',
}

function restoreBtnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '3px 9px', fontSize: 10, fontWeight: 500, fontFamily: 'inherit',
    background: primary ? 'var(--btn-bg)' : 'transparent',
    color: primary ? 'var(--fg)' : 'var(--fg-muted)',
    border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', flexShrink: 0,
  }
}

const mono = "'SF Mono', 'Fira Code', Menlo, monospace"

export function RecentLists({ sessions, projects, onRestore, onForget, onOpenFolder, maxSessions = 6, maxProjects = 5 }: {
  sessions: RecentSession[]
  projects: RecentProject[]
  onRestore: (s: RecentSession, resume: boolean) => void
  onForget: (key: string) => void
  onOpenFolder: (path: string) => void
  maxSessions?: number
  maxProjects?: number
}) {
  if (sessions.length === 0 && projects.length === 0) return null

  return (
    <>
      {sessions.length > 0 && (
        <div style={{ width: '100%', marginTop: 24 }}>
          {/* Clear, parallel labels: a *session* resumes work; a *folder* starts fresh. */}
          <p style={sectionLabel}>Pick up a session</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sessions.slice(0, maxSessions).map((s) => (
              <div
                key={s.key}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '6px 6px 6px 10px',
                  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 5,
                }}
              >
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontSize: 11, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.customName || s.projectName}
                  </div>
                  <div style={{
                    fontSize: 9, color: 'var(--fg-muted)', opacity: 0.55, marginTop: 1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: mono,
                  }}>
                    {(s.worktreeBranch ? `⎇ ${s.worktreeBranch}` : s.cwd.replace(/^\/Users\/[^/]+/, '~'))}
                    {' · '}{relativeTime(s.lastActiveAt)}
                  </div>
                </div>
                {s.claudeSessionId && (
                  <button onClick={() => onRestore(s, true)} title="Resume the previous Claude conversation" style={restoreBtnStyle(true)}>
                    Resume
                  </button>
                )}
                <button
                  onClick={() => onRestore(s, false)}
                  title={s.claudeSessionId ? 'Start the agent fresh in this session' : 'Open this session'}
                  style={restoreBtnStyle(false)}
                >
                  {s.claudeSessionId ? 'Start fresh' : 'Open'}
                </button>
                <button
                  onClick={() => onForget(s.key)}
                  title="Forget this session"
                  style={{ background: 'none', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', fontSize: 13, padding: '0 4px', opacity: 0.4, fontFamily: 'inherit' }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <div style={{ width: '100%', marginTop: 24 }}>
          <p style={sectionLabel}>Start in a recent folder</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {projects.slice(0, maxProjects).map((p) => (
              <button
                key={p.path}
                onClick={() => onOpenFolder(p.path)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
                  background: 'transparent', border: '1px solid var(--border)', borderRadius: 5,
                  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--fg)', flexShrink: 0 }}>{p.name}</span>
                <span style={{
                  fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontFamily: mono,
                }}>
                  {p.path.replace(/^\/Users\/[^/]+/, '~')}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
