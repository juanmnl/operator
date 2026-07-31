import { Fragment } from 'react'
import { AgentSession, Project, Role } from '../../../shared/types'
import { StatusWave, WaveStatus } from './StatusWave'
import { DragRegion } from '../DragRegion'
import { sessionLabel } from '../../lib/session-label'
import { currentTaskOf } from '../../lib/session-task'
import { laneTextColor } from '../../lib/lane-color'
import { useHoverCard } from '../../lib/use-hover-card'

interface SidebarRailProps {
  /** The project this rail is scoped to (same scope as the expanded sidebar). */
  project: Project | null
  /** Live sessions of THIS project (already scoped upstream). */
  sessions: AgentSession[]
  /** Projects, to resolve each session's roleId → its lane (colour + name). */
  projects: Project[]
  activeSessionId: string | null
  customNames: Record<string, string>
  shortcutIndices: Record<string, number>
  onSelectSession: (session: AgentSession) => void
  onNewSession: () => void
  /** Expand the sidebar back to full width. No longer a toggle button of its own (the
   *  toolbar owns that) — this is what the project badge does, since switching project
   *  means reaching the switcher, which lives in the expanded sidebar. */
  onExpand: () => void
  /** Leave every project — the project badge's secondary action. */
  onShowGallery: () => void
  /** Effective accent for a session: its lane's colour, or a per-session override. */
  accentOf?: (session: AgentSession) => string | undefined
  /** Right-click on the orb → open the colour picker anchored under it. */
  onPickAccent?: (session: AgentSession, anchor: { top: number; left: number }) => void
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

// Compact project tag for the rail's group labels: initials of a multi-word name
// ("Operator-landing" → "OL"), otherwise the first 4 letters ("operator" → "OPER").
function shortNameOf(name: string): string {
  const words = name.replace(/[_\-/.]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase()
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase()
}

// Collapsed "rail" — a Slack-style narrow strip for quick access to running
// sessions. Hosts the macOS traffic lights (paddingTop) so the content card to
// its right never slides under them.
//
// It does NOT carry its own show-sidebar toggle: SessionToolbar's is the single
// persistent one (it works in both states, so a second copy here was the same
// control twice). Expanding from the rail is still one click — the project badge
// below does it, since the switcher it leads to lives in the expanded sidebar.
export function SidebarRail({ project, sessions, projects, activeSessionId, customNames, shortcutIndices, onSelectSession, onNewSession, onExpand, onShowGallery, accentOf, onPickAccent }: SidebarRailProps) {
  // No project clustering any more: the rail is scoped to ONE project, so the tags and
  // seams that separated clusters have nothing left to separate. The project itself is
  // named once, by the badge at the top.
  //
  // It also carries NO cross-project orbs. A version of this briefly did; the persistent
  // ProjectRail now sits 44px to the left in every state, including this one, so a cluster
  // here would be the same dots twice over.
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
      {/* Top: bare strip that clears the traffic lights (and stays draggable). */}
      <DragRegion style={{ paddingTop: 40, paddingBottom: 2, width: '100%' }} />

      {/* Which project you're in, at 1–2 chars. Expanding is where the switcher lives, so
          that's what a click does; the title spells out the ⌘⇧O way out. */}
      {project && (
        <button
          onClick={onExpand}
          onContextMenu={(e) => { e.preventDefault(); onShowGallery() }}
          title={`${project.name} — click to switch project, right-click for all projects (⌘⇧O)`}
          aria-label={`Project ${project.name}`}
          style={{
            flexShrink: 0, marginBottom: 4, padding: '2px 6px',
            background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
            cursor: 'pointer', outline: 'none',
            fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--fg-muted)', 
            maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
        >
          {shortNameOf(project.name)}
        </button>
      )}

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
          // The session's own project — normally the scoped one, but resolved per session so
          // a legacy row with a different projectId still finds its lane.
          const sessionProject = session.projectId ? projects.find((p) => p.id === session.projectId) : undefined
          const role: Role | undefined = session.roleId ? sessionProject?.roster?.find((r) => r.id === session.roleId) : undefined
          // Same label ladder as the expanded sidebar and the dashboard (lib/session-label):
          // custom name → lane → first prompt → running model → generic. The rail used to
          // fall back straight to the folder name, so collapsing renamed every agent in a
          // project to the same folder initials.
          const label = sessionLabel({ session, role, customName: customNames[session.id] })
          const initial = initialOf(role?.name || label)
          const accent = accentOf ? accentOf(session) : role?.accent
          const idx = shortcutIndices[session.id]
          const task = currentTaskOf(session, sessionProject)
          return (
            <RailRow
              key={session.id}
              session={session}
              active={active}
              label={label}
              initial={initial}
              accent={accent}
              idx={idx}
              task={task}
              onSelectSession={onSelectSession}
              onPickAccent={onPickAccent}
            />
          )
        })}
      </div>

      {/* Bottom: new session.
          6 at the BOTTOM, 8 elsewhere, and the 2px is the whole point: this 34px button and the
          ProjectRail's foot are the entire bottom-left corner in the collapsed state, and at a
          flat 8 its centre sat on 867 against the rail's 869. Measured, not eyeballed — two
          strips 1px apart across a hairline show a 2px stagger clearly. The expanded state's
          footer row already lands on 869; this puts the collapsed state on the same line. */}
      <div style={{
        padding: '8px 8px 6px', display: 'flex', justifyContent: 'center', width: '100%',
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

/** One rail entry. Split out of the map so it can own a hook: the hover card is the SHARED
 *  implementation (lib/use-hover-card), which is what the expanded sidebar's rows use — the
 *  rail previously carried a copy of the card with none of the hardening, so it was exposed
 *  to both the row-moves-under-the-cursor and the cursor-leaves-the-window failures. */
function RailRow({ session, active, label, initial, accent, idx, task, onSelectSession, onPickAccent }: {
  session: AgentSession
  active: boolean
  label: string
  initial: string
  accent?: string
  idx?: number
  task?: string
  onSelectSession: (s: AgentSession) => void
  onPickAccent?: (session: AgentSession, anchor: { top: number; left: number }) => void
}) {
  const hover = useHoverCard(session.id)
  return (
    <Fragment>
            <Fragment key={session.id}>
            <button
              ref={hover.ref as React.RefObject<HTMLButtonElement>}
              onClick={() => onSelectSession(session)}
              onContextMenu={(e) => {
                if (!onPickAccent) return
                // Right-click is the colour affordance; left-click still selects.
                e.preventDefault()
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                hover.dismiss() // the hover card would sit on top of the popover
                onPickAccent(session, { top: r.bottom + 6, left: r.right + 8 })
              }}
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
                // positioned one would be cut off at the 64px rail edge. Positioning and
                // dismissal are the SHARED implementation (lib/use-hover-card) — this used to
                // trust enter/leave alone, which left cards frozen on screen.
                hover.onMouseEnter(e)
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent'
                hover.onMouseLeave()
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
                <StatusWave status={getDotStatus(session)} seed={session.id} size={30} accent={accent} />
                <span className="ink-centred" style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, lineHeight: 1,
                  fontFamily: "var(--font-body)",
                  color: accent ? laneTextColor(accent) : 'var(--fg)',
                  // Tightened for two letters, none for one — handed to `.ink-centred` as
                  // --track so the trailing-space cancellation tracks whichever applies.
                  ['--track' as string]: initial.length > 1 ? '-0.5px' : '0px',
                  // Slight halo so the glyph reads cleanly over the dot grid.
                  textShadow: '0 0 3px var(--bg-sidebar), 0 0 3px var(--bg-sidebar)',
                  pointerEvents: 'none',
                }}>
                  {initial}
                </span>
              </span>
            </button>
            {hover.card && (
              <div
                style={{
                  position: 'fixed',
                  top: hover.card.top,
                  left: hover.card.left,
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
                  <span style={{ fontSize: 11.5, color: accent ? laneTextColor(accent) : 'var(--fg)' }}>{label}</span>
                  {idx && <span style={{ fontSize: 9, color: 'var(--fg-muted)', }}>⌘{idx}</span>}
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
    </Fragment>
  )
}
