import { useState } from 'react'
import { AgentSession, OperatorRequest } from '../../../shared/types'
import { SessionItem } from './SessionItem'
import logoUrl from '../../../../assets/logo-light-64.png'

const TERM_NAMES: Record<string, string> = {
  'iTerm.app': 'iTerm',
  'Apple_Terminal': 'Terminal',
  'vscode': 'VS Code',
  'WarpTerminal': 'Warp',
  'Hyper': 'Hyper',
  'Alacritty': 'Alacritty',
  'tmux': 'tmux',
  'ghostty': 'Ghostty',
}

function formatTermProgram(raw: string): string {
  return TERM_NAMES[raw] || raw.replace(/\.app$/, '')
}

interface SidebarProps {
  sessions: AgentSession[]
  activeSessionId: string | null
  localTerminalIds: Set<string>
  customNames: Record<string, string>
  pendingRequests: OperatorRequest[]
  activeFolderPrefs: string | null
  effortLevels: Record<string, string>
  isDark: boolean
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
  onNewSession: () => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
  onToggleTheme: () => void
}

export function Sidebar({ sessions, activeSessionId, localTerminalIds, customNames, pendingRequests, activeFolderPrefs, effortLevels, isDark, onSelectSession, onRenameSession, onNewSession, onOpenFolderPrefs, onToggleTheme  }: SidebarProps) {
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
            localTerminalIds={localTerminalIds}
            customNames={customNames}
            pendingRequests={pendingRequests}
            activeFolderPrefs={activeFolderPrefs}
            effortLevels={effortLevels}
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onOpenFolderPrefs={onOpenFolderPrefs}
          />
        ))}
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
        <div style={{ flex: 1 }} />
        <button
          onClick={onToggleTheme}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            opacity: 0.4,
          }}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
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
    </div>
  )
}

function FolderGroup({
  projectName,
  group,
  activeSessionId,
  localTerminalIds,
  customNames,
  pendingRequests,
  activeFolderPrefs,
  effortLevels,
  onSelectSession,
  onRenameSession,
  onOpenFolderPrefs,
}: {
  projectName: string
  group: AgentSession[]
  activeSessionId: string | null
  localTerminalIds: Set<string>
  customNames: Record<string, string>
  pendingRequests: OperatorRequest[]
  activeFolderPrefs: string | null
  effortLevels: Record<string, string>
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
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
        const isExternal = !session.terminalId || !localTerminalIds.has(session.terminalId)
        const autoName = isExternal
          ? (session.termProgram ? formatTermProgram(session.termProgram) : 'External')
          : (group.length > 1 ? `Session ${i + 1}` : 'Session')
        const defaultLabel = autoName
        const hasPending = pendingRequests.some(
          (r) => r.terminalId === session.terminalId || r.sessionId === session.id
        )
        // Get effort level from terminal tab (keyed by terminalId)
        const effort = session.terminalId ? effortLevels[session.terminalId] : null
        return (
          <SessionItem
            key={session.id}
            session={session}
            label={customName || defaultLabel}
            active={session.id === activeSessionId}
            hasPending={hasPending}
            isExternal={isExternal}
            effortLevel={effort}
            onClick={() => onSelectSession(session)}
            onRename={(name) => onRenameSession(session.id, name)}
          />
        )
      })}
    </div>
  )
}
