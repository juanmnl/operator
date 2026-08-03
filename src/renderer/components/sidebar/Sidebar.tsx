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
  /** Open THIS project's home (the board) — the project header row. */
  onOpenProjectHome: () => void
  /** Open THIS project's home on the TEAM tab — the roster. The section's `+` and the
   *  empty-state control both name the roster, so they land on the roster. */
  onOpenProjectTeam: () => void
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
  globalPrefsActive, prefsViewActive, projectHomeActive,
  effortLevels, fanInfo, shortcutIndices, stats, isDark,
  onRestoreProject,
  onOpenProjectHome, onOpenProjectTeam, onSelectSession, onRenameSession, onCloseSession,
  onLaunchRole, accentOf, onPickAccent, onReorderSession, onReorderLane,
  onOpenFolderPrefs, onOpenGlobalPrefs, onOpenPrefs,
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
  // Header hover in STATE, not an inline style written on mouseenter. Clicking the header
  // navigates, which makes it inert — but the cursor is still sitting on it, so no mouseleave
  // ever fires and a hand-written background would stay lit on a control that no longer
  // exists. Deriving it at render means the state change clears it.
  const [headerHover, setHeaderHover] = useState(false)
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
      {/* Header = IDENTITY, and — from inside an agent — the way back to it. It is NOT a
          switcher: moving BETWEEN projects is the rail's job (a tile per open project, "All
          projects" and "Open folder" at its foot), and it does that job in every state
          including the gallery, where this sidebar isn't rendered at all.
          It used to be inert on the reasoning that navigation was entirely the rail's. That
          was wrong for this one control: the name already turns accent when Project Home is
          on screen, and a thing that changes colour to say "this place is showing" is
          claiming to be the control for that place. It read as a live target and did
          nothing — reported three times as "clicking the project doesn't navigate", each
          time fixed on the rail instead. The rail tile being a second way home doesn't
          excuse the first one being dead.
          The top padding clears the traffic lights and stays bare titlebar, so the window is
          still draggable from up there. */}
      <DragRegion style={{ paddingTop: 40, padding: '40px 10px 8px 12px' }}>
        {/* NAME AND PATH ARE ONE TARGET. The path was a sibling outside the row, which would
            have made the header half-live: the biggest, most obvious "go back to the project"
            block on screen, with a dead strip along its bottom edge — the same class of bug
            one line smaller. They are one identity, so they are one hit area.
            role="button" rather than <button> because the archived `previous` chip is a real
            button that lives INSIDE this row, and a nested <button> is invalid HTML. The role
            earns its keep twice: DragRegion skips a window drag when the press lands on
            `[role="button"]` (:30), so declaring the role is what stops this click being eaten
            as a titlebar drag. `WebkitAppRegion: no-drag` does NOT do that — we drive the drag
            from JS, and that handler never reads the app region.
            AT HOME IT IS NOT A CONTROL AT ALL: no role, no tabIndex, no hover, no pointer —
            going home from home isn't navigation, matching the rail tile's rule
            (DashboardView.tsx:3011). Dropping the role also hands the strip back to the window
            drag, which is what it was before it was ever a target. */}
        <div
          data-sidebar-project
          role={projectHomeActive ? undefined : 'button'}
          tabIndex={projectHomeActive ? undefined : 0}
          aria-label={projectHomeActive ? undefined : `Open ${project?.name ?? 'project'} home`}
          title={projectHomeActive ? undefined : `Open ${project?.name ?? 'the project'} — the project board`}
          onClick={projectHomeActive ? undefined : onOpenProjectHome}
          onKeyDown={projectHomeActive ? undefined : (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenProjectHome() }
          }}
          onMouseEnter={() => setHeaderHover(true)}
          onMouseLeave={() => setHeaderHover(false)}
          style={{
            width: '100%', padding: '3px 4px',
            background: !projectHomeActive && headerHover ? 'var(--overlay-subtle)' : 'transparent',
            borderRadius: 'var(--radius-sm)',
            cursor: projectHomeActive ? undefined : 'pointer',
            outline: 'none',
            transition: 'background 120ms ease',
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'no-drag',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 22 }}>
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
                "folder not on record" chip: transparent, hairline, tracked.
                It sits inside the header target now, so it stops its own click: un-shelving is
                not a request to navigate. */}
            {project?.archivedAt && (
              <button
                data-previous-chip
                onClick={(e) => { e.stopPropagation(); onRestoreProject?.(project.id) }}
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
                padding: '2px 0 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {tildePath(project.path)}
            </div>
          )}
        </div>
      </DragRegion>

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
        {/* The roster is the TEAM tab. This `+` called `onOpenProjectHome`, which hard-sets
            the BOARD tab — the label named one place and the wiring went to another. The
            label was right; the wiring is what moved. */}
        <button
          onClick={onOpenProjectTeam}
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
            surface that owns adding a lane — the roster (the TEAM tab), where the templates live. The
            sidebar deliberately does NOT duplicate the preset menu: one way to add a lane. */}
        {laneRows.length === 0 && adHocRows.length === 0 && (
          <div data-sidebar-no-lanes style={{ padding: '4px 8px 0' }}>
            <p style={{ fontSize: 11, color: 'color-mix(in srgb, var(--fg) 72%, transparent)', lineHeight: 1.5, margin: '0 0 8px' }}>
              No agents yet. An agent is a lane on this project — its own model, effort and brief.
            </p>
            <button
              onClick={onOpenProjectTeam}
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
          This row and the ProjectRail's foot are ONE cluster: they meet at the bottom-left
          corner, 1px apart across the sidebar's left hairline, and both bottom out at the same
          y. So they share one spec — 26x26 box, radius 7, 14px ink, `--fg-muted` at rest, and
          the same hover — via FootButton below. They used to differ on every one of those
          (22x20 box, radius 8, 13 vs 14 ink, and no hover at all on this side), which put the
          two rows' glyphs on baselines 3px apart and left half the corner dead to the pointer.
          Sized to FIT: n icons + gaps + padding must stay inside the 220px sidebar, or the
          wrapper's overflow:hidden slices the last one in half at the edge (that's what it did
          with seven — the theme toggle was cut down the middle). At the shared 26px box: four
          icons + three 5px gaps + 16px padding = 135, leaving 85px for the version — still
          comfortably past the widest string we'd plausibly ship ("v0.10.11" needs 56px at 9.5
          mono). Growing the box did not cost the version anything, because the icons that were
          squeezed to 20px wide are only four now, not six.
          Padding is 10 LEFT / 6 RIGHT on purpose, and it is alignment rather than a typo: at
          10 the first icon's ink lands on x=68, the exact column the lane orbs above it sit on
          (align ink, not boxes — the old 6 put the footer 6px left of its own column). The
          right stays on the sidebar's outer inset, which is what the version belongs to.
          The version takes `flex: 1 1 0` rather than `marginLeft: auto` deliberately: with
          `flexWrap` on, an auto-margined item WRAPS to a second line the moment it doesn't fit
          (wrapping is decided before shrinking), which is what it did. At flex-basis 0 it
          claims the leftover and ellipsises instead, so a long version string can never push
          it onto a line of its own. `flexWrap` stays as the guard for a fifth ICON. */}
      <div style={{
        padding: '6px 6px 10px 10px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 5,
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        {/* All footer icons share one 14px ink box (viewBox 16, stroke 1.2) inside FootButton's
            26px square; spacing comes from the row's `gap` alone, so they read as a single
            uniform set — and as the same set as the rail's foot. The gear keeps viewBox 24 with
            a proportional stroke (1.8/24 = 1.2/16). Every stroke is `currentColor`: they used
            to be hardcoded `var(--fg-muted)`, which is precisely why these four could not
            answer hover while the three beside them could. */}
        {/* No "open another folder" here any more: opening a folder REGISTERS A PROJECT, which
            is project navigation, and that now lives at the rail's foot beside "All projects".
            Two identical + buttons 44px apart is how you get one that nobody trusts.
            NOR the Agents hub, for a stronger version of the same reason: AgentsHubView iterates
            every project, so it never belonged in a sidebar whose job is THIS project — and this
            strip animates to width 0 at the gallery, which is precisely where you'd reach for a
            cross-project view. It is at the rail's foot, which is present in every state. */}
        {/* This project's Claude files (.claude) — was the per-group prefs button. */}
        <FootButton
          onClick={() => project && onOpenFolderPrefs(project.path, project.name)}
          disabled={!project?.path}
          active={!!activeFolderPrefs && activeFolderPrefs === project?.path}
          label={project ? `${project.name} Claude files (.claude)` : 'Project Claude files'}
        >
          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" strokeLinejoin="round" />
        </FootButton>
        <FootButton
          onClick={onOpenGlobalPrefs}
          active={globalPrefsActive}
          label="Global Claude files (~/.claude)"
        >
          <circle cx="8" cy="8" r="6" />
          <ellipse cx="8" cy="8" rx="2.5" ry="6" />
          <path d="M2 8h12" />
        </FootButton>
        {/* Settings (Operator preferences) — sits in the bottom row, just before the theme toggle. */}
        <FootButton
          onClick={onOpenPrefs}
          active={prefsViewActive}
          label="Operator preferences"
          viewBox="0 0 24 24"
          strokeWidth={1.8}
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </FootButton>
        {/* Theme toggle — last icon in the bottom row, after settings. */}
        <FootButton
          onClick={onToggleTheme}
          label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? (
            <>
              {/* Filled core so the sun reads distinct from the (hollow-centred) gear beside it.
                  It fills with currentColor, so it tracks the hover like every stroke here. */}
              <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />
              <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.7 3.7l1 1M11.3 11.3l1 1M3.7 12.3l1-1M11.3 4.7l1-1" strokeLinecap="round" />
            </>
          ) : (
            <path d="M13.5 9.5a5.5 5.5 0 0 1-7-7A5.5 5.5 0 1 0 13.5 9.5Z" />
          )}
        </FootButton>

        {/* The app's identity, on the app's row. It used to head a stats line of its own,
            which paired it with a count that belongs to the project — two different scopes on
            one line, 40px above a section about other projects entirely.
            It also used to be RIGHT-aligned, which parked it against the far edge of a 220px row
            while four small icons huddled at the left, with ~90px of dead space between them and
            nothing to justify it. The row is one thing — the app's tools, then the app's name —
            so it now reads as one left-anchored cluster and the slack falls at the outer edge.
            THE OBVIOUS FIX IS A TRAP. Making this `flex: '0 1 auto'` (or `marginLeft: auto`)
            reintroduces the exact bug the comment above documents: with `flexWrap` on, wrapping
            is decided BEFORE shrinking, so a basis of `auto` puts a long version string on a line
            of its own the moment it doesn't fit. The basis has to stay 0. So the BOX still claims
            all the leftover — it just no longer pushes its text to the far side of itself. The
            dead space is still there; it is simply outboard of the content now instead of
            splitting it in half. */}
        <div style={{
          flex: '1 1 0', minWidth: 0, marginLeft: 4,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span
            data-sidebar-identity
            title={`Operator${version ? ` v${version}` : ''}`}
            style={{
              minWidth: 0,
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
    </div>
  )
}

/** One control in the sidebar's footer row — deliberately the SAME shape as ProjectRail's
 *  `RailFootButton`, because the two rows meet at the bottom-left corner and a user reads them
 *  as one L of app chrome. 26x26 box, radius 7, 14px ink, `--fg-muted` at rest, background +
 *  ink lifting together on hover. Keep the two in step; if one moves, move both.
 *
 *  No `opacity` anywhere: `--fg-muted` IS the recede, and multiplying it (this row used to sit
 *  at 0.85, and 0.35 when disabled) lands at 1.8–2.9:1 on the three light palettes — decoration
 *  rather than a control. Disabled recedes by mixing toward the sidebar's own background, which
 *  is a real colour that stays measurable, and by going inert to the pointer. 65% is measured,
 *  not guessed: it holds 2.22–3.92:1 across all six palettes (`dev/drive-corner-balance.mjs`),
 *  a clear step below the 3.80–7.38:1 of rest without dropping out of sight the way 0.35 did.
 *
 *  Background-only for the active state, per the rail's note: a colour-changing border on a
 *  radiused element re-rasterizes in WKWebView. */
function FootButton({ onClick, label, active, disabled, viewBox = '0 0 16 16', strokeWidth = 1.2, children }: {
  onClick: () => void
  label: string
  active?: boolean
  disabled?: boolean
  /** 24 for the gear, which is drawn at that scale; its stroke is scaled to match (1.8/24 = 1.2/16). */
  viewBox?: string
  strokeWidth?: number
  children: React.ReactNode
}) {
  const rest = active ? 'var(--overlay-subtle)' : 'transparent'
  const ink = disabled
    ? 'color-mix(in srgb, var(--fg-muted) 65%, var(--bg-sidebar))'
    : active ? 'var(--fg)' : 'var(--fg-muted)'
  return (
    <button
      data-sidebar-foot-btn
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-current={active || undefined}
      style={{
        width: 26, height: 26, padding: 0, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: rest, border: 'none', borderRadius: 7,
        color: ink, cursor: disabled ? 'default' : 'pointer', outline: 'none',
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => { if (disabled) return; e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
      onMouseLeave={(e) => { if (disabled) return; e.currentTarget.style.background = rest; e.currentTarget.style.color = ink }}
    >
      <svg width="14" height="14" viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
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
