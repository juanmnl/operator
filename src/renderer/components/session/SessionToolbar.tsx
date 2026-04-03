import { useEffect, useState } from 'react'
import type { McpServerInfo } from '../../../shared/types'

interface SessionToolbarProps {
  projectPath: string
  projectName: string
  effortLevel?: 'high' | 'normal' | 'low' | null
}

export function SessionToolbar({ projectPath, projectName, effortLevel: effortLevelProp }: SessionToolbarProps) {
  const [effortLevel, setEffortLevel] = useState<string | null>(effortLevelProp ?? null)
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [mcpExpanded, setMcpExpanded] = useState(false)

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

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          height: 28,
          flexShrink: 0,
          borderBottom: '1px solid var(--border)',
          fontFamily: "'Inter', system-ui, sans-serif",
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {projectName}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                background: mcpExpanded ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                color: 'var(--fg-muted)',
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
                lineHeight: '16px',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <circle cx="4" cy="8" r="2" fill="var(--fg-muted)" opacity="0.6" />
                <circle cx="12" cy="8" r="2" fill="var(--fg-muted)" opacity="0.6" />
                <path d="M6 8h4" stroke="var(--fg-muted)" strokeWidth="1" opacity="0.4" />
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
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--fg-muted)',
                borderRadius: 3,
                lineHeight: '16px',
              }}
            >
              {effortLevel}
            </span>
          )}
        </div>
      </div>

      {/* MCP expanded dropdown */}
      {mcpExpanded && mcpServers.length > 0 && (
        <McpDropdown servers={mcpServers} onClose={() => setMcpExpanded(false)} />
      )}
    </div>
  )
}

function McpDropdown({ servers, onClose }: { servers: McpServerInfo[]; onClose: () => void }) {
  const typeColors: Record<string, string> = {
    stdio: '#4ade80',
    http: '#46BDFF',
    cloud: '#D58FDB',
  }

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
          top: 28,
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
              color: typeColors[server.type] || 'var(--fg-muted)',
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
