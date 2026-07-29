import { useRef, useState } from 'react'
import { AgentSession, Role } from '../../../shared/types'
import type { Project } from '../../../shared/types'
import { SessionItem } from './SessionItem'
import { ProjectSwitcher } from './ProjectSwitcher'
import { StatusWave } from './StatusWave'
import { LogoMark } from '../LogoMark'
import { DragRegion } from '../DragRegion'
import { sessionLabel } from '../../lib/session-label'
import { currentTaskOf } from '../../lib/session-task'
import { tildePath } from '../../lib/format'
import type { ProjectActivity } from '../../lib/project-status'

// The sidebar is SCOPED to one project (`activeProjectId` upstream) — it is never a
// cross-project accordion again. That's what let the folder-group wrapper, its disclosure,
// the cross-group drag and the "Recent" section all go: with one project in view, none of
// them had a job left.
//
// Its list is the project's TEAM: every roster lane, in roster order, whether or not it's
// running. A lane with a live session is a SessionItem (click = focus); a lane without one
// is a quiet row (click = launch it). Ad-hoc sessions — launched outside any lane, so they
// have no roleId — follow underneath, live-only.

interface SidebarProps {
  /** The project this sidebar is scoped to. Null only in the instant before scope resolves;
   *  at the gallery the sidebar isn't rendered at all. */
  project: Project | null
  /** Every known project — the switcher's list. */
  projects: Project[]
  /** Live sessions of THIS project (already scoped upstream). */
  sessions: AgentSession[]
  /** projectId → its rolled-up state, for the switcher's per-project orb + label. */
  activities: Record<string, ProjectActivity>
  activeSessionId: string | null
  customNames: Record<string, string>
  activeFolderPrefs: string | null
  globalPrefsActive: boolean
  agentsViewActive: boolean
  prefsViewActive: boolean
  /** True while Project Home is the content area — highlights the project row. */
  projectHomeActive: boolean
  effortLevels: Record<string, string>
  /** Map terminalId → fan-out position for the per-agent badge. */
  fanInfo: Record<string, { index: number; total: number }>
  /** Map sessionId → 1-based Cmd+N hint (computed over this scoped list). */
  shortcutIndices: Record<string, number>
  /** Counts for the bottom status row. */
  stats: { activeSessions: number }
  isDark: boolean
  /** Leave every project — the logo and the switcher's "All projects". */
  onShowGallery: () => void
  /** Switch scope to another project. */
  onOpenProject: (projectId: string) => void
  /** Open THIS project's home (roster) — the project row and the section's `+`. */
  onOpenProjectHome: () => void
  onSelectSession: (session: AgentSession) => void
  onRenameSession: (sessionId: string, name: string) => void
  onCloseSession: (session: AgentSession) => void
  /** Launch an idle lane (its row's click action). */
  onLaunchRole: (project: Project, role: Role) => void
  /** Effective accent for a session: its lane's colour, or a per-session override. */
  accentOf?: (session: AgentSession) => string | undefined
  /** Right-click on a row's status orb → open the colour picker anchored under it. */
  onPickAccent?: (session: AgentSession, anchor: { top: number; left: number }) => void
  /** Reorder two ad-hoc session rows (drag one onto another). */
  onReorderSession?: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
  /** Reorder two lane rows — writes the ROSTER, which is what orders them. */
  onReorderLane?: (draggedRoleId: string, targetRoleId: string, edge: 'before' | 'after') => void
  onNewSession: () => void
  onOpenFolderPrefs: (projectPath: string, projectName: string) => void
  onOpenGlobalPrefs: () => void
  onOpenAgents: () => void
  onOpenPrefs: () => void
  onToggleTheme: () => void
  /** App version (e.g. "0.1.4"), shown in the footer beside the stats. */
  version?: string
  /** A newer release found by the updater, or null. */
  update?: { version: string } | null
  onInstallUpdate?: () => void
  /** Open/close the switcher popover from outside (⌘⇧P). */
  switcherOpen: boolean
  onSwitcherOpenChange: (open: boolean) => void
}

/** One row of the AGENTS list: a lane (live or idle) or an ad-hoc session. */
type Row =
  | { kind: 'lane'; role: Role; session?: AgentSession }
  | { kind: 'session'; session: AgentSession }

export function Sidebar({
  project, projects, sessions, activities, activeSessionId, customNames, activeFolderPrefs,
  globalPrefsActive, agentsViewActive, prefsViewActive, projectHomeActive,
  effortLevels, fanInfo, shortcutIndices, stats, isDark,
  onShowGallery, onOpenProject, onOpenProjectHome, onSelectSession, onRenameSession, onCloseSession,
  onLaunchRole, accentOf, onPickAccent, onReorderSession, onReorderLane,
  onNewSession, onOpenFolderPrefs, onOpenGlobalPrefs, onOpenAgents, onOpenPrefs,
  onToggleTheme, version, update, onInstallUpdate, switcherOpen, onSwitcherOpenChange,
}: SidebarProps) {
  // Row drag state — one list now, so this is all the reorder state there is.
  const [dragRow, setDragRow] = useState<{ kind: Row['kind']; id: string } | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  // The SAME drag identity in a ref, because `dragover` must decide synchronously. The
  // browser only fires `drop` when the last dragover called preventDefault(), and a fast
  // drag can deliver dragover before React has committed `dragRow` — in which case the
  // guard below reads null, skips preventDefault, and the drop is silently refused (the
  // row snaps back with no reorder). State still drives the visuals; the ref drives the
  // decision.
  const dragRowRef = useRef<{ kind: Row['kind']; id: string } | null>(null)
  const beginDrag = (d: { kind: Row['kind']; id: string }) => { dragRowRef.current = d; setDragRow(d) }
  const endDrag = () => { dragRowRef.current = null; setDragRow(null); setDropAt(null) }

  const roster = project?.roster ?? []
  // A lane is "live" when one of this project's sessions carries its roleId.
  const byRole = new Map(sessions.filter((s) => s.roleId).map((s) => [s.roleId!, s]))
  const laneRows: Row[] = roster.map((role) => ({ kind: 'lane', role, session: byRole.get(role.id) }))
  // Ad-hoc launches (no lane) — they'd otherwise be invisible in a roster-ordered list.
  const adHocRows: Row[] = sessions.filter((s) => !s.roleId).map((s) => ({ kind: 'session', session: s }))

  const rowId = (r: Row) => (r.kind === 'lane' ? r.role.id : r.session.id)

  // A drag only means something between rows of the same kind: lane rows are ordered by the
  // roster, ad-hoc rows by the session order, and there's no sensible merge of the two.
  const commitDrop = (target: Row, edge: 'before' | 'after') => {
    const drag = dragRowRef.current
    if (!drag || drag.kind !== target.kind) return
    const id = rowId(target)
    if (drag.id === id) return
    if (target.kind === 'lane') onReorderLane?.(drag.id, id, edge)
    else onReorderSession?.(drag.id, id, edge)
  }

  const renderSessionRow = (session: AgentSession, role: Role | undefined) => {
    const customName = customNames[session.id]
    const effort = session.terminalId ? effortLevels[session.terminalId] : null
    const fan = session.terminalId ? fanInfo[session.terminalId] : undefined
    // The one label ladder (lib/session-label), shared with the rail and the dashboard.
    const label = sessionLabel({ session, role, customName, fallback: 'Session' })
    return (
      <SessionItem
        session={session}
        label={label}
        active={session.id === activeSessionId}
        effortLevel={effort}
        // A lane keeps its role treatment (colour + tracked uppercase) even after a rename —
        // the name is the session's, the colour is the lane's.
        labelIsRole={!!role}
        roleColor={accentOf ? accentOf(session) : role?.accent}
        fanInfo={fan}
        currentTask={currentTaskOf(session, project ?? undefined)}
        closable
        shortcutIndex={shortcutIndices[session.id] ?? null}
        onClick={() => onSelectSession(session)}
        onRename={(name) => onRenameSession(session.id, name)}
        onClose={() => onCloseSession(session)}
        onPickAccent={onPickAccent && ((anchor) => onPickAccent(session, anchor))}
      />
    )
  }

  const renderRow = (row: Row) => {
    const id = rowId(row)
    const edge = dropAt?.id === id ? dropAt.edge : null
    return (
      <div
        key={`${row.kind}:${id}`}
        data-session-row={row.kind === 'session' ? row.session.id : row.session?.id}
        data-lane-row={row.kind === 'lane' ? row.role.id : undefined}
        draggable={row.kind === 'lane' ? !!onReorderLane && laneRows.length > 1 : !!onReorderSession && adHocRows.length > 1}
        onDragStart={(e) => { beginDrag({ kind: row.kind, id }); e.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          const drag = dragRowRef.current
          if (!drag || drag.kind !== row.kind || drag.id === id) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const r = e.currentTarget.getBoundingClientRect()
          const next: 'before' | 'after' = e.clientY - r.top < r.height / 2 ? 'before' : 'after'
          setDropAt((d) => (d?.id === id && d.edge === next ? d : { id, edge: next }))
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDropAt((d) => (d?.id === id ? null : d))
        }}
        onDrop={(e) => {
          e.preventDefault()
          // Read the edge from the event, not from the rendered `edge`: on a fast drag the
          // dropAt state may not have committed, and a drop with no line drawn should still
          // land where the cursor is.
          const r = e.currentTarget.getBoundingClientRect()
          commitDrop(row, e.clientY - r.top < r.height / 2 ? 'before' : 'after')
          endDrag()
        }}
        style={{
          opacity: dragRow?.kind === row.kind && dragRow.id === id ? 0.5 : 1,
          // Constant 2px transparent borders so the accent drop line can't shift layout, and
          // colour only ever lands on a straight (unradiused) rule — the WKWebView rule.
          borderTop: `2px solid ${edge === 'before' ? 'var(--accent)' : 'transparent'}`,
          borderBottom: `2px solid ${edge === 'after' ? 'var(--accent)' : 'transparent'}`,
        }}
      >
        {row.kind === 'session'
          ? renderSessionRow(row.session, undefined)
          : row.session
            ? renderSessionRow(row.session, row.role)
            : (
              <LaneRow
                role={row.role}
                onClick={() => project && onLaunchRole(project, row.role)}
              />
            )}
      </div>
    )
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
        fontFamily: "var(--font-body)",
        userSelect: 'none',
        position: 'relative',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Header = the project switcher. It carries WHERE YOU ARE, which is why the app name
          and version moved down to the footer. The top padding clears the traffic lights and
          stays bare titlebar, so the window is still draggable from up there. */}
      <DragRegion style={{ paddingTop: 40, padding: '40px 10px 8px 12px' }}>
        <div
          data-switcher-trigger
          role="button"
          tabIndex={0}
          onClick={() => onSwitcherOpenChange(!switcherOpen)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSwitcherOpenChange(!switcherOpen) } }}
          title="Switch project (⌘⇧P) — leaving stops nothing"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '3px 4px', borderRadius: 6, cursor: 'pointer', outline: 'none',
            background: switcherOpen ? 'var(--overlay-subtle)' : 'transparent',
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onShowGallery() }}
            title="All projects (⌘⇧O)"
            aria-label="All projects"
            style={{
              display: 'flex', alignItems: 'center', flexShrink: 0,
              background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', outline: 'none',
            }}
          >
            <LogoMark size={16} animated={false} />
          </button>
          <span style={{
            flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.2,
            color: projectHomeActive ? 'var(--accent)' : 'var(--fg)', letterSpacing: -0.3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {project?.name ?? 'No project'}
          </span>
          <span style={{ flexShrink: 0, fontSize: 8, color: 'var(--fg-muted)', }}>⌄</span>
        </div>
        {project?.path && (
          <div
            title={project.path}
            style={{
              // 9.5px and no opacity over --fg-muted — at 9px × 0.65 this path measured
              // 2.2:1 on the light palettes, i.e. decoration rather than text.
              fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
              padding: '2px 4px 0 28px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {tildePath(project.path)}
          </div>
        )}
      </DragRegion>

      {switcherOpen && (
        <ProjectSwitcher
          projects={projects}
          activeProjectId={project?.id ?? null}
          activities={activities}
          onPick={(id) => { onSwitcherOpenChange(false); onOpenProject(id) }}
          onShowGallery={() => { onSwitcherOpenChange(false); onShowGallery() }}
          onOpenFolder={() => { onSwitcherOpenChange(false); onNewSession() }}
          onClose={() => onSwitcherOpenChange(false)}
        />
      )}

      {/* AGENTS — the project's team. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 10px 4px 14px', flexShrink: 0,
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 500,
          textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--fg-muted)',
        }}>
          Agents
        </span>
        <button
          onClick={onOpenProjectHome}
          title="Add or edit lanes on the roster"
          aria-label="Open the roster"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, padding: 0, lineHeight: 1,
            background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', outline: 'none',
            color: 'var(--fg-muted)', 
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '0 6px 4px',
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        {laneRows.length === 0 && adHocRows.length === 0 && (
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', padding: '6px 8px', lineHeight: 1.5, margin: 0 }}>
            No agents yet — add one on the roster.
          </p>
        )}

        {laneRows.map(renderRow)}

        {adHocRows.length > 0 && (
          <>
            {/* Thin rule + label: these belong to the project but not to any lane. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '10px 8px 4px',
            }}>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 9.5, textTransform: 'uppercase',
                letterSpacing: '0.14em', color: 'var(--fg-muted)', flexShrink: 0,
              }}>
                Other
              </span>
              <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
            {adHocRows.map(renderRow)}
          </>
        )}
      </div>

      {/* Stats row — at-a-glance count, and the app identity that the header gave up. */}
      <div style={{
        padding: '4px 14px 0',
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        fontSize: 10,
        color: 'var(--fg-muted)',
        fontVariantNumeric: 'tabular-nums',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <span>{stats.activeSessions} active</span>
        <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          Operator{version ? ` v${version}` : ''}
        </span>
        {update && (
          <button
            onClick={onInstallUpdate}
            title={`Update ${update.version} available — install & restart`}
            aria-label={`Install update ${update.version}`}
            style={{
              flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 14, padding: 0,
              background: 'transparent', color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 999,
              cursor: 'pointer', outline: 'none',
            }}
          >
            {/* Arrow centered in the viewBox + a 0.5px optical nudge (a chevron reads high). */}
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'translateY(0.5px)' }}>
              <path d="M6 9V3M3 5.5l3-2.5 3 2.5" />
            </svg>
          </button>
        )}
      </div>

      {/* Bottom bar.
          Sized to FIT: n icons × 24 + (n-1) × gap + padding must stay inside the 220px
          sidebar, or the wrapper's overflow:hidden slices the last icon in half at the edge
          (that's what it did with seven — the theme toggle was cut down the middle). Six at
          gap 8 and padding 12 come to 196 of 220, so there's ~24px of slack. `flexWrap` is
          the structural guard behind that arithmetic: a future seventh icon drops to a
          second line instead of silently spilling out of the sidebar again. */}
      <div style={{
        padding: '6px 12px 10px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        {/* All footer icons share one 14px box (viewBox 16, stroke 1.1) and the
            same button padding; spacing comes from the row's `gap` alone, so they
            read as a single uniform set. The gear keeps viewBox 24 with a
            proportional stroke (1.6/24 ≈ 1.1/16). `flexShrink: 0` on each keeps them
            square — a squashed icon box is worse than a wrapped row. */}
        <button
          onClick={onNewSession}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8, flexShrink: 0,
            display: 'flex', alignItems: 'center', opacity: 0.85,
          }}
          title="Open another folder as a project"
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
            padding: '3px 5px', borderRadius: 8, flexShrink: 0,
            display: 'flex', alignItems: 'center',
            opacity: agentsViewActive ? 1 : 0.85,
          }}
          title="Agents — every agent across your projects"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="5.5" width="10" height="7.5" rx="2" stroke="var(--fg-muted)" strokeWidth="1.1" />
            <path d="M8 3v2.5" stroke="var(--fg-muted)" strokeWidth="1.1" strokeLinecap="round" />
            <circle cx="8" cy="2.5" r="1" fill="var(--fg-muted)" />
            <circle cx="6" cy="9" r="0.9" fill="var(--fg-muted)" />
            <circle cx="10" cy="9" r="0.9" fill="var(--fg-muted)" />
          </svg>
        </button>
        {/* This project's Claude files (.claude) — was the per-group prefs button. */}
        <button
          onClick={() => project && onOpenFolderPrefs(project.path, project.name)}
          disabled={!project?.path}
          style={{
            background: activeFolderPrefs && activeFolderPrefs === project?.path ? 'var(--overlay-subtle)' : 'none',
            border: 'none', cursor: project?.path ? 'pointer' : 'default',
            padding: '3px 5px', borderRadius: 8, flexShrink: 0,
            display: 'flex', alignItems: 'center',
            opacity: project?.path ? (activeFolderPrefs === project?.path ? 1 : 0.85) : 0.35,
          }}
          title={project ? `${project.name} Claude files (.claude)` : 'Project Claude files'}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="var(--fg-muted)" strokeWidth="1.1" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onOpenGlobalPrefs}
          style={{
            background: globalPrefsActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 8, flexShrink: 0,
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
            padding: '3px 5px', borderRadius: 8, flexShrink: 0,
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
            padding: '3px 5px', borderRadius: 8, flexShrink: 0,
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

/** A roster lane with nothing running — click to launch it. Matches the hub's PassiveCard:
 *  the idle orb already reads as dimmed via its static-accent treatment, so the only other
 *  receded element is the name (muted INK, never a group opacity), and the row is NOT given
 *  the uppercase/accent treatment that marks a live lane. */
function LaneRow({ role, onClick }: { role: Role; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Launch ${role.name}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        height: 32, padding: '0 12px 0 8px', boxSizing: 'border-box',
        background: hover ? 'var(--overlay-subtle)' : 'transparent',
        borderRadius: hover ? 6 : 0,
        cursor: 'pointer', textAlign: 'left', outline: 'none',
        fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <StatusWave status="idle" seed={role.id} accent={role.accent} />
      </span>
      <span style={{
        flex: 1, minWidth: 0, color: 'color-mix(in srgb, var(--fg) 80%, transparent)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {role.name}
      </span>
      {/* The tag carries whether this lane is running, so it has to be readable at rest —
          at 0.5 over --fg-muted it measured 1.8–2.9:1 and was effectively invisible in the
          light palettes. The hover signal is the word changing, not the ink getting darker. */}
      <span style={{
        flexShrink: 0, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.1em',
        color: hover ? 'var(--fg)' : 'var(--fg-muted)',
      }}>
        {hover ? 'launch ▷' : 'idle'}
      </span>
    </div>
  )
}
