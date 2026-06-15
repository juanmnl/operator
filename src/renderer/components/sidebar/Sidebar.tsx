import { useState } from 'react'
import { AgentSession, OperatorRequest } from '../../../shared/types'
import { SessionItem } from './SessionItem'
import logoUrl from '../../../../assets/logo-light-64.png'

interface SidebarProps {
  sessions: AgentSession[]
  activeSessionId: string | null
  customNames: Record<string, string>
  pendingRequests: OperatorRequest[]
  activeFolderPrefs: string | null
  globalPrefsActive: boolean
  rulesViewActive: boolean
  agentsViewActive: boolean
  usageViewActive: boolean
  prefsViewActive: boolean
  effortLevels: Record<string, string>
  /** Map terminalId → fan-out position for the per-agent badge. */
  fanInfo: Record<string, { index: number; total: number }>
  /** Map sessionId → 1-based Cmd+N hint for the first 9 local sessions. */
  shortcutIndices: Record<string, number>
  /** Counts for the bottom status row. */
  stats: { activeSessions: number; pendingRequests: number }
  isDark: boolean
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
  onCloseSession: (session: AgentSession) => void
  onNewSession: () => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
  onOpenGlobalPrefs: () => void
  onOpenRules: () => void
  onOpenAgents: () => void
  onOpenUsage: () => void
  onOpenPrefs: () => void
  onToggleTheme: () => void
}

export function Sidebar({ sessions, activeSessionId, customNames, pendingRequests, activeFolderPrefs, globalPrefsActive, rulesViewActive, agentsViewActive, usageViewActive, prefsViewActive, effortLevels, fanInfo, shortcutIndices, stats, isDark, onSelectSession, onRenameSession, onCloseSession, onNewSession, onOpenFolderPrefs, onOpenGlobalPrefs, onOpenRules, onOpenAgents, onOpenUsage, onOpenPrefs, onToggleTheme }: SidebarProps) {
  // Group sessions by project name (last folder segment)
  const grouped = new Map<string, AgentSession[]>()
  for (const session of sessions) {
    const key = session.projectName || 'Unknown'
    const existing = grouped.get(key)
    if (existing) {
      existing.push(session)
    } else {
      grouped.set(key, [session])
    }
  }

  return (
    <div
      style={{
        width: 220,
        minWidth: 180,
        height: '100%',
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter', system-ui, sans-serif",
        userSelect: 'none',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '16px 14px 12px 14px',
          paddingTop: 40,
        }}
      >
        <img src={logoUrl} width={20} height={20} alt="" style={{ filter: isDark ? 'none' : 'invert(1)' }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', letterSpacing: -0.3 }}>
          Operator
        </span>
        <button
          onClick={onToggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            marginLeft: 'auto',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            display: 'flex', alignItems: 'center', opacity: 0.4,
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
        >
          {isDark ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3.5" stroke="var(--fg-muted)" strokeWidth="1.2" />
              <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.76 3.76l1.06 1.06M11.18 11.18l1.06 1.06M3.76 12.24l1.06-1.06M11.18 4.82l1.06-1.06" stroke="var(--fg-muted)" strokeWidth="1" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 9.5a5.5 5.5 0 0 1-7-7A5.5 5.5 0 1 0 13.5 9.5Z" stroke="var(--fg-muted)" strokeWidth="1.2" />
            </svg>
          )}
        </button>
      </div>

      {/* Sessions list */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '4px 6px',
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        {sessions.length === 0 && (
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', padding: '8px 12px' }}>
            No active sessions
          </p>
        )}
        {Array.from(grouped.entries()).map(([projectName, group]) => (
          <FolderGroup
            key={projectName}
            projectName={projectName}
            group={group}
            activeSessionId={activeSessionId}
            customNames={customNames}
            pendingRequests={pendingRequests}
            activeFolderPrefs={activeFolderPrefs}
            effortLevels={effortLevels}
            fanInfo={fanInfo}
            shortcutIndices={shortcutIndices}
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onCloseSession={onCloseSession}
            onOpenFolderPrefs={onOpenFolderPrefs}
          />
        ))}
      </div>

      {/* Stats row — at-a-glance counts */}
      <div style={{
        padding: '4px 14px 0',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 10,
        color: 'var(--fg-muted)',
        opacity: 0.5,
        fontVariantNumeric: 'tabular-nums',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <span>{stats.activeSessions} active</span>
        {stats.pendingRequests > 0 && (
          <span style={{ color: 'var(--color-warning)', opacity: 1 }}>
            {stats.pendingRequests} pending
          </span>
        )}
      </div>

      {/* Bottom bar */}
      <div style={{
        padding: '6px 14px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <button
          onClick={onNewSession}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--fg-muted)',
            fontSize: 16,
            fontWeight: 300,
            fontFamily: 'inherit',
            cursor: 'pointer',
            padding: 0,
            lineHeight: 1,
            opacity: 0.5,
          }}
          title="New Session"
        >
          +
        </button>
        <button
          onClick={onOpenAgents}
          style={{
            background: agentsViewActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '3px 5px',
            borderRadius: 3,
            display: 'flex',
            alignItems: 'center',
            opacity: agentsViewActive ? 0.9 : 0.5,
            marginLeft: 6,
          }}
          title="Agents — configure models per task"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="5.5" width="10" height="7.5" rx="2" stroke="var(--fg-muted)" strokeWidth="1.1" />
            <path d="M8 3v2.5" stroke="var(--fg-muted)" strokeWidth="1.1" strokeLinecap="round" />
            <circle cx="8" cy="2.5" r="1" fill="var(--fg-muted)" />
            <circle cx="6" cy="9" r="0.9" fill="var(--fg-muted)" />
            <circle cx="10" cy="9" r="0.9" fill="var(--fg-muted)" />
          </svg>
        </button>
        <button
          onClick={onOpenUsage}
          style={{
            background: usageViewActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '3px 5px',
            borderRadius: 3,
            display: 'flex',
            alignItems: 'center',
            opacity: usageViewActive ? 0.9 : 0.5,
            marginLeft: 4,
          }}
          title="Usage & cost"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M2 14V2" stroke="var(--fg-muted)" strokeWidth="1.1" strokeLinecap="round" />
            <path d="M2 14h12" stroke="var(--fg-muted)" strokeWidth="1.1" strokeLinecap="round" />
            <rect x="4.5" y="8" width="2.2" height="4" rx="0.5" fill="var(--fg-muted)" />
            <rect x="8" y="5" width="2.2" height="7" rx="0.5" fill="var(--fg-muted)" />
            <rect x="11.5" y="9.5" width="2.2" height="2.5" rx="0.5" fill="var(--fg-muted)" />
          </svg>
        </button>
        <button
          onClick={onOpenGlobalPrefs}
          style={{
            background: globalPrefsActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '3px 5px',
            borderRadius: 3,
            display: 'flex',
            alignItems: 'center',
            opacity: globalPrefsActive ? 0.9 : 0.5,
            marginLeft: 6,
          }}
          title="Global Claude files (~/.claude)"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="var(--fg-muted)" strokeWidth="1.1" />
            <ellipse cx="8" cy="8" rx="2.5" ry="6" stroke="var(--fg-muted)" strokeWidth="1.1" />
            <path d="M2 8h12" stroke="var(--fg-muted)" strokeWidth="1.1" />
          </svg>
        </button>
        <button
          onClick={onOpenRules}
          style={{
            background: rulesViewActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '3px 5px',
            borderRadius: 3,
            display: 'flex',
            alignItems: 'center',
            opacity: rulesViewActive ? 0.9 : 0.5,
            marginLeft: 4,
          }}
          title="Auto-approve rules"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 4h6M3 8h10M3 12h6" stroke="var(--fg-muted)" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="12" cy="4" r="1.6" fill="var(--fg-muted)" />
          </svg>
        </button>
        <button
          onClick={onOpenPrefs}
          style={{
            background: prefsViewActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '3px 5px',
            borderRadius: 3,
            display: 'flex',
            alignItems: 'center',
            opacity: prefsViewActive ? 0.9 : 0.5,
            marginLeft: 4,
          }}
          title="Operator preferences"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function FolderGroup({
  projectName,
  group,
  activeSessionId,
  customNames,
  pendingRequests,
  activeFolderPrefs,
  effortLevels,
  fanInfo,
  shortcutIndices,
  onSelectSession,
  onRenameSession,
  onCloseSession,
  onOpenFolderPrefs,
}: {
  projectName: string
  group: AgentSession[]
  activeSessionId: string | null
  customNames: Record<string, string>
  pendingRequests: OperatorRequest[]
  activeFolderPrefs: string | null
  effortLevels: Record<string, string>
  fanInfo: Record<string, { index: number; total: number }>
  shortcutIndices: Record<string, number>
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
  onCloseSession: (session: AgentSession) => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const projectPath = group[0]?.workingDirectory || ''
  const isPrefsActive = activeFolderPrefs === projectPath

  return (
    <div key={projectName} style={{ marginBottom: 8 }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--fg-muted)',
          padding: '4px 12px',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{projectName}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onOpenFolderPrefs(projectPath, projectName)
          }}
          style={{
            background: isPrefsActive ? 'rgba(255,255,255,0.08)' : 'none',
            border: 'none',
            padding: '2px 4px',
            borderRadius: 3,
            cursor: 'pointer',
            opacity: hovered || isPrefsActive ? 0.8 : 0,
            transition: 'opacity 0.15s',
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ display: 'block' }}>
            <circle cx="5" cy="2" r="1" fill="var(--fg-muted)" />
            <circle cx="5" cy="5" r="1" fill="var(--fg-muted)" />
            <circle cx="5" cy="8" r="1" fill="var(--fg-muted)" />
          </svg>
        </button>
      </div>
      {group.map((session, i) => {
        const customName = customNames[session.id]
        const autoName = group.length > 1 ? `Session ${i + 1}` : 'Session'
        // Prefer the agent-derived summary (first user prompt) when no custom name is set.
        const defaultLabel = session.summary || autoName
        const hasPending = pendingRequests.some(
          (r) => r.terminalId === session.terminalId || r.sessionId === session.id
        )
        // Get effort level from terminal tab (keyed by terminalId)
        const effort = session.terminalId ? effortLevels[session.terminalId] : null
        const fan = session.terminalId ? fanInfo[session.terminalId] : undefined
        return (
          <SessionItem
            key={session.id}
            session={session}
            label={customName || defaultLabel}
            active={session.id === activeSessionId}
            hasPending={hasPending}
            effortLevel={effort}
            fanInfo={fan}
            closable
            shortcutIndex={shortcutIndices[session.id] ?? null}
            onClick={() => onSelectSession(session)}
            onRename={(name) => onRenameSession(session.id, name)}
            onClose={() => onCloseSession(session)}
          />
        )
      })}
    </div>
  )
}
