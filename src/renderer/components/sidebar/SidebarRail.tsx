import { Fragment, useState } from 'react'
import { AgentSession, Project, Role } from '../../../shared/types'
import { StatusWave, WaveStatus } from './StatusWave'
import { DragRegion } from '../DragRegion'
import { modelFamilyLabel } from '../../lib/roster'
import { isInjectedTurn } from '../../lib/format'
import { currentTaskOf } from '../../lib/session-task'

interface SidebarRailProps {
  sessions: AgentSession[]
  /** Projects, to resolve each session's roleId → its lane (colour + name). */
  projects: Project[]
  activeSessionId: string | null
  customNames: Record<string, string>
  shortcutIndices: Record<string, number>
  onSelectSession: (session: AgentSession) => void
  onNewSession: () => void
  /** Expand the sidebar back to full width. */
  onExpand: () => void
}

function getDotStatus(session: AgentSession): WaveStatus {
  if (session.status === 'ended') return 'ended'
  switch (session.phase) {
    case 'running': return 'running'
    case 'compacting': return 'compacting'
    case 'waiting': return 'waiting'
    default: return 'idle'
  }
}

// 1–2 char badge from the session/folder name. Strips a leading "operator-"/path
// noise and prefers initials of multi-word names (e.g. "My App" → "MA").
function initialOf(name: string): string {
  const clean = name.replace(/[_\-/.]+/g, ' ').trim()
  const words = clean.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

const panelIcon = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3.25" width="12" height="9.5" rx="1.6" />
    <line x1="6.25" y1="3.25" x2="6.25" y2="12.75" />
  </svg>
)

// Collapsed "rail" — a Slack-style narrow strip for quick access to running
// sessions plus the expand toggle. Hosts the macOS traffic lights (paddingTop)
// so the content card to its right never slides under them.
export function SidebarRail({ sessions, projects, activeSessionId, customNames, shortcutIndices, onSelectSession, onNewSession, onExpand }: SidebarRailProps) {
  const [hovered, setHovered] = useState<{ id: string; top: number; left: number } | null>(null)
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--bg-sidebar)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        userSelect: 'none',
        // @ts-expect-error Electron-specific CSS property (ignored by Tauri)
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Top: clears the traffic lights, holds the expand toggle. */}
      <DragRegion style={{ paddingTop: 40, paddingBottom: 6, display: 'flex', justifyContent: 'center', width: '100%' }}>
        <button
          onClick={onExpand}
          title="Show sidebar"
          aria-label="Show sidebar"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 26, padding: 0,
            background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
            color: 'var(--fg-muted)', opacity: 0.85, cursor: 'pointer',
            transition: 'opacity 120ms ease, background 120ms ease',
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'var(--overlay-subtle)' }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.85'; e.currentTarget.style.background = 'transparent' }}
        >
          {panelIcon}
        </button>
      </DragRegion>

      {/* Quick-access process icons. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          paddingTop: 2,
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        {sessions.map((session) => {
          const active = session.id === activeSessionId
          const project = session.projectId ? projects.find((p) => p.id === session.projectId) : undefined
          const role: Role | undefined = session.roleId ? project?.roster?.find((r) => r.id === session.roleId) : undefined
          // Same label ladder as the expanded sidebar (see Sidebar.tsx): custom name →
          // lane → first prompt → running model → generic. The rail used to fall back
          // straight to the folder name, so collapsing renamed every agent in a project
          // to the same folder initials.
          const cleanSummary = session.summary && !isInjectedTurn(session.summary) ? session.summary : undefined
          const modelName = session.model && !session.model.startsWith('<') ? modelFamilyLabel(session.model) : undefined
          const label = customNames[session.id] || role?.name || cleanSummary || modelName || 'Session'
          const initial = initialOf(role?.name || label)
          const idx = shortcutIndices[session.id]
          const task = currentTaskOf(session, project)
          return (
            <Fragment key={session.id}>
            <button
              onClick={() => onSelectSession(session)}
              aria-label={idx ? `${label} (⌘${idx})` : label}
              style={{
                position: 'relative',
                width: 40,
                height: 40,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                borderRadius: 11,
                // No dynamic (colour-changing) border on this rounded button — that
                // re-rasterizes the rounded border layer in WKWebView on toggle. The
                // active state is carried by the background wash + the accent pill
                // below; the border stays a constant transparent for layout stability.
                border: '1px solid transparent',
                background: active ? 'var(--overlay-medium)' : 'transparent',
                cursor: 'pointer',
                transition: 'background 120ms ease',
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = 'var(--overlay-subtle)'
                // Fixed-position card: the rail scroller clips overflow, so an absolutely
                // positioned one would be cut off at the 64px rail edge.
                const r = e.currentTarget.getBoundingClientRect()
                setHovered({ id: session.id, top: r.top, left: r.right + 8 })
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent'
                setHovered((h) => (h?.id === session.id ? null : h))
              }}
            >
              {/* Active left pill (Slack-style). */}
              {active && (
                <span style={{ position: 'absolute', left: -10, top: 9, bottom: 9, width: 3, borderRadius: 2, background: 'var(--accent)' }} />
              )}
              {/* Lane initials on top of the animated dot-logo so sessions stay
                  distinguishable at a glance. The dots carry the live status, tinted
                  with the lane's accent so the rail also says WHICH agent. */}
              <span style={{ position: 'relative', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <StatusWave status={getDotStatus(session)} seed={session.id} size={30} accent={role?.accent} />
                <span style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, lineHeight: 1,
                  fontFamily: "var(--font-body)",
                  color: role?.accent || 'var(--fg)',
                  letterSpacing: initial.length > 1 ? -0.5 : 0,
                  // Slight halo so the glyph reads cleanly over the dot grid.
                  textShadow: '0 0 3px var(--bg-sidebar), 0 0 3px var(--bg-sidebar)',
                  pointerEvents: 'none',
                }}>
                  {initial}
                </span>
              </span>
            </button>
            {hovered?.id === session.id && (
              <div
                style={{
                  position: 'fixed',
                  top: hovered.top,
                  left: hovered.left,
                  zIndex: 60,
                  maxWidth: 260,
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.35), inset 0 0 0 1px color-mix(in srgb, var(--fg) 12%, transparent)',
                  pointerEvents: 'none',
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1.35,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 11.5, color: role?.accent || 'var(--fg)' }}>{label}</span>
                  {idx && <span style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.5 }}>⌘{idx}</span>}
                </div>
                {task && (
                  // The live task, clamped to two lines — a long plan item shouldn't
                  // grow the card into a wall of text.
                  <div style={{
                    marginTop: 3,
                    fontSize: 10.5,
                    color: 'var(--fg-muted)',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {task}
                  </div>
                )}
              </div>
            )}
            </Fragment>
          )
        })}
      </div>

      {/* Bottom: new session. */}
      <div style={{
        padding: 8, display: 'flex', justifyContent: 'center', width: '100%',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <button
          onClick={onNewSession}
          title="New session (⌘N)"
          aria-label="New session"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, padding: 0,
            background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-md)',
            color: 'var(--fg-on-accent)', cursor: 'pointer',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            transition: 'filter 120ms ease, transform 120ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(1.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = 'none' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <line x1="8" y1="3.5" x2="8" y2="12.5" />
            <line x1="3.5" y1="8" x2="12.5" y2="8" />
          </svg>
        </button>
      </div>
    </div>
  )
}
