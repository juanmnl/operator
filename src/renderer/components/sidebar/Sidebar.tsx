import { useState } from 'react'
import { AgentSession } from '../../../shared/types'
import { SessionItem } from './SessionItem'
import { LogoMark } from '../LogoMark'
import { DragRegion } from '../DragRegion'

interface SidebarProps {
  sessions: AgentSession[]
  activeSessionId: string | null
  customNames: Record<string, string>
  activeFolderPrefs: string | null
  globalPrefsActive: boolean
  agentsViewActive: boolean
  usageViewActive: boolean
  prefsViewActive: boolean
  effortLevels: Record<string, string>
  /** Map terminalId → fan-out position for the per-agent badge. */
  fanInfo: Record<string, { index: number; total: number }>
  /** Map sessionId → 1-based Cmd+N hint for the first 9 local sessions. */
  shortcutIndices: Record<string, number>
  /** Counts for the bottom status row. */
  stats: { activeSessions: number }
  isDark: boolean
  onShowDashboard: () => void
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
  onCloseSession: (session: AgentSession) => void
  onReorderGroup: (draggedName: string, targetName: string, edge: 'before' | 'after') => void
  onNewSession: () => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
  onOpenGlobalPrefs: () => void
  onOpenAgents: () => void
  onOpenUsage: () => void
  onOpenPrefs: () => void
  onToggleTheme: () => void
  /** App version (e.g. "0.1.4"), shown next to the name. */
  version?: string
  /** A newer release found by the updater, or null. */
  update?: { version: string } | null
  onInstallUpdate?: () => void
  /** Collapse the sidebar (hide it). */
  onToggleCollapse?: () => void
}

export function Sidebar({ sessions, activeSessionId, customNames, activeFolderPrefs, globalPrefsActive, agentsViewActive, usageViewActive, prefsViewActive, effortLevels, fanInfo, shortcutIndices, stats, isDark, onShowDashboard, onSelectSession, onRenameSession, onCloseSession, onReorderGroup, onNewSession, onOpenFolderPrefs, onOpenGlobalPrefs, onOpenAgents, onOpenUsage, onOpenPrefs, onToggleTheme, version, update, onInstallUpdate, onToggleCollapse }: SidebarProps) {
  // Project name of the folder group currently being dragged for reorder — lifted
  // here so a drag can target any other group (each FolderGroup is a drop zone).
  const [dragGroup, setDragGroup] = useState<string | null>(null)
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
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter', system-ui, sans-serif",
        userSelect: 'none',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Header — also the window drag handle. DragRegion drives startDragging()
          on mousedown; the buttons below stay clickable (DragRegion ignores
          presses that land on interactive children). */}
      <DragRegion
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '16px 14px 12px 14px',
          paddingTop: 40,
        }}
      >
        <button
          onClick={onShowDashboard}
          title="Active sessions"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'none', border: 'none', padding: 0, margin: 0,
            cursor: 'pointer', fontFamily: 'inherit',
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
        >
          <LogoMark size={16} animated={false} />
          {/* Name + version share a baseline so the small version sits on the
              same line as "Operator" instead of floating mid-height. */}
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', letterSpacing: -0.3 }}>
              Operator
            </span>
            {version && (
              <span style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>
                v{version}
              </span>
            )}
          </span>
        </button>
        {update && (
          <button
            onClick={onInstallUpdate}
            title={`Update ${update.version} available — install & restart`}
            aria-label={`Install update ${update.version}`}
            style={{
              flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 16, height: 16, padding: 0,
              background: 'transparent', color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 999,
              cursor: 'pointer', outline: 'none',
              // @ts-expect-error Electron-specific CSS property
              WebkitAppRegion: 'no-drag',
            }}
          >
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9.5V2.5M3 5l3-3 3 3" />
            </svg>
          </button>
        )}
        {/* Collapse (hide) the sidebar. Right-aligned at the end of the header. */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            style={{
              marginLeft: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 22, padding: 0,
              background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-muted)', opacity: 0.85, cursor: 'pointer',
              transition: 'opacity 120ms ease, background 120ms ease',
              // @ts-expect-error Electron-specific CSS property
              WebkitAppRegion: 'no-drag',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'var(--overlay-subtle)' }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.85'; e.currentTarget.style.background = 'transparent' }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3.25" width="12" height="9.5" rx="1.6" />
              <line x1="6.25" y1="3.25" x2="6.25" y2="12.75" />
            </svg>
          </button>
        )}
      </DragRegion>

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
            activeFolderPrefs={activeFolderPrefs}
            effortLevels={effortLevels}
            fanInfo={fanInfo}
            shortcutIndices={shortcutIndices}
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onCloseSession={onCloseSession}
            onOpenFolderPrefs={onOpenFolderPrefs}
            dragGroup={dragGroup}
            setDragGroup={setDragGroup}
            onReorderGroup={onReorderGroup}
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
        opacity: 0.65,
        fontVariantNumeric: 'tabular-nums',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <span>{stats.activeSessions} active</span>
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
        {/* All footer icons share one 14px box (viewBox 16, stroke 1.1) and the
            same button padding; spacing comes from the row's `gap` alone, so they
            read as a single uniform set. The gear keeps viewBox 24 with a
            proportional stroke (1.6/24 ≈ 1.1/16). */}
        <button
          onClick={onNewSession}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8,
            display: 'flex', alignItems: 'center', opacity: 0.85,
          }}
          title="New Session"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="var(--fg-muted)" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
        </button>
        <button
          onClick={onOpenAgents}
          style={{
            background: agentsViewActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8,
            display: 'flex', alignItems: 'center',
            opacity: agentsViewActive ? 1 : 0.85,
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
            border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8,
            display: 'flex', alignItems: 'center',
            opacity: usageViewActive ? 1 : 0.85,
          }}
          title="Usage & cost"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
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
            border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8,
            display: 'flex', alignItems: 'center',
            opacity: globalPrefsActive ? 1 : 0.85,
          }}
          title="Global Claude files (~/.claude)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="var(--fg-muted)" strokeWidth="1.1" />
            <ellipse cx="8" cy="8" rx="2.5" ry="6" stroke="var(--fg-muted)" strokeWidth="1.1" />
            <path d="M2 8h12" stroke="var(--fg-muted)" strokeWidth="1.1" />
          </svg>
        </button>
        {/* Settings (Operator preferences) — sits in the bottom row, just before the theme toggle. */}
        <button
          onClick={onOpenPrefs}
          title="Operator preferences"
          style={{
            background: prefsViewActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8,
            display: 'flex', alignItems: 'center',
            opacity: prefsViewActive ? 1 : 0.85,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {/* Theme toggle — last icon in the bottom row, after settings. */}
        <button
          onClick={onToggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8,
            display: 'flex', alignItems: 'center', opacity: 0.85,
          }}
        >
          {isDark ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              {/* Filled core so the sun reads distinct from the (hollow-centred) gear beside it. */}
              <circle cx="8" cy="8" r="2.6" fill="var(--fg-muted)" />
              <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.7 3.7l1 1M11.3 11.3l1 1M3.7 12.3l1-1M11.3 4.7l1-1" stroke="var(--fg-muted)" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 9.5a5.5 5.5 0 0 1-7-7A5.5 5.5 0 1 0 13.5 9.5Z" stroke="var(--fg-muted)" strokeWidth="1.1" />
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
  customNames,
  activeFolderPrefs,
  effortLevels,
  fanInfo,
  shortcutIndices,
  onSelectSession,
  onRenameSession,
  onCloseSession,
  onOpenFolderPrefs,
  dragGroup,
  setDragGroup,
  onReorderGroup,
}: {
  projectName: string
  group: AgentSession[]
  activeSessionId: string | null
  customNames: Record<string, string>
  activeFolderPrefs: string | null
  effortLevels: Record<string, string>
  fanInfo: Record<string, { index: number; total: number }>
  shortcutIndices: Record<string, number>
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
  onCloseSession: (session: AgentSession) => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
  dragGroup: string | null
  setDragGroup: (name: string | null) => void
  onReorderGroup: (draggedName: string, targetName: string, edge: 'before' | 'after') => void
}) {
  const [hovered, setHovered] = useState(false)
  // Which edge of THIS group the dragged group is hovering — drives the drop line.
  const [dropEdge, setDropEdge] = useState<'before' | 'after' | null>(null)
  const projectPath = group[0]?.workingDirectory || ''
  const isPrefsActive = activeFolderPrefs === projectPath
  const isDragging = dragGroup === projectName

  return (
    // The whole project (title + its sessions) is one draggable/droppable unit. The
    // group title is the drag handle; while dragging, its sessions collapse so you
    // move a compact title; other groups show a before/after drop line.
    <div
      key={projectName}
      onDragOver={(e) => {
        if (!dragGroup || dragGroup === projectName) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        setDropEdge(e.clientY - r.top < r.height / 2 ? 'before' : 'after')
      }}
      onDragLeave={(e) => {
        // Ignore leaves into child elements (relatedTarget still inside).
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropEdge(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (dragGroup && dragGroup !== projectName && dropEdge) onReorderGroup(dragGroup, projectName, dropEdge)
        setDropEdge(null)
      }}
      style={{
        marginBottom: 8,
        opacity: isDragging ? 0.5 : 1,
        // 2px transparent borders by default so the accent drop line doesn't shift
        // layout. No border-radius — the drop line must read as a crisp straight rule.
        borderTop: `2px solid ${dropEdge === 'before' ? 'var(--accent)' : 'transparent'}`,
        borderBottom: `2px solid ${dropEdge === 'after' ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <div
        draggable
        onDragStart={(e) => {
          setDragGroup(projectName)
          e.dataTransfer.effectAllowed = 'move'
          // Custom drag ghost so you SEE the grabbed project follow the cursor — a
          // floating chip with the name + session count (instead of the faint default
          // snapshot of the title row). Off-screen until the browser captures it.
          const ghost = document.createElement('div')
          ghost.textContent = group.length > 1 ? `${projectName} · ${group.length}` : projectName
          ghost.style.cssText = [
            'position:absolute', 'top:-1000px', 'left:-1000px', 'pointer-events:none',
            'padding:6px 12px', 'border-radius:8px',
            'background:var(--bg-surface)', 'color:var(--fg)', 'border:1px solid var(--accent)',
            "font:600 10px/1 'Inter',system-ui,sans-serif", 'text-transform:uppercase', 'letter-spacing:0.5px',
            'box-shadow:0 8px 24px rgba(0,0,0,0.4)', 'white-space:nowrap',
          ].join(';')
          document.body.appendChild(ghost)
          e.dataTransfer.setDragImage(ghost, 14, 16)
          // Remove once the browser has snapshotted it for the drag.
          setTimeout(() => ghost.remove(), 0)
        }}
        onDragEnd={() => { setDragGroup(null); setDropEdge(null) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--fg-muted)',
          // Left-align with the session rows' dot column (their left padding) so the
          // group label and its rows share one consistent left edge.
          padding: '4px 12px 4px 10px',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'grab',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{projectName}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onOpenFolderPrefs(projectPath, projectName)
          }}
          // Don't start a group drag from the prefs button.
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{
            background: isPrefsActive ? 'rgba(255,255,255,0.08)' : 'none',
            border: 'none',
            padding: '2px 4px',
            borderRadius: 8,
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
      {/* Sessions collapse (hide) while this group is being dragged. */}
      {!isDragging && group.map((session, i) => {
        const customName = customNames[session.id]
        const autoName = group.length > 1 ? `Session ${i + 1}` : 'Session'
        // Prefer the agent-derived summary (first user prompt) when no custom name is set.
        const defaultLabel = session.summary || autoName
        // Get effort level from terminal tab (keyed by terminalId)
        const effort = session.terminalId ? effortLevels[session.terminalId] : null
        const fan = session.terminalId ? fanInfo[session.terminalId] : undefined
        return (
          <SessionItem
            key={session.id}
            session={session}
            label={customName || defaultLabel}
            active={session.id === activeSessionId}
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
