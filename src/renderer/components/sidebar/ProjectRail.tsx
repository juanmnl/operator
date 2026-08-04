import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSession, Project, Role } from '../../../shared/types'
import { StatusWave, type WaveStatus } from './StatusWave'
import { SessionItem } from './SessionItem'
import { DragRegion } from '../DragRegion'
import { projectActivityLabel, type ProjectActivity } from '../../lib/project-status'
import { byRailOrder } from '../../lib/project-shelf'
import { projectAccent } from '../../lib/project-accent'
import { laneTextColor } from '../../lib/lane-color'
import { useHoverCard } from '../../lib/use-hover-card'
import { sessionLabel } from '../../lib/session-label'
import { currentTaskOf } from '../../lib/session-task'
import { tildePath } from '../../lib/format'
import { PlanMeter, usePlanLimits } from './PlanMeter'

// THE LEFT SURFACE. One component, two widths — there is no rail and no panel any more.
//
// The duplication that kept coming back (an agent listed in the rail AND in the sidebar beside
// it, 40px apart) was never a rule two files failed to keep; it was two files each deciding, on
// their own, to list agents. `Sidebar.tsx` and `SidebarRail.tsx` are deleted, and this renders the
// one list at 60px or at 264px. Collapsed and expanded are mutually exclusive states of ONE
// element, so "a project's agents appear exactly once" holds by construction rather than by
// discipline.
//
// THE MEMBERSHIP RULE, and it is the whole design:
//
//   A project group shows what is LIVE in it. EVERY group, including the open one.
//
// applied identically at both widths — live agents are orbs at 60 and rows at 264. The rule used
// to have a second half ("the open group additionally shows its whole team"), and it is withdrawn:
// five IDLE rows under one live agent is a roster, and the strip is a picture of WORK. The strip
// therefore says the same thing at both widths and in every group, which is the shortest the rule
// has ever been.
//
// An idle row was doing double duty, though — it was also how you LAUNCHED that lane — so
// `+ Start an agent` inherits that job rather than letting it vanish with the rows: it opens the
// roster's idle lanes and picking one launches it, exactly as clicking the row did.
//
// A project is in the strip if `live > 0` or it is the open one. NOT the whole active shelf —
// that is 20 projects here, because nothing has ever been archived, and it is what put every
// project you have ever touched in a strip meant for the ones you are working in. An archived
// project still appears if something is live in it: a running agent is never hidden.
//
// THE GRAMMAR IS KIND, NOT SHAPE. A header is a WORD (the project's name, in the project's
// accent); a member is an ORB. Text against disc is a stronger separation than the old square
// against circle — you cannot mistake a word for a dot — and it survives at both widths. The
// acronym tiles are gone with `ProjectTile`: two letters could not separate fastrack /
// Fastrack-landing / FastTrack, and the colour hash serves four projects at once, so the tile was
// carrying an identity it did not have. A name does.

/** The ELEMENT is 60. The STRIP YOU SEE is 68, and that is the number the traffic lights fix.
 *
 *  `DashboardView`'s root pads 8px and paints it `--bg-sidebar` — the same colour this paints —
 *  so the rail's box does not start at the window edge but the visible strip does. Balance the
 *  cluster in what a person can see, not in the element:
 *
 *      close 8.0–19.5 · min 28.0–39.5 · zoom 48.0–59.75   (macOS defaults, measured on screen)
 *      cluster = 51.75 wide → visible strip = 8 + 51.75 + 8 = 67.75 → 68 → element 68 − 8 = 60
 *
 *  MEASURED OFF THE SIGNED BUNDLE, and that matters: `target/debug/operator` has no Info.plist,
 *  so macOS 26 draws it LARGER traffic lights than the bundle's (which declares
 *  LSMinimumSystemVersion 10.15). The strip looks cramped in a dev build and is correct in the
 *  app people run. Do not retune these numbers from a `tauri dev` screenshot. */
const RAIL_W = 60
/** Expanded. Forced by the constant-x invariant below, not chosen: the orb column has to be
 *  2 × the axis, so the axis can stay put when the width changes. */
const RAIL_W_OPEN = 264
/** ZERO. There is nothing left for the content to be inset FROM.
 *
 *  This was 8 while the rail had a right-hand seam: the visible column ended at that line, so the
 *  field had to stop short of it. Deleting the seam moved the boundary and the inset was never
 *  re-derived — which is a sequencing artifact, and the exact mistake this file's header warns
 *  about: measuring to the element's box instead of to the column a person can see.
 *
 *      window edge 0 │ root pad 8 │ rail element 8→68 │ gap 8 │ card edge 76
 *
 *  Both fields are painted `--bg-sidebar`, the rail's own colour, and the rail draws no edge on
 *  either side — so the column runs 0 → 76 and its centre is 38. With an 8px inset the content
 *  centred on 34, i.e. 4px left of the middle of what you see, which is what the user reported as
 *  "not optically centred". At 0 the element's own midpoint IS the optical centre. */
const CONTENT_INSET_R = 0
/** The optical axis: 30 element-local = **38 from the window edge** = the centre of the visible
 *  column, window edge to card edge. The second number is the one that matters — a driver that
 *  only checks the elements agree with each other at 30 would have passed the 34 too. */
const AXIS = (RAIL_W - CONTENT_INSET_R) / 2
/** A member's hit box — the orb's 24px disc inside it, and `+ Add an agent` and Home on the same
 *  box, so every clickable thing in the strip is one column at one x. */
const MEMBER_BOX = 36
/** THE CONSTANT-X INVARIANT, and it is not negotiable: an orb sits at the same absolute x, at the
 *  same size, collapsed and expanded. `AXIS − MEMBER_BOX / 2` = 12 either way — so the 264 orb
 *  column is 60 (2 × 30) and expanding fades a label in to the orb's right and MOVES NOTHING. A transition where the thing you are looking
 *  at slides sideways reads as a re-layout instead of a reveal. */
const MEMBER_INSET_L = AXIS - MEMBER_BOX / 2
const ORB = 24
/** Foot glyph box. 24 at a 4px gap was derived when the collapsed field was 52 (24 + 4 + 24 = 52,
 *  exactly): it FIT, and the fit is what set it. The field is 60 now, so nothing forces 24 any
 *  more — deliberately left alone in this pass rather than drifting; see the RESULT for what it
 *  would become if re-derived. What the wider field does buy is that the pair no longer has to be
 *  flush: `FOOT_PAD` centres it under the member column. */
const FOOT_BOX = 24
const FOOT_GAP = 4
/** (60 − (24 + 4 + 24)) / 2 = 4. The foot pair straddles the axis instead of hugging the left
 *  edge — and the SAME padding applies at 264, so the left glyph column holds its x across ⌘B
 *  just as the orb column does. The foot keeps its own rhythm (it is not on the member column,
 *  by design), but it must not MOVE. */
const FOOT_PAD = (RAIL_W - (FOOT_BOX * 2 + FOOT_GAP)) / 2

/** The ink for the horizontal group hairlines and the foot's three dividers — ALL that is left of
 *  the seam.
 *
 *  The vertical rule against the sidebar is gone with the sidebar. Its whole justification was
 *  that "the rail and the sidebar are the SAME colour… there is no surface change backing this
 *  line up": the right-hand neighbour is now 8px of window field and then an elevated card with
 *  its own edge and drop shadow, which is a surface change and a strong one. `--border` mixed
 *  toward transparent rather than replaced by a hex, so the token stays the source. */
const SEAM = 'color-mix(in srgb, var(--border) 60%, transparent)'

/** Cross-fade for everything that exists only at 264. Half the width transition, so a label is
 *  gone well before the strip is narrow enough to clip it. */
const REVEAL = 'opacity 120ms ease'

export interface ProjectRailProps {
  /** ⌘B, and forced true at the gallery. The width IS the state; nothing unmounts. */
  collapsed: boolean
  projects: Project[]
  activities: Record<string, ProjectActivity>
  /** Null at the gallery — no group is open, so no group shows its idle lanes. */
  activeProjectId: string | null
  onOpenProject: (projectId: string) => void
  /** The open project's Home row — the board. */
  onOpenProjectHome: () => void
  /** True while Project Home is the content area, so Home reads as current. */
  projectHomeActive: boolean
  onShowGallery: () => void
  onOpenFolder: () => void
  onOpenAgents: () => void
  agentsActive?: boolean
  onReorder?: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
  /** Right-click a header. The strip REPORTS the anchor and nothing else: it is a clipping
   *  scroller at the window's edge, so a menu parented to a row would be cut off at 60. */
  onTileMenu?: (projectId: string, anchor: { top: number; left: number }) => void
  menuProjectId?: string | null
  /** EVERY live session, across every project — the strip groups them itself. It used to be
   *  handed only the active project's, which is why cross-project membership had to be faked by
   *  a second component. */
  sessions?: AgentSession[]
  activeSessionId?: string | null
  onSelectSession?: (session: AgentSession) => void
  accentOf?: (session: AgentSession) => string | undefined
  onPickAccent?: (session: AgentSession, anchor: { top: number; left: number }) => void
  /** Un-shelve the open project — the `previous` chip, expanded only. */
  onRestoreProject?: (projectId: string) => void
  customNames?: Record<string, string>
  effortLevels?: Record<string, string>
  fanInfo?: Record<string, { index: number; total: number }>
  shortcutIndices?: Record<string, number>
  onRenameSession?: (sessionId: string, name: string) => void
  onCloseSession?: (session: AgentSession) => void
  /** The `+` row's menu — this project's idle lanes, plus "add one". Reported as an ANCHOR and
   *  rendered by the view, like every other menu here: the strip is a clipping scroller at the
   *  window's edge, so a popover parented to a row would be cut off at 60. */
  onAgentMenu?: (projectId: string, anchor: { top: number; left: number }) => void
  onAddLane?: () => void
  /** Reorder two AD-HOC session rows. Lane rows are ordered by the roster instead. */
  onReorderSession?: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
  /** The app's own row, at the foot — present in BOTH states. ⌘B used to unmount `Sidebar.tsx`
   *  and take the theme toggle, Preferences and both `.claude` shortcuts off screen with it. */
  activeFolderPrefs?: string | null
  globalPrefsActive?: boolean
  prefsViewActive?: boolean
  isDark?: boolean
  onOpenFolderPrefs?: (projectPath: string, projectName: string) => void
  onOpenGlobalPrefs?: () => void
  onOpenPrefs?: () => void
  onToggleTheme?: () => void
  version?: string
  update?: { version: string } | null
  onInstallUpdate?: () => void
}

export function ProjectRail({
  collapsed, projects, activities, activeProjectId,
  onOpenProject, onOpenProjectHome, projectHomeActive,
  onShowGallery, onOpenFolder, onOpenAgents, agentsActive,
  onReorder, onTileMenu, menuProjectId,
  sessions = [], activeSessionId, onSelectSession, accentOf, onPickAccent,
  onRestoreProject, customNames = {}, effortLevels = {}, fanInfo = {}, shortcutIndices = {},
  onRenameSession, onCloseSession, onAgentMenu, onAddLane, onReorderSession,
  activeFolderPrefs, globalPrefsActive, prefsViewActive, isDark,
  onOpenFolderPrefs, onOpenGlobalPrefs, onOpenPrefs, onToggleTheme,
  version, update, onInstallUpdate,
}: ProjectRailProps) {
  const planLimits = usePlanLimits()
  const [drag, setDrag] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  // `onDragOver` fires on a DIFFERENT element than the one that started the drag, and reading
  // React state there can lag a frame behind on a fast drag.
  const dragRef = useRef<string | null>(null)
  const expanded = !collapsed

  // THE USER'S ORDER, not a computed one. An activity comparator recomputed on every change
  // cannot coexist with dragging — it undoes the drag the moment an agent starts or stops, which
  // is the worst kind of "it didn't save", because it does save and is then overwritten.
  const shown = projects
    .filter((p) => (activities[p.id]?.live ?? 0) > 0 || p.id === activeProjectId)
    .sort(byRailOrder)
  const canReorder = !!onReorder && shown.length > 1
  const endDrag = () => { dragRef.current = null; setDrag(null); setDropAt(null) }

  const liveOf = (projectId: string) => sessions.filter((s) => s.projectId === projectId && s.status !== 'ended')

  /** How many orbs a collapsed group shows before folding the rest into a count. Four is what
   *  keeps a group bounded, which is why the projects around the open one stay on screen. */
  const FOLD = 4

  // BRING THE OPEN GROUP INTO VIEW — by moving the VIEWPORT, never the list. The group stays at
  // its own `railOrder` index; selecting a project must not reorder anything.
  const openRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = openRef.current
    const box = scrollerRef.current
    if (!el || !box) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (bottom > box.scrollTop + box.clientHeight) {
      box.scrollTop = el.offsetHeight > box.clientHeight ? top : bottom - box.clientHeight
    } else if (top < box.scrollTop) {
      box.scrollTop = top
    }
  }, [activeProjectId, collapsed, sessions.length])

  return (
    <div data-rail data-rail-collapsed={collapsed ? '' : undefined} style={{
      width: collapsed ? RAIL_W : RAIL_W_OPEN,
      flexShrink: 0, height: '100%',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-sidebar)',
      // NO RULE ON EITHER EDGE, IN ANY STATE. The left never had one (the window pad paints this
      // same colour, so the strip dissolves into the window); the right one is deleted with the
      // panel it was separating. The surviving vertical line in this corner of the app is the
      // content card's, and it begins below the drag band.
      boxSizing: 'border-box', userSelect: 'none', overflow: 'hidden',
      transition: 'width 260ms cubic-bezier(0.4, 0, 0.2, 1)',
    }}>
      {/* The strip is the leftmost thing on screen, so IT hosts the macOS traffic lights: 40px of
          bare titlebar, still draggable, nothing drawn in it. */}
      <DragRegion style={{ paddingTop: 40, width: '100%', flexShrink: 0 }} />

      <div
        ref={scrollerRef}
        className="scroll-hidden"
        style={{
          flex: 1, minHeight: 0, width: '100%', overflowY: 'auto', overflowX: 'hidden',
          boxSizing: 'border-box',
          // POSITIONED, so it is the groups' `offsetParent` and `offsetTop` below is measured
          // against the scroll box. Without this, `offsetTop` walks up to whatever ancestor
          // happens to be positioned and the scroll-into-view lands somewhere else entirely —
          // which top-aligned a tall group PAST its own header, i.e. scrolled the name of the
          // thing you just opened off the screen.
          position: 'relative',
          display: 'flex', flexDirection: 'column',
          // The field IS the element: no inset on either side, so the member column sits on the
          // element's own midpoint, which is the middle of what a person sees.
          padding: `6px ${CONTENT_INSET_R}px 6px 0`,
        }}
      >
        {shown.map((p, i) => {
          const edge = dropAt?.id === p.id ? dropAt.edge : null
          const open = p.id === activeProjectId
          const live = liveOf(p.id)
          const shownLive = collapsed ? live.slice(0, FOLD) : live
          const folded = collapsed ? Math.max(0, live.length - FOLD) : 0
          const roster = p.roster ?? []
          const liveRoles = new Set(live.map((s) => s.roleId).filter(Boolean))
          // Not rendered as rows any more — only counted, to decide whether the row below offers
          // lanes to start or only offers to create one.
          const idleLanes = open ? roster.filter((r) => !liveRoles.has(r.id)) : []
          return (
            <div
              key={p.id}
              data-rail-group={p.id}
              ref={open ? openRef : undefined}
              style={{
                flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'column',
                // GROUPING IS PROXIMITY PLUS A HAIRLINE, never a tint and never a coloured
                // left-edge marker. It has to be colour-INDEPENDENT by construction: seven of
                // eleven project swatches carry duplicates, so two adjacent groups can be the
                // same colour, and the rhythm is what must keep them apart.
                ...(i > 0 ? { marginTop: 6, paddingTop: 6, boxShadow: `inset 0 1px 0 ${SEAM}` } : null),
                // Constant transparent borders so the drop line can never shift the stack.
                borderTop: `2px solid ${edge === 'before' ? 'var(--accent)' : 'transparent'}`,
                borderBottom: `2px solid ${edge === 'after' ? 'var(--accent)' : 'transparent'}`,
              }}
              onDragOver={(e) => {
                const d = dragRef.current
                if (!d || d === p.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const r = e.currentTarget.getBoundingClientRect()
                const next: 'before' | 'after' = e.clientY - r.top < r.height / 2 ? 'before' : 'after'
                setDropAt((cur) => (cur?.id === p.id && cur.edge === next ? cur : { id: p.id, edge: next }))
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                setDropAt((cur) => (cur?.id === p.id ? null : cur))
              }}
              onDrop={(e) => {
                e.preventDefault()
                const d = dragRef.current
                // Read the edge off the EVENT: on a fast drag the state may not have committed,
                // and a drop with no line drawn must still land under the cursor.
                if (d && d !== p.id) {
                  const r = e.currentTarget.getBoundingClientRect()
                  onReorder?.(d, p.id, e.clientY - r.top < r.height / 2 ? 'before' : 'after')
                }
                endDrag()
              }}
            >
              <GroupHeader
                project={p}
                activity={activities[p.id] ?? { live: 0, waiting: 0, lanes: p.roster?.length ?? 0, status: 'idle' }}
                open={open}
                collapsed={collapsed}
                dragging={drag === p.id}
                draggable={canReorder}
                onDragStart={() => { dragRef.current = p.id; setDrag(p.id) }}
                onDragEnd={endDrag}
                onOpen={() => onOpenProject(p.id)}
                onMenu={onTileMenu && ((anchor) => onTileMenu(p.id, anchor))}
                menuOpen={menuProjectId === p.id}
                onRestore={onRestoreProject && (() => onRestoreProject(p.id))}
              />

              {/* HOME, iff nothing is live here. It is a place, not an agent — so it never
                  animates, never takes a lane accent, and carries no count. It replaces the
                  empty-group dash: both render on the identical predicate, so this adds one
                  state and removes one rather than adding two.
                  The launching agent takes the row Home was in — both are MEMBER_BOX high in the
                  member column — so starting work does not lift the group by a row. */}
              {live.length === 0 && (
                <HomeRow
                  collapsed={collapsed}
                  current={open && projectHomeActive}
                  onClick={() => (open ? onOpenProjectHome() : onOpenProject(p.id))}
                />
              )}

              {collapsed
                ? shownLive.map((s) => (
                  <RailOrb
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    accent={accentOf?.(s)}
                    onSelect={() => onSelectSession?.(s)}
                    onPickAccent={onPickAccent}
                  />
                ))
                : shownLive.map((s) => (
                  <MemberRow
                    key={s.id}
                    session={s}
                    // Ad-hoc launches carry no lane, so nothing else orders them — dragging is
                    // the only handle they have. Lane rows are ordered by the ROSTER, and there
                    // is no sensible merge of the two, so a drag only means something between
                    // rows of the same kind.
                    reorderable={!s.roleId && !!onReorderSession}
                    onReorderSession={onReorderSession}
                    project={p}
                    role={roster.find((r) => r.id === s.roleId)}
                    active={s.id === activeSessionId}
                    accent={accentOf?.(s)}
                    customName={customNames[s.id]}
                    effortLevel={s.terminalId ? effortLevels[s.terminalId] : null}
                    fan={s.terminalId ? fanInfo[s.terminalId] : undefined}
                    shortcutIndex={open ? shortcutIndices[s.id] ?? null : null}
                    onSelect={() => onSelectSession?.(s)}
                    onRename={(name) => onRenameSession?.(s.id, name)}
                    onClose={() => onCloseSession?.(s)}
                    onPickAccent={onPickAccent && ((anchor) => onPickAccent(s, anchor))}
                  />
                ))}

              {folded > 0 && (
                /* Counted, never silently dropped. */
                <button
                  data-rail-fold={folded}
                  onClick={() => onOpenProject(p.id)}
                  title={`${folded} more agent${folded === 1 ? '' : 's'} — open the project`}
                  style={{
                    flexShrink: 0, width: '100%', height: 18, padding: 0,
                    background: 'transparent', border: 'none',
                    color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
                    fontFamily: 'var(--font-mono)', fontSize: 9.5, lineHeight: 1,
                    textAlign: 'center',
                  }}
                >+{folded}</button>
              )}

              {expanded && open && (onAddLane || onAgentMenu) && (
                /* INSIDE the group, so it plainly adds to THIS project — which the
                   header-adjacent `+` never quite did.
                   TWO VERBS, NEVER SHARING A GLYPH: this opens a MENU that names both, rather
                   than being one control that guesses. With lanes waiting it reads "Start an
                   agent" and lists them; with none it reads "Add an agent" and goes straight to
                   the roster, because a menu holding a single item is a dialog box for nothing.
                   Each label is exactly true of what pressing it does. */
                <button
                  data-rail-add-lane
                  data-rail-idle-lanes={idleLanes.length}
                  onClick={(e) => {
                    if (idleLanes.length && onAgentMenu) {
                      const r = e.currentTarget.getBoundingClientRect()
                      onAgentMenu(p.id, { top: r.top, left: r.right + 8 })
                    } else onAddLane?.()
                  }}
                  title={idleLanes.length ? 'Start one of this project’s agents, or add a new one' : 'Add or edit lanes on the roster'}
                  aria-label={idleLanes.length ? 'Start an agent' : 'Add an agent on the roster'}
                  style={{
                    flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    height: MEMBER_BOX, padding: `0 8px 0 ${MEMBER_INSET_L}px`, boxSizing: 'border-box',
                    background: 'transparent', border: 'none', borderRadius: 8,
                    color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
                    fontFamily: 'var(--font-body)', fontSize: 11.5, textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-muted)' }}
                >
                  <span style={{ width: MEMBER_BOX, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span style={{ transition: REVEAL, whiteSpace: 'nowrap' }}>{idleLanes.length ? 'Start an agent' : 'Add an agent'}</span>
                </button>
              )}
            </div>
          )
        })}
      </div>

      <RailFoot
        collapsed={collapsed}
        planLimits={planLimits}
        agentsActive={agentsActive}
        onOpenAgents={onOpenAgents}
        onShowGallery={onShowGallery}
        onOpenFolder={onOpenFolder}
        project={projects.find((p) => p.id === activeProjectId) ?? null}
        activeFolderPrefs={activeFolderPrefs ?? null}
        globalPrefsActive={globalPrefsActive}
        prefsViewActive={prefsViewActive}
        isDark={!!isDark}
        onOpenFolderPrefs={onOpenFolderPrefs}
        onOpenGlobalPrefs={onOpenGlobalPrefs}
        onOpenPrefs={onOpenPrefs}
        onToggleTheme={onToggleTheme}
        version={version}
        update={update}
        onInstallUpdate={onInstallUpdate}
      />
    </div>
  )
}

/** The group's title — the project's NAME, in the project's accent, at both widths.
 *
 *  It is a 24px ROW, not a bare text node: a 9px line is an 11px click target, and the header
 *  inherits the tile's jobs — click to open, right-click for the menu, drag to reorder.
 *
 *  OPEN IS MARKED BY INK STRENGTH, not by a marker. Open = full `laneTextColor(accent)`; not open
 *  = the same hue mixed toward `--fg-muted`. Mixed, never `opacity` stacked on the token: the
 *  token IS the recede, and multiplying it lands at 1.8–2.9:1 on the three light palettes.
 *
 *  The name is rendered WHOLE and truncated by CSS. It used to be cut to six characters in JS,
 *  which is not a truncation but a hard clip — `OPERATOR` became `OPERAT`, indistinguishable from
 *  a project actually called that, and the `textOverflow: ellipsis` beneath it could never fire.
 *  At 60 every single-token name in the real store fits; only the hyphenated compounds ellipsise,
 *  and the hover card carries them whole. */
function GroupHeader({ project, activity, open, collapsed, draggable, dragging, onDragStart, onDragEnd, onOpen, onMenu, menuOpen, onRestore }: {
  project: Project
  activity: ProjectActivity
  open: boolean
  collapsed: boolean
  draggable?: boolean
  dragging?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  onOpen: () => void
  onMenu?: (anchor: { top: number; left: number }) => void
  menuOpen?: boolean
  onRestore?: () => void
}) {
  const [hover, setHover] = useState(false)
  const hoverCard = useHoverCard(`rail:${project.id}`)
  const label = projectActivityLabel(activity)
  const accent = projectAccent(project.id)
  const ink = laneTextColor(accent)
  return (
    <Fragment>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', flexShrink: 0 }}>
        <button
          ref={hoverCard.ref as React.RefObject<HTMLButtonElement>}
          data-rail-project-header={project.id}
          // `.ink-centred` (styles.css) — cancels the TRAILING letter-space, which a centred
          // tracked string carries on its right and nowhere else. Without it the painted ink of a
          // name sits up to 1.25px left of the axis while its line box is perfectly centred: the
          // same handle-versus-ink error this strip's whole harness exists to catch, and the same
          // fix the acronym tiles used before them.
          className={collapsed ? 'ink-centred' : undefined}
          // The identity colour, exposed so a harness can assert it never moves — it reaches the
          // DOM as a color-mix expression, so reading it back off one would compare encodings
          // rather than the value.
          data-rail-accent={accent}
          draggable={draggable}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            // The card is anchored to a row about to move out from under the cursor, and a drag
            // never fires the mouseleave that would close it.
            setHover(false)
            hoverCard.onMouseLeave()
            onDragStart?.()
          }}
          onDragEnd={onDragEnd}
          onClick={onOpen}
          onContextMenu={onMenu && ((e) => {
            // Or WKWebView draws its own menu on top of ours.
            e.preventDefault()
            e.stopPropagation()
            // The hover card is `position: fixed` exactly where the menu opens, and the cursor
            // never leaves the row, so no mouseleave arrives to clear it.
            setHover(false)
            hoverCard.dismiss()
            const r = e.currentTarget.getBoundingClientRect()
            onMenu({ top: r.top, left: r.right + 8 })
          })}
          aria-label={`${project.name}${label ? ` — ${label.text}` : ''}`}
          aria-current={open || undefined}
          title={`${project.name}${label ? ` — ${label.text}` : ''}`}
          style={{
            flex: 1, minWidth: 0, height: 24, boxSizing: 'border-box',
            // ZERO HORIZONTAL PADDING WHEN COLLAPSED. 4px each side takes the usable width to 44
            // and clips `operator` — caught by measurement, not by eye.
            padding: collapsed ? 0 : '0 8px',
            // A BLOCK, not a flex row. `text-overflow: ellipsis` applies to a block container's
            // inline content — inside a flex container the name is an anonymous flex item and the
            // ellipsis never fires, so an over-long name was clipped on BOTH sides instead
            // ("EL-ENCANTO" losing its E and "MISE-LANDING" losing its M). That is the same class
            // of defect as the six-character `shortNameOf` this replaces: a cut you cannot tell
            // from the project's real name. `lineHeight` does the vertical centring a flex row
            // would have.
            display: 'block', textAlign: collapsed ? 'center' : 'left', lineHeight: '24px',
            // Background-only hover on a radiused element — never a colour-changing border, which
            // re-rasterizes in WKWebView.
            background: hover || menuOpen ? 'var(--overlay-subtle)' : 'transparent',
            border: 'none', borderRadius: 6,
            color: open ? ink : `color-mix(in srgb, ${ink} 55%, var(--fg-muted))`,
            cursor: 'pointer', outline: 'none',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
            fontSize: collapsed ? 9 : 11,
            // `--track` feeds `.ink-centred`'s negative right margin, so the two can never drift.
            ['--track' as string]: collapsed ? '0.04em' : '0.06em',
            letterSpacing: collapsed ? '0.04em' : '0.06em',
            textTransform: 'uppercase',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            opacity: dragging ? 0.4 : 1,
            transition: 'background 120ms ease',
          }}
          onMouseEnter={(e) => { setHover(true); hoverCard.onMouseEnter(e) }}
          onMouseLeave={() => { setHover(false); hoverCard.onMouseLeave() }}
        >{project.name}</button>
        {/* You can browse into a shelved project from the gallery, and nothing in here used to say
            so. The chip is the state AND the way out of it. Expanded only: at 60 there is no room
            for a second thing on this row, and the hover card carries the state. */}
        {!collapsed && open && project.archivedAt && onRestore && (
          <button
            data-previous-chip
            className="sidebar-previous-chip"
            // EXPLICIT tabIndex on a <button>: WebKit leaves buttons out of sequential focus
            // navigation unless macOS Full Keyboard Access is on, and un-shelving is the one
            // thing in here that cannot be done from anywhere else in the project.
            tabIndex={0}
            onClick={onRestore}
            title={`${project.name} is shelved — click to bring it back to Active`}
            style={{
              flexShrink: 0, marginRight: 8, padding: '1px 6px',
              fontFamily: 'var(--font-mono)', fontSize: 9,
              textTransform: 'uppercase', letterSpacing: '0.1em',
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', color: 'var(--fg-muted)',
              cursor: 'pointer', outline: 'none',
            }}
          >previous</button>
        )}
      </div>
      {/* The path, under the OPEN group's name only, expanded only. Collapsed, the hover card
          carries it. */}
      {!collapsed && open && project.path && (
        <div data-rail-path style={{
          padding: '0 8px 2px', fontFamily: 'var(--font-mono)', fontSize: 9.5,
          color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{tildePath(project.path)}</div>
      )}
      {hoverCard.card && (
        <div style={{
          position: 'fixed', top: hoverCard.card.top, left: hoverCard.card.left, zIndex: 60,
          maxWidth: 260, padding: '7px 10px', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-surface)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.35), inset 0 0 0 1px color-mix(in srgb, var(--fg) 12%, transparent)',
          pointerEvents: 'none', fontFamily: 'var(--font-mono)', lineHeight: 1.35,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
            <span data-rail-card-name style={{ fontSize: 11.5, color: 'var(--fg)' }}>{project.name}</span>
            {label && (
              <span style={{
                fontSize: 9.5,
                color: label.accent ? 'color-mix(in srgb, var(--accent) 70%, var(--fg))' : 'var(--fg-muted)',
              }}>{label.text}</span>
            )}
          </div>
          {project.path && (
            <div style={{ fontSize: 9.5, color: 'var(--fg-muted)', marginTop: 2, whiteSpace: 'nowrap' }}>
              {tildePath(project.path)}
            </div>
          )}
        </div>
      )}
    </Fragment>
  )
}

/** THE DOOR TO THE BOARD, and a third kind of object: neither a header nor an agent.
 *
 *  Two independent channels say so. The MARK is a stroke outline — a framed column board, which
 *  is the board it opens — where a lane is a dot disc; and the LABEL is body sentence-case where
 *  a live lane is tracked mono uppercase. It never animates and never takes a lane accent,
 *  because it has no status: it is a place.
 *
 *  It sits in the member column, on the same axis and in the same 36px box as an orb, so the
 *  constant-x invariant is untouched — and so the agent that replaces it when work starts lands
 *  on exactly the row it vacated.
 *
 *  It carries NO COUNT, deliberately. The last count put into this strip (a roster chip that
 *  counted every status and labelled the total `N QUEUED`) was wrong for weeks and read as
 *  authoritative the whole time. A door is not a display. */
function HomeRow({ collapsed, current, onClick }: { collapsed: boolean; current: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      data-rail-home
      onClick={onClick}
      aria-current={current || undefined}
      title="Project Home — the board"
      aria-label="Project Home"
      style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        height: MEMBER_BOX, padding: `0 8px 0 ${MEMBER_INSET_L}px`, boxSizing: 'border-box',
        background: current ? 'var(--overlay-medium)' : hover ? 'var(--overlay-subtle)' : 'transparent',
        border: 'none', borderRadius: 8,
        color: current ? 'var(--fg)' : 'var(--fg-muted)',
        cursor: 'pointer', outline: 'none', textAlign: 'left',
        fontFamily: 'var(--font-body)', fontSize: 11.5, lineHeight: 1,
        transition: 'background 120ms ease',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span style={{ width: MEMBER_BOX, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        {/* 17px of ink, not the foot's 14: this sits alone against a 24px dot disc, and 14 reads
            small beside that mass. A framed column board — one outlined rect with two dividers.
            Checked against every other glyph in the chrome; the only near-collision is the foot's
            2×2 "all projects", and one frame against four separate squares separates cleanly. */}
        <svg data-rail-home-mark width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" />
          <path d="M6 2.6v10.8M10 2.6v10.8" />
        </svg>
      </span>
      {!collapsed && <span style={{ transition: REVEAL, whiteSpace: 'nowrap' }}>Home</span>}
    </button>
  )
}

/** One live agent, COLLAPSED. A 24px disc in the 36px member box, centred on the axis — the same
 *  disc, at the same x, that the expanded row carries. */
function RailOrb({ session, active, accent, onSelect, onPickAccent }: {
  session: AgentSession
  active: boolean
  accent?: string
  onSelect: () => void
  onPickAccent?: (session: AgentSession, anchor: { top: number; left: number }) => void
}) {
  const hoverCard = useHoverCard(`orb:${session.id}`)
  const label = sessionLabel({ session })
  const status = waveStatusOf(session)
  return (
    <Fragment>
      <button
        ref={hoverCard.ref as React.RefObject<HTMLButtonElement>}
        data-rail-session={session.id}
        onClick={onSelect}
        onContextMenu={onPickAccent && ((e) => {
          e.preventDefault()
          e.stopPropagation()
          hoverCard.dismiss() // it is `position: fixed` exactly where the popover opens
          const r = e.currentTarget.getBoundingClientRect()
          onPickAccent(session, { top: r.bottom + 6, left: r.right + 8 })
        })}
        aria-label={label}
        aria-current={active || undefined}
        title={label}
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', width: '100%',
          height: MEMBER_BOX, padding: `0 0 0 ${MEMBER_INSET_L}px`, boxSizing: 'border-box',
          background: 'transparent', border: 'none',
          cursor: 'pointer', outline: 'none',
        }}
        onMouseEnter={(e) => { hoverCard.onMouseEnter(e) }}
        onMouseLeave={() => { hoverCard.onMouseLeave() }}
      >
        <span style={{
          width: MEMBER_BOX, height: MEMBER_BOX,
          display: 'grid', placeItems: 'center', borderRadius: 10,
          // The active marker is background, never the 3px accent pill an earlier strip drew at
          // `left: -10` — that is a coloured left-edge marker stripe, which the house style
          // forbids outright.
          background: active ? 'var(--overlay-medium)' : 'transparent',
          transition: 'background 120ms ease',
        }}>
          {/* The hook is on the DISC, not on the tint box around it: the two states mark
              "selected" differently (a box here, a whole-row surface there), and a driver
              comparing the marker would be comparing markers rather than the orb the invariant
              is about. */}
          <span data-rail-orb={session.id} style={{ display: 'grid', placeItems: 'center' }}>
            <StatusWave status={status} seed={session.id} size={ORB} accent={accent} />
          </span>
        </span>
      </button>
      {hoverCard.card && (
        <div style={{
          position: 'fixed', top: hoverCard.card.top, left: hoverCard.card.left, zIndex: 60,
          maxWidth: 260, padding: '7px 10px', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-surface)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.35), inset 0 0 0 1px color-mix(in srgb, var(--fg) 12%, transparent)',
          pointerEvents: 'none', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.35,
          color: 'var(--fg)', whiteSpace: 'nowrap',
        }}>{label}</div>
      )}
    </Fragment>
  )
}

/** One live agent, EXPANDED — `SessionItem`, which was already the right object for this row and
 *  is the one thing the old sidebar had that survives whole. */
function MemberRow({ session, project, role, active, accent, customName, effortLevel, fan, shortcutIndex, reorderable, onReorderSession, onSelect, onRename, onClose, onPickAccent }: {
  session: AgentSession
  project: Project
  role?: Role
  active: boolean
  accent?: string
  customName?: string
  effortLevel?: string | null
  fan?: { index: number; total: number }
  shortcutIndex: number | null
  reorderable?: boolean
  onReorderSession?: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
  onSelect: () => void
  onRename: (name: string) => void
  onClose: () => void
  onPickAccent?: (anchor: { top: number; left: number }) => void
}) {
  const [edge, setEdge] = useState<'before' | 'after' | null>(null)
  const row = (
    <SessionItem
      session={session}
      label={sessionLabel({ session, role, customName, fallback: 'Session' })}
      active={active}
      effortLevel={effortLevel}
      // A lane keeps its role treatment (colour + tracked uppercase) even after a rename — the
      // name is the session's, the colour is the lane's.
      labelIsRole={!!role}
      roleColor={accent ?? role?.accent}
      fanInfo={fan}
      currentTask={currentTaskOf(session, project)}
      closable
      shortcutIndex={shortcutIndex}
      onClick={onSelect}
      onRename={onRename}
      onClose={onClose}
      onPickAccent={onPickAccent}
    />
  )
  if (!reorderable) return row
  return (
    <div
      data-session-row={session.id}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/session', session.id) }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/session')) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        setEdge(e.clientY - r.top < r.height / 2 ? 'before' : 'after')
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        e.preventDefault()
        const dragged = e.dataTransfer.getData('text/session')
        const r = e.currentTarget.getBoundingClientRect()
        // Read the edge off the EVENT, not off state: a fast drag can drop before the line has
        // committed, and a drop with no line drawn must still land under the cursor.
        if (dragged && dragged !== session.id) {
          onReorderSession?.(dragged, session.id, e.clientY - r.top < r.height / 2 ? 'before' : 'after')
        }
        setEdge(null)
      }}
      style={{
        // Constant transparent rules, so showing the drop line cannot shift the stack.
        borderTop: `2px solid ${edge === 'before' ? 'var(--accent)' : 'transparent'}`,
        borderBottom: `2px solid ${edge === 'after' ? 'var(--accent)' : 'transparent'}`,
      }}
    >{row}</div>
  )
}

/** THE APP'S OWN ROW — Arrangement A: four groups of two, three hairlines, the same order and the
 *  same total height at both widths. Only the CELL width changes, so every foot row lands on an
 *  identical y at 60 and at 264. That is the analogue of the member column's constant x: the
 *  bottom of the strip is as fixed as the top, so ⌘B adds words and moves nothing, anywhere.
 *
 *  All eight are present in BOTH states, which is the defect this whole change fixes: ⌘B used to
 *  unmount `Sidebar.tsx`, and with it the theme toggle, Preferences and both `.claude` shortcuts
 *  simply stopped existing. */
function RailFoot({ collapsed, planLimits, agentsActive, onOpenAgents, onShowGallery, onOpenFolder, project, activeFolderPrefs, globalPrefsActive, prefsViewActive, isDark, onOpenFolderPrefs, onOpenGlobalPrefs, onOpenPrefs, onToggleTheme, version, update, onInstallUpdate }: {
  collapsed: boolean
  planLimits: ReturnType<typeof usePlanLimits>
  agentsActive?: boolean
  onOpenAgents: () => void
  onShowGallery: () => void
  onOpenFolder: () => void
  project: Project | null
  activeFolderPrefs: string | null
  globalPrefsActive?: boolean
  prefsViewActive?: boolean
  isDark: boolean
  onOpenFolderPrefs?: (projectPath: string, projectName: string) => void
  onOpenGlobalPrefs?: () => void
  onOpenPrefs?: () => void
  onToggleTheme?: () => void
  version?: string
  update?: { version: string } | null
  onInstallUpdate?: () => void
}) {
  /** A divider has to out-space the things it divides: 9px either side against a 24px row. */
  const hairline = <span data-rail-seam style={{ width: '100%', height: 1, background: SEAM, margin: '9px 0', flexShrink: 0 }} />
  return (
    <div data-rail-foot style={{
      flexShrink: 0, width: '100%', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      padding: `10px ${FOOT_PAD}px`,
    }}>
      {/* Views ACROSS projects — not ways of moving between them, which is the next pair. */}
      <FootRow>
        <FootCell collapsed={collapsed} label="Agents">
          <FootGlyph
            attr="data-rail-agents"
            label="Agents"
            hint="what is running across your projects"
            active={agentsActive}
            onClick={onOpenAgents}
          >
            {/* Drawn to 12×12 of painted ink, like the grid and the plus — the eyes and antenna
                dot are FILLED, so they set fill explicitly against the svg's fill:none. */}
            <rect x="1.75" y="5" width="12.5" height="9" rx="2.4" />
            <path d="M8 2.9v2.1" strokeLinecap="round" />
            <circle cx="8" cy="1.9" r="1" fill="currentColor" stroke="none" />
            <circle cx="6" cy="9.5" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="10" cy="9.5" r="0.9" fill="currentColor" stroke="none" />
          </FootGlyph>
        </FootCell>
        <FootCell collapsed={collapsed} label="Plan usage">
          {/* Needs no session and no project — `claude -p "/usage"` spawns its own short-lived
              process — so it is live at the gallery and on first launch, which is exactly when
              you are deciding what to start. */}
          <PlanMeter
            box={FOOT_BOX}
            limits={planLimits.limits}
            loading={planLimits.loading}
            now={planLimits.now}
            onRefresh={planLimits.refresh}
            onRevalidate={planLimits.revalidate}
          />
        </FootCell>
      </FootRow>
      {hairline}
      {/* Navigation BETWEEN projects. */}
      <FootRow>
        <FootCell collapsed={collapsed} label="All projects">
          <FootGlyph attr="data-rail-gallery" label="All projects" hint="⌘⇧O" onClick={onShowGallery} strokeWidth={1.05}>
            <rect x="2" y="2" width="5" height="5" rx="1.2" />
            <rect x="9" y="2" width="5" height="5" rx="1.2" />
            <rect x="2" y="9" width="5" height="5" rx="1.2" />
            <rect x="9" y="9" width="5" height="5" rx="1.2" />
          </FootGlyph>
        </FootCell>
        <FootCell collapsed={collapsed} label="Open folder">
          <FootGlyph attr="data-rail-open-folder" label="Open folder" hint="⌘N" onClick={onOpenFolder} strokeWidth={1.45}>
            {/* Spans 2–14 of the viewBox, not 3.5–12.5: the two navigation verbs are a matched
                pair, and every box being the same size said nothing about their drawn extents
                differing by 27%. Only the painted extent did. */}
            <path d="M8 2v12M2 8h12" strokeLinecap="round" />
          </FootGlyph>
        </FootCell>
      </FootRow>
      {hairline}
      {/* The two Claude-file shortcuts. A folder and a globe cannot say "project" and "global" on
          their own, which is the argument for labelling all eight rather than some. */}
      <FootRow>
        <FootCell collapsed={collapsed} label=".claude" mono>
          <FootGlyph
            attr="data-rail-folder-prefs"
            label={project ? `${project.name} Claude files (.claude)` : 'Project Claude files'}
            hint="this project"
            disabled={!project?.path}
            active={!!activeFolderPrefs && activeFolderPrefs === project?.path}
            onClick={() => project && onOpenFolderPrefs?.(project.path, project.name)}
          >
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" strokeLinejoin="round" />
          </FootGlyph>
        </FootCell>
        <FootCell collapsed={collapsed} label="~/.claude" mono>
          <FootGlyph attr="data-rail-global-prefs" label="Global Claude files (~/.claude)" hint="every project" active={globalPrefsActive} onClick={() => onOpenGlobalPrefs?.()}>
            <circle cx="8" cy="8" r="6" />
            <ellipse cx="8" cy="8" rx="2.5" ry="6" />
            <path d="M2 8h12" />
          </FootGlyph>
        </FootCell>
      </FootRow>
      {hairline}
      <FootRow>
        <FootCell collapsed={collapsed} label="Preferences">
          <FootGlyph attr="data-rail-prefs" label="Operator preferences" hint="settings" active={prefsViewActive} onClick={() => onOpenPrefs?.()} viewBox="0 0 24 24" strokeWidth={1.8} inkSize={12}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </FootGlyph>
        </FootCell>
        <FootCell collapsed={collapsed} label={isDark ? 'Light mode' : 'Dark mode'}>
          {/* 15 for the MOON, 14 for the sun. A crescent's silhouette is smaller than its own
              box — it painted 11px against every other glyph's 12, i.e. the theme toggle read a
              size smaller than its neighbours on exactly the three light palettes, where it is
              the one that shows. Measured, not guessed: assertion S sweeps all six. */}
          <FootGlyph attr="data-rail-theme" label={isDark ? 'Switch to light mode' : 'Switch to dark mode'} hint="theme" inkSize={isDark ? 14 : 15} onClick={() => onToggleTheme?.()}>
            {isDark ? (
              <>
                {/* Filled core so the sun reads distinct from the hollow-centred gear beside it. */}
                <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />
                <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.7 3.7l1 1M11.3 11.3l1 1M3.7 12.3l1-1M11.3 4.7l1-1" strokeLinecap="round" />
              </>
            ) : (
              <path d="M13.5 9.5a5.5 5.5 0 0 1-7-7A5.5 5.5 0 1 0 13.5 9.5Z" />
            )}
          </FootGlyph>
        </FootCell>
      </FootRow>
      {/* The app's identity, on its own line at the bottom of the grid — CENTRED ON THE AXIS, the
          same 30 element-local (38 from the window edge) that every orb, every collapsed name and
          every Home mark sits on. It was the one element in the strip that did not, which is
          exactly why it was the one thing still reading as unbalanced once Fix 1 put everything
          else on 38: bare left-aligned text under a foot whose every other row is a tiled
          two-column grid, i.e. an orphan rather than a caption.
          NOT `marginLeft: auto` and not "fill the leftover space" — that is what the OLD comment
          here was written to prevent (the foot used to shove the version into whatever gap was
          left, and with `flexWrap` on it would drop to a line of its own the moment it did not
          fit). That prevention still stands; what changed is the answer to "then where?", which is
          the axis, because the axis is where the whole strip already is.
          The box is `2 × AXIS` — the widest a box centred on the axis can be inside a 60px strip —
          rather than the foot's full width, so its centre is the AXIS at both widths instead of the
          midpoint of a 256px row at 264. It cancels the foot's own padding to get there, which the
          grid rows above it keep.
          `2 × AXIS` AND NOT `2 × (AXIS − FOOT_PAD)`, measured rather than assumed: at 52 the real
          `v0.13.6` plus a pending update's affordance needs 59 and rendered as **`v0.1…`** — the
          version number, which is the whole thing you read before deciding to install, destroyed by
          8px. "A long version must truncate rather than widen the foot" is still true; an ordinary
          one losing its digits is not that.
          The affordance sits inside the same box, so `v0.13.6 ↓` centres as ONE unit. */}
      <div data-rail-identity-row style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        width: 2 * AXIS, marginLeft: -FOOT_PAD, marginTop: 10, minWidth: 0,
      }}>
        <span
          data-sidebar-identity
          title={`Operator${version ? ` v${version}` : ''}`}
          style={{
            minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
            fontVariantNumeric: 'tabular-nums',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >{version ? `v${version}` : 'Operator'}</span>
        {update && (
          <button
            onClick={onInstallUpdate}
            title={`Update ${update.version} available — install & restart`}
            aria-label={`Install update ${update.version}`}
            style={{
              flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 14, padding: 0,
              background: 'transparent', color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 999,
              cursor: 'pointer', outline: 'none',
            }}
          >
            {/* Arrow centred in the viewBox + a 0.5px optical nudge (a chevron reads high). */}
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'translateY(0.5px)' }}>
              <path d="M6 9V3M3 5.5l3-2.5 3 2.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

/** One foot row: two cells, and the SAME HEIGHT whatever is in them — which is what puts the four
 *  rows on identical y at both widths. */
function FootRow({ children }: { children: React.ReactNode }) {
  return (
    <div data-rail-foot-row style={{
      display: 'flex', alignItems: 'center', gap: FOOT_GAP, width: '100%',
      height: FOOT_BOX, flexShrink: 0,
    }}>{children}</div>
  )
}

/** One foot cell: the glyph, and — expanded — the word for it. The glyph box is identical at both
 *  widths and LEADS the cell, so the left column of glyphs holds its x as well as its y. */
function FootCell({ collapsed, label, mono, children }: {
  collapsed: boolean
  label: string
  /** Paths are named in mono — precise, short, and what the user recognises. */
  mono?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
      // Collapsed, the pair IS the field (24 + 4 + 24 = 52) and straddles the axis; expanded, the
      // two cells split it.
      ...(collapsed ? { width: FOOT_BOX, flexShrink: 0 } : { flex: 1 }),
    }}>
      {children}
      {!collapsed && (
        <span style={{
          minWidth: 0, transition: REVEAL,
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-body)',
          fontSize: mono ? 10 : 11, color: 'var(--fg-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{label}</span>
      )}
    </div>
  )
}

/** A foot control's glyph box. 24px, radius 7, 14px ink, `--fg-muted` at rest, background + ink
 *  lifting together on hover.
 *
 *  No `opacity` anywhere: `--fg-muted` IS the recede, and multiplying it lands at 1.8–2.9:1 on the
 *  three light palettes. Disabled recedes by mixing toward the strip's own background — a real
 *  colour that stays measurable — and by going inert to the pointer. */
function FootGlyph({ attr, label, hint, onClick, active, disabled, viewBox = '0 0 16 16', strokeWidth = 1.2, inkSize = 14, children }: {
  attr: string
  label: string
  hint: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  viewBox?: string
  /** OPTICAL correction, not a free knob: the grid draws four closed rects against the plus's two
   *  strokes — a 3:1 mass difference at the same weight, which is why the two navigation verbs
   *  did not read as a pair even once their extents matched. */
  strokeWidth?: number
  /** The RENDERED svg size, which is not the same thing as the painted extent. Every 16-viewBox
   *  glyph here is drawn 2–14, so at 14px it paints 12 — but the gear fills its 24-viewBox edge to
   *  edge, so the same 14 paints 14. Two pixels larger than everything beside it, in an identical
   *  box, which is precisely the class of difference assertion S exists to catch and which went
   *  unseen while S measured only four of the eight. */
  inkSize?: number
  children: React.ReactNode
}) {
  const rest = active ? 'var(--overlay-subtle)' : 'transparent'
  const ink = disabled
    ? 'color-mix(in srgb, var(--fg-muted) 65%, var(--bg-sidebar))'
    : active ? 'var(--fg)' : 'var(--fg-muted)'
  return (
    <button
      {...{ [attr]: '' }}
      onClick={onClick}
      disabled={disabled}
      title={`${label} (${hint})`}
      aria-label={label}
      aria-current={active || undefined}
      style={{
        width: FOOT_BOX, height: FOOT_BOX, padding: 0, flexShrink: 0,
        display: 'grid', placeItems: 'center',
        background: rest, border: 'none', borderRadius: 7,
        color: ink, cursor: disabled ? 'default' : 'pointer', outline: 'none',
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => { if (disabled) return; e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
      onMouseLeave={(e) => { if (disabled) return; e.currentTarget.style.background = rest; e.currentTarget.style.color = ink }}
    >
      <svg width={inkSize} height={inkSize} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}

/** The one status ladder, shared with the expanded row's `SessionItem`. */
function waveStatusOf(session: AgentSession): WaveStatus {
  if (session.status === 'ended') return 'ended'
  return session.phase === 'running' || session.phase === 'compacting' || session.phase === 'waiting'
    ? session.phase
    : 'idle'
}
