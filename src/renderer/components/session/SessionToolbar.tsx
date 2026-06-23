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
}

export function SessionToolbar({ projectPath, projectName, detectedDevPort, effortLevel: effortLevelProp, permissionMode, lastToolName, branch }: SessionToolbarProps) {
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
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        padding: '10px 12px 6px',
        flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        <span style={{
          fontSize: 12,
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

          {/* MCP indicator */}
          {mcpServers.length > 0 && (
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
        </div>
      </DragRegion>

      {/* MCP expanded dropdown */}
      {mcpExpanded && mcpServers.length > 0 && (
        <McpDropdown servers={mcpServers} onClose={() => setMcpExpanded(false)} />
      )}
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
          top: '100%',
          right: 12,
          zIndex: 100,
          width: 220,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          overflow: 'hidden',
          fontFamily: "'Inter', system-ui, sans-serif",
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
