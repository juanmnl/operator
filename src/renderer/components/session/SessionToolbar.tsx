import { useEffect, useState } from 'react'
import type { McpServerInfo } from '../../../shared/types'
import { DragRegion } from '../DragRegion'

const TYPE_VARS: Record<string, string> = {
  stdio: 'var(--mcp-stdio)',
  http: 'var(--mcp-http)',
  cloud: 'var(--mcp-cloud)',
}

function typeColor(type?: string): string {
  return (type && TYPE_VARS[type]) || 'var(--fg-muted)'
}

interface SessionToolbarProps {
  projectPath: string
  projectName: string
  /** Terminal id of the active session — used to resolve its reserved dev port. */
  terminalId?: string | null
  /** Port sniffed from the session's actual dev-server banner; wins over the
   *  allocated port since the project often ignores OPERATOR_DEV_PORT. */
  detectedDevPort?: number
  effortLevel?: 'high' | 'normal' | 'low' | null
  permissionMode?: string | null
  lastToolName?: string | null
  branch?: string | null
  /** Main-view segmented toggle: Console (terminal) · Chat · Preview. */
  mainView?: 'terminal' | 'chat' | 'preview'
  onSelectMainView?: (v: 'terminal' | 'chat' | 'preview') => void
  /** Right side panel (Plan / Diff / Preview) open state + toggle. */
  panelOpen?: boolean
  onTogglePanel?: () => void
}

export function SessionToolbar({ projectPath, projectName, detectedDevPort, effortLevel: effortLevelProp, permissionMode, lastToolName, branch, mainView, onSelectMainView, panelOpen, onTogglePanel }: SessionToolbarProps) {
  const [effortLevel, setEffortLevel] = useState<string | null>(effortLevelProp ?? null)
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [mcpExpanded, setMcpExpanded] = useState(false)
  const mcpActive = !!(lastToolName && lastToolName.startsWith('mcp__'))

  useEffect(() => {
    // Only read from disk if no prop was provided
    if (!effortLevelProp) {
      window.operator.folderPrefsLoad(projectPath).then((prefs) => {
        let level: string | null = null
        for (const file of prefs.settingsFiles) {
          if (file.exists && file.settings.effortLevel) {
            level = file.settings.effortLevel
          }
        }
        setEffortLevel(level)
      })
    }

    // Load MCP servers
    window.operator.getMcpServers(projectPath).then((result) => {
      setMcpServers(result.servers)
    })
  }, [projectPath, effortLevelProp])

  // Keep in sync with prop changes
  useEffect(() => {
    if (effortLevelProp) setEffortLevel(effortLevelProp)
  }, [effortLevelProp])

  // A worktree's folder is named after its branch (operator-990540 ↔
  // operator/990540), so showing both the project name and the branch reads as
  // two near-identical labels. When the branch already covers the project name,
  // show only the branch.
  const norm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const branchCoversProject = !!branch && !!projectName && norm(branch).includes(norm(projectName))

  return (
    <div style={{ position: 'relative' }}>
      {/* Draggable title bar area */}
      <DragRegion style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 36,
        padding: '0 12px',
        boxSizing: 'border-box',
        flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        fontFamily: "var(--font-body)",
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          fontWeight: 500,
          color: 'var(--fg)',
          opacity: 0.82,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}>
          {!branchCoversProject && <span>{projectName}</span>}
          {branch && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '1px 6px',
              borderRadius: 3,
              background: 'var(--overlay-subtle)',
              color: 'var(--fg)',
              opacity: 0.8,
            }}>
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                <circle cx="5" cy="3.5" r="1.6" stroke="var(--fg-muted)" strokeWidth="1.1" />
                <circle cx="5" cy="12.5" r="1.6" stroke="var(--fg-muted)" strokeWidth="1.1" />
                <circle cx="11" cy="8" r="1.6" stroke="var(--fg-muted)" strokeWidth="1.1" />
                <path d="M5 5.2v5.6M6.4 8h3" stroke="var(--fg-muted)" strokeWidth="1.1" />
              </svg>
              {branch}
            </span>
          )}
        </span>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}>
          {/* Dev-server quick-open. Only shown once a dev server has actually been
              detected in this session's output — the reserved OPERATOR_DEV_PORT is
              meaningless until something serves on it, so we don't surface it. */}
          {detectedDevPort && (
            <button
              onClick={() => window.operator.openExternal(`http://localhost:${detectedDevPort}`)}
              title={`Open http://localhost:${detectedDevPort} in your browser`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                fontSize: 9,
                fontWeight: 500,
                fontFamily: 'inherit',
                background: 'transparent',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 3,
                cursor: 'pointer',
                lineHeight: '16px',
                opacity: 0.85,
              }}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                <path d="M9 3h4v4M13 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              localhost:{detectedDevPort}
            </button>
          )}

          {/* MCP indicator — dropdown anchors to THIS badge (relative wrapper) so it drops
              directly beneath it, not the toolbar's far-right edge (which now holds the
              Console/Chat/Preview segmented control). */}
          {mcpServers.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setMcpExpanded(!mcpExpanded)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 7px',
                  fontSize: 9,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: mcpExpanded ? 'var(--overlay-subtle)' : 'transparent',
                  color: 'var(--fg-muted)',
                  border: 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                  lineHeight: '16px',
                }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <circle cx="4" cy="8" r="2" fill={mcpActive ? typeColor(mcpServers[0]?.type) : 'var(--fg-muted)'} opacity={mcpActive ? 0.9 : 0.25} />
                  <circle cx="12" cy="8" r="2" fill={mcpActive ? typeColor(mcpServers[1]?.type || mcpServers[0]?.type) : 'var(--fg-muted)'} opacity={mcpActive ? 0.9 : 0.25} />
                  <path d="M6 8h4" stroke="var(--fg-muted)" strokeWidth="1" opacity="0.2" />
                </svg>
                {mcpServers.length} MCP
              </button>
              {mcpExpanded && <McpDropdown servers={mcpServers} onClose={() => setMcpExpanded(false)} />}
            </div>
          )}

          {/* Effort level badge */}
          {effortLevel && (
            <span
              style={{
                padding: '2px 8px',
                fontSize: 9,
                fontWeight: 500,
                fontFamily: 'inherit',
                textTransform: 'capitalize',
                background: 'transparent',
                color: 'var(--fg-muted)',
                borderRadius: 3,
                lineHeight: '16px',
              }}
            >
              {effortLevel}
            </span>
          )}

          {/* Permission mode badge */}
          {permissionMode && permissionMode !== 'default' && (
            <span
              style={{
                padding: '2px 8px',
                fontSize: 9,
                fontWeight: 500,
                fontFamily: 'inherit',
                background: 'transparent',
                color: permissionMode === 'bypassPermissions' ? 'var(--red)' : 'var(--yellow)',
                borderRadius: 3,
                lineHeight: '16px',
                opacity: 0.7,
              }}
            >
              {permissionMode === 'bypassPermissions' ? 'No Perms' : permissionMode}
            </span>
          )}

          {/* Main-view segmented toggle — Console (the raw Claude Code terminal) · Chat ·
              Preview. The chosen surface fills the main area (the terminal stays mounted
              underneath). Active segment: accent text on a subtle tint (no solid accent fill). */}
          {onSelectMainView && (
            <div style={{
              display: 'flex', alignItems: 'center', marginLeft: 4,
              border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
            }}>
              {([['terminal', 'Console'], ['chat', 'Chat'], ['preview', 'Preview']] as const).map(([v, label]) => {
                const activeSeg = v === mainView
                return (
                  <button
                    key={v}
                    onClick={() => onSelectMainView(v)}
                    title={`${label} view`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px',
                      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      border: 'none', cursor: 'pointer', outline: 'none',
                      background: activeSeg ? 'var(--overlay-subtle)' : 'transparent',
                      color: activeSeg ? 'var(--accent)' : 'var(--fg-muted)',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          {/* Right side-panel toggle (Plan / Diff / Preview) — accent when open. */}
          {onTogglePanel && (
            <button
              onClick={onTogglePanel}
              title={panelOpen ? 'Hide side panel' : 'Show side panel (Plan / Diff / Preview)'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, padding: 0, marginLeft: 4,
                background: 'transparent', border: 'none', borderRadius: 4,
                cursor: 'pointer', outline: 'none',
                color: panelOpen ? 'var(--accent)' : 'var(--fg-muted)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
                {panelOpen && <rect x="10" y="2.5" width="4.5" height="11" fill="currentColor" opacity="0.18" />}
              </svg>
            </button>
          )}
        </div>
      </DragRegion>

    </div>
  )
}

function McpDropdown({ servers, onClose }: { servers: McpServerInfo[]; onClose: () => void }) {

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 99 }}
      />
      <div
        style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          right: 0,
          zIndex: 100,
          width: 220,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          overflow: 'hidden',
          fontFamily: "var(--font-body)",
        }}
      >
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            MCP Servers
          </span>
        </div>
        {servers.map((server, i) => (
          <div
            key={`${server.name}-${i}`}
            style={{
              padding: '7px 12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: i < servers.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontSize: 11, color: 'var(--fg)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {server.name}
              </div>
              <div style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.5, marginTop: 1 }}>
                {server.source}
              </div>
            </div>
            <span style={{
              fontSize: 8,
              fontWeight: 600,
              textTransform: 'uppercase',
              color: typeColor(server.type),
              letterSpacing: 0.3,
              flexShrink: 0,
              marginLeft: 8,
            }}>
              {server.type}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
