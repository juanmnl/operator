import { useEffect, useState } from 'react'
import type { McpServerInfo } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { SidebarToggle } from '../SidebarToggle'
import { TOOLBAR_BAND_H } from '../../lib/chrome'

const TYPE_VARS: Record<string, string> = {
  stdio: 'var(--mcp-stdio)',
  http: 'var(--mcp-http)',
  cloud: 'var(--mcp-cloud)',
}

function typeColor(type?: string): string {
  return (type && TYPE_VARS[type]) || 'var(--fg-muted)'
}

// ONE metric for every item in the toolbar's right cluster. They used to be sized two
// different ways — the badges by `padding: 2px` + `lineHeight: 16px` (a 20px box), the panel
// toggle by a fixed 22×22 — so they never shared a box height, and nothing declared
// `flexShrink: 0` or `nowrap`. Under width pressure (measured: ≤ ~780px) that squeezed the
// badges until their text WRAPPED to two lines (a 36px-tall "2 MCP" beside a 20px "High")
// and squashed the icon button to 17px wide, while the row's own space-between let the
// localhost chip ride over the Console/Chat/Preview control.
//
// So: same height, contents centred by flex (not by line-height), nothing shrinks, nothing
// wraps. The transparent 1px border keeps the bordered localhost chip exactly the same box
// as the borderless ones — and each element's border colour is CONSTANT, so this doesn't
// trip the WKWebView "no colour-changing border on a radiused element" rule.
const CHIP_H = 22
const chipBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: CHIP_H,
  padding: '0 8px',
  boxSizing: 'border-box',
  flexShrink: 0,
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
  fontSize: 9,
  fontWeight: 500,
  lineHeight: 1,
  borderRadius: 3,
  border: '1px solid transparent',
  background: 'transparent',
}

interface SessionToolbarProps {
  projectPath: string
  projectName: string
  /** Up one level: back to Project Home (agents, tasks, moodboard). The session view was
   *  the only level with no up-navigation — Project Home appeared solely as a side effect of
   *  unfocusing the session, which is why the moodboard read as missing. */
  onOpenProjectHome?: () => void
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
  /** Right side panel (Plan / Diff) open state + toggle. */
  panelOpen?: boolean
  onTogglePanel?: () => void
  /** Sidebar collapse/expand — a persistent toggle left of the title (works in both states). */
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

export function SessionToolbar({ projectPath, projectName, onOpenProjectHome, detectedDevPort, effortLevel: effortLevelProp, permissionMode, lastToolName, branch, mainView, onSelectMainView, panelOpen, onTogglePanel, sidebarCollapsed, onToggleSidebar }: SessionToolbarProps) {
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
      <DragRegion data-toolbar-header="session" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        // `TOOLBAR_BAND_H`/16, the canonical TOOLBAR header — the same box `ProjectView`,
        // `AppShell` and the right panel's tab row use, from one constant rather than four
        // literals that happened to agree (see lib/chrome.ts; two of them stopped agreeing).
        // It was 36/12, and it was the odd one out rather than they: switching between a session
        // and the channel moved the header 8px vertically and 4px horizontally under a user who
        // had only changed what was inside it.
        // 16 also happens to be the channel's `INSET`, the left edge its feed rows and composer
        // share — so matching the family costs the channel nothing and the header keeps lining up
        // with the messages beneath it.
        height: TOOLBAR_BAND_H,
        padding: '0 16px',
        boxSizing: 'border-box',
        flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        fontFamily: "var(--font-body)",
      }}>
        {/* Left cluster: sidebar toggle · title · Console·Chat·Preview main-view toggle.
            `overflow: hidden` is the second half of the collision fix: the right cluster
            never shrinks, so this side is the one that must give — and when even the
            ellipsised title has run out of room it clips instead of riding over the badges. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, overflow: 'hidden' }}>
        {onToggleSidebar && (
          <SidebarToggle collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
        )}
        <span style={{
          minWidth: 0,
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
          {/* The breadcrumb rung. Rendered UNCONDITIONALLY — the old `branchCoversProject`
              dedupe hid the project name whenever a worktree branch contained it, which is
              most worktree sessions, i.e. it would hide the way back exactly where people
              live. A control may be redundant with a nearby label; it may not disappear. */}
          {onOpenProjectHome ? (
            <button
              data-back-to-project
              onClick={onOpenProjectHome}
              title={`Back to ${projectName} — its agents, tasks and moodboard`}
              aria-label={`Back to ${projectName}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                margin: 0, padding: '1px 5px 1px 3px', borderRadius: 'var(--radius-sm)',
                background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit',
                color: 'var(--fg)', maxWidth: 220, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                transition: 'background 120ms ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span aria-hidden style={{ fontSize: 12, lineHeight: 1, opacity: 0.75 }}>‹</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectName}</span>
            </button>
          ) : (!branchCoversProject && <span>{projectName}</span>)}
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
        {onSelectMainView && (
          <div style={{
            display: 'flex', alignItems: 'center', flexShrink: 0,
            border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
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
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
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
                ...chipBase,
                color: 'var(--accent)',
                borderColor: 'var(--accent)',
                cursor: 'pointer',
                outline: 'none',
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
            // `display: flex`, not the default block: an inline-flex chip inside a block
            // wrapper sits on that wrapper's text baseline, which added ~2px of descender
            // space below it and pushed this badge 1px lower than its neighbours.
            <div style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
              <button
                onClick={() => setMcpExpanded(!mcpExpanded)}
                style={{
                  ...chipBase,
                  background: mcpExpanded ? 'var(--overlay-subtle)' : 'transparent',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                  outline: 'none',
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
            <span style={{ ...chipBase, color: 'var(--fg-muted)', textTransform: 'capitalize' }}>
              {effortLevel}
            </span>
          )}

          {/* Permission mode badge */}
          {permissionMode && permissionMode !== 'default' && (
            <span
              style={{
                ...chipBase,
                color: permissionMode === 'bypassPermissions' ? 'var(--red)' : 'var(--yellow)',
                opacity: 0.7,
              }}
            >
              {permissionMode === 'bypassPermissions' ? 'No Perms' : permissionMode}
            </span>
          )}

          {/* Right side-panel toggle (Plan / Diff) — accent when open. */}
          {onTogglePanel && (
            <button
              onClick={onTogglePanel}
              title={panelOpen ? 'Hide side panel' : 'Show side panel (Plan / Diff / Preview)'}
              style={{
                ...chipBase,
                width: CHIP_H, padding: 0, marginLeft: 4,
                justifyContent: 'center',
                borderRadius: 4,
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
      {/* Backdrop. `data-no-drag` because this dropdown renders INSIDE the toolbar's
          DragRegion, and Electron's `-webkit-app-region: drag` inherits: without the opt-out
          this full-viewport div would make the entire screen a window-drag handle for as long
          as the dropdown is open, and the click-away would move the window instead of closing
          it. See the `.drag-region` block in styles.css. */}
      <div
        data-no-drag
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 99 }}
      />
      <div
        data-no-drag
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
              <div style={{ fontSize: 9, color: 'var(--fg-muted)', marginTop: 1 }}>
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
