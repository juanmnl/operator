import { useState } from 'react'
import { AgentSession, OperatorRequest } from '../../../shared/types'
import { SessionItem } from './SessionItem'
import logoUrl from '../../../../assets/logo-light-64.png'

interface SidebarProps {
  sessions: AgentSession[]
  activeSessionId: string | null
  localTerminalIds: Set<string>
  customNames: Record<string, string>
  pendingRequests: OperatorRequest[]
  activeFolderPrefs: string | null
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
  onNewSession: () => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
}

export function Sidebar({ sessions, activeSessionId, localTerminalIds, customNames, pendingRequests, activeFolderPrefs, onSelectSession, onRenameSession, onNewSession, onOpenFolderPrefs }: SidebarProps) {
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
        <img src={logoUrl} width={20} height={20} alt="" />
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
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onOpenFolderPrefs={onOpenFolderPrefs}
          />
        ))}
      </div>

      {/* New Session button */}
      <div style={{ padding: '8px 10px',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <button
          onClick={onNewSession}
          style={{
            width: '100%',
            padding: '7px 0',
            background: '#1C1C24',
            border: '1px solid rgba(0,0,0,0.4)',
            borderRadius: 6,
            color: 'var(--fg)',
            fontSize: 12,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          + New Session
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
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
            <path
              d="M6.5 1.75a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0ZM6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0ZM8 14.25a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"
              fill="var(--fg-muted)"
            />
          </svg>
        </button>
      </div>
      {group.map((session, i) => {
        const customName = customNames[session.id]
        const isExternal = !session.terminalId || !localTerminalIds.has(session.terminalId)
        const defaultLabel = group.length > 1 ? `Session ${i + 1}` : 'Session'
        const hasPending = pendingRequests.some(
          (r) => r.terminalId === session.terminalId || r.sessionId === session.id
        )
        return (
          <SessionItem
            key={session.id}
            session={session}
            label={customName || defaultLabel}
            active={session.id === activeSessionId}
            hasPending={hasPending}
            isExternal={isExternal}
            onClick={() => onSelectSession(session)}
            onRename={(name) => onRenameSession(session.id, name)}
          />
        )
      })}
    </div>
  )
}
