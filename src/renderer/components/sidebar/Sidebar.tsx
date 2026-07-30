import { useRef, useState } from 'react'
import { AgentSession, Role } from '../../../shared/types'
import type { Project } from '../../../shared/types'
import { SessionItem } from './SessionItem'
import { StatusWave } from './StatusWave'
import { DragRegion } from '../DragRegion'
import { sessionLabel } from '../../lib/session-label'
import { currentTaskOf } from '../../lib/session-task'
import { tildePath } from '../../lib/format'

// The sidebar is SCOPED to one project (`activeProjectId` upstream) — it is never a
// cross-project accordion again. That's what let the folder-group wrapper, its disclosure,
// the cross-group drag and the "Recent" section all go: with one project in view, none of
// them had a job left.
//
// Its list is the project's TEAM: every roster lane, in roster order, whether or not it's
// running. A lane with a live session is a SessionItem (click = focus); a lane without one
// is a quiet row (click = launch it). Ad-hoc sessions — launched outside any lane, so they
// have no roleId — follow underneath, live-only.
//
// It shows ONE project and nothing else. An `ALSO ACTIVE` section listing every other active
// project briefly lived below the team; it was removed. Cross-project orientation is the
// persistent ProjectRail's job (ProjectRail.tsx), which does it in 44px and in every state
// including the gallery — a second list of the same projects in here was the same information
// twice. The one cross-project thing that remains is the `previous` chip in the header, and
// that isn't orientation: it's the only way to un-shelve a project you've navigated into.

interface SidebarProps {
  /** The project this sidebar is scoped to. Null only in the instant before scope resolves;
   *  at the gallery the sidebar isn't rendered at all. */
  project: Project | null
  /** Live sessions of THIS project (already scoped upstream). */
  sessions: AgentSession[]
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
  /** Un-shelve THIS project — the `previous` chip in the header row. */
  onRestoreProject?: (projectId: string) => void
  /** Open the project channel (the read-only agent feed). Absent = no row rendered. */
  onOpenChannel?: () => void
  /** True while the channel is the content area, so its row reads as selected. */
  channelActive?: boolean
  /** Entries newer than this project's lastReadAt. 0/undefined = no badge. */
  channelUnread?: number
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
}

/** One row of the AGENTS list: a lane (live or idle) or an ad-hoc session. */
type Row =
  | { kind: 'lane'; role: Role; session?: AgentSession }
  | { kind: 'session'; session: AgentSession }

export function Sidebar({
  project, sessions, activeSessionId, customNames, activeFolderPrefs,
  globalPrefsActive, agentsViewActive, prefsViewActive, projectHomeActive,
  effortLevels, fanInfo, shortcutIndices, stats, isDark,
  onRestoreProject, onOpenChannel, channelActive, channelUnread,
  onOpenProjectHome, onSelectSession, onRenameSession, onCloseSession,
  onLaunchRole, accentOf, onPickAccent, onReorderSession, onReorderLane,
  onOpenFolderPrefs, onOpenGlobalPrefs, onOpenAgents, onOpenPrefs,
  onToggleTheme, version, update, onInstallUpdate,
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
      {/* Header = IDENTITY ONLY. It says where you are and nothing else — no switcher trigger,
          no logo-to-gallery. Moving between projects is the rail's job now (a tile per open
          project, "All projects" and "Open folder" at its foot), and it does that job in every
          state including the gallery, where this sidebar isn't rendered at all. A second set of
          the same controls here was the same navigation twice, in the surface that has the
          weaker claim to it.
          The top padding clears the traffic lights and stays bare titlebar, so the window is
          still draggable from up there. */}
      <DragRegion style={{ paddingTop: 40, padding: '40px 10px 8px 12px' }}>
        <div
          data-sidebar-project
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '3px 4px', minHeight: 22,
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
        >
          <span data-sidebar-project-name style={{
            flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.2,
            // Accent marks "Project Home is what's on screen", but bare var(--accent) at 13px
            // measured 2.69:1 on Mission Control light and 2.22:1 on 1984 light — body text
            // under half the 4.5 floor. It had never been probed: the old theme-pass step
            // measured the switcher popover this header used to open, not the header itself.
            // Mixed 45% toward --fg it keeps the hue and clears the floor everywhere
            // (4.99–12.85 across the six palettes).
            color: projectHomeActive ? 'color-mix(in srgb, var(--accent) 55%, var(--fg))' : 'var(--fg)',
            letterSpacing: -0.3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {project?.name ?? 'No project'}
          </span>
          {/* You can browse into a shelved project from the gallery's Previous shelf, and
              nothing in here used to say so. The chip is the state AND the way out of it —
              one control, in the one place you'd look. Same treatment as the card's
              "folder not on record" chip: transparent, hairline, tracked. */}
          {project?.archivedAt && (
            <button
              data-previous-chip
              onClick={() => onRestoreProject?.(project.id)}
              title={`${project.name} is shelved — click to bring it back to Active`}
              style={{
                flexShrink: 0, padding: '1px 6px',
                fontFamily: 'var(--font-mono)', fontSize: 9,
                textTransform: 'uppercase', letterSpacing: '0.1em',
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', color: 'var(--fg-muted)',
                cursor: 'pointer', outline: 'none',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-muted)' }}
            >
              previous
            </button>
          )}
        </div>
        {project?.path && (
          <div
            title={project.path}
            style={{
              // 9.5px and no opacity over --fg-muted — at 9px × 0.65 this path measured
              // 2.2:1 on the light palettes, i.e. decoration rather than text.
              fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
              // Was indented 28px to clear the logo that used to sit beside the name; with the
              // logo gone it lines up under the name instead.
              padding: '2px 4px 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {tildePath(project.path)}
          </div>
        )}
      </DragRegion>

      {/* # channel — the room the lanes are in. PROJECT-level, so it sits above the AGENTS
          label rather than among the lanes: it is not another lane, and putting it in the list
          would make it read as one. Unread counts entries newer than this project's lastReadAt. */}
      {onOpenChannel && (
        <button
          data-channel-nav
          onClick={onOpenChannel}
          title="Everything your agents have said to each other in this project"
          style={{
            display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
            padding: '5px 14px', boxSizing: 'border-box', flexShrink: 0,
            background: channelActive ? 'var(--overlay-subtle)' : 'transparent',
            border: 'none', outline: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)',
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
          onMouseEnter={(e) => { if (!channelActive) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
          onMouseLeave={(e) => { if (!channelActive) e.currentTarget.style.background = 'transparent' }}
        >
          <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)' }}>#</span>
          <span style={{
            flex: 1, minWidth: 0, fontSize: 11.5,
            color: channelActive ? 'var(--accent)' : 'color-mix(in srgb, var(--fg) 80%, transparent)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            channel
          </span>
          {(channelUnread ?? 0) > 0 && (
            <span data-channel-unread style={{
              flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9,
              fontVariantNumeric: 'tabular-nums', color: 'var(--accent)',
            }}>
              {channelUnread}
            </span>
          )}
        </button>
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
        {/* EMPTY — now a real state, not an edge case: rosters start empty and grow on demand,
            so this is what every new project's sidebar shows first. The old copy named a place
            ("add one on the roster") without going there, which is the shape of the bug that
            made a deleted lane feel unrecoverable. It is a CONTROL now, and it routes to the one
            surface that owns adding a lane — the roster board, where the templates live. The
            sidebar deliberately does NOT duplicate the preset menu: one way to add a lane. */}
        {laneRows.length === 0 && adHocRows.length === 0 && (
          <div data-sidebar-no-lanes style={{ padding: '4px 8px 0' }}>
            <p style={{ fontSize: 11, color: 'color-mix(in srgb, var(--fg) 72%, transparent)', lineHeight: 1.5, margin: '0 0 8px' }}>
              No agents yet. An agent is a lane on this project — its own model, effort and brief.
            </p>
            <button
              onClick={onOpenProjectHome}
              title="Open the roster and pick an agent"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
                height: 30, padding: '0 10px', boxSizing: 'border-box', cursor: 'pointer',
                border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)',
                background: 'transparent', color: 'var(--fg-muted)', outline: 'none',
                fontFamily: 'inherit', fontSize: 11,
                transition: 'background 120ms ease, color 120ms ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-muted)' }}
            >
              + Add an agent
            </button>
          </div>
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

        {/* The count belongs to the LANES, so it sits with them — inside the scroller, hugging
            the last row, rather than stranded at the foot of the sidebar where it read as a
            property of the whole app. It counts THIS project only; do not "helpfully" make it
            count everything, or it starts contradicting ALSO ACTIVE 40px below.
            Silent at zero: every lane above already says "idle". */}
        {stats.activeSessions > 0 && (
          <div data-sidebar-active-count title={`${stats.activeSessions} agent${stats.activeSessions === 1 ? '' : 's'} running in this project`} style={{
            padding: '8px 8px 2px',
            fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {stats.activeSessions} active
          </div>
        )}
      </div>

      {/* Bottom bar — the app's own row: its tools, then its identity.
          Sized to FIT: n icons + gaps + padding must stay inside the 220px sidebar, or the
          wrapper's overflow:hidden slices the last one in half at the edge (that's what it did
          with seven — the theme toggle was cut down the middle). Making room for the version
          cost 2px of icon padding and 3px of gap: six 20px icons at gap 5 come to 145 + 12
          padding = 157, leaving ~58px — measured against the widest version string we'd
          plausibly ship ("v0.10.11" needs 56px at 9.5 mono). The icon BOX is untouched at
          14px; this is spacing, not squashing.
          The version takes `flex: 1 1 0` rather than `marginLeft: auto` deliberately: with
          `flexWrap` on, an auto-margined item WRAPS to a second line the moment it doesn't fit
          (wrapping is decided before shrinking), which is what it did. At flex-basis 0 it
          claims the leftover and ellipsises instead, so a long version string can never push
          it onto a line of its own. `flexWrap` stays as the guard for a seventh ICON. */}
      <div style={{
        padding: '6px 6px 10px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 5,
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        {/* All footer icons share one 14px box (viewBox 16, stroke 1.1) and the
            same button padding; spacing comes from the row's `gap` alone, so they
            read as a single uniform set. The gear keeps viewBox 24 with a
            proportional stroke (1.6/24 ≈ 1.1/16). `flexShrink: 0` on each keeps them
            square — a squashed icon box is worse than a wrapped row. */}
        {/* No "open another folder" here any more: opening a folder REGISTERS A PROJECT, which
            is project navigation, and that now lives at the rail's foot beside "All projects".
            Two identical + buttons 44px apart is how you get one that nobody trusts. */}
        <button
          onClick={onOpenAgents}
          style={{
            background: agentsViewActive ? 'var(--overlay-subtle)' : 'none',
            border: 'none', cursor: 'pointer',
            padding: '3px 4px', borderRadius: 8, flexShrink: 0,
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
            padding: '3px 4px', borderRadius: 8, flexShrink: 0,
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
            padding: '3px 4px', borderRadius: 8, flexShrink: 0,
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
            padding: '3px 4px', borderRadius: 8, flexShrink: 0,
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
            padding: '3px 4px', borderRadius: 8, flexShrink: 0,
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

        {/* The app's identity, on the app's row. It used to head a stats line of its own,
            which paired it with a count that belongs to the project — two different scopes on
            one line, 40px above a section about other projects entirely. */}
        <span
          data-sidebar-identity
          title={`Operator${version ? ` v${version}` : ''}`}
          style={{
            flex: '1 1 0', minWidth: 0, textAlign: 'right',
            fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
            fontVariantNumeric: 'tabular-nums',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {version ? `v${version}` : 'Operator'}
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
