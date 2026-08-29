import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSession, Project, Role } from '../../../shared/types'
import { StatusWave, type WaveStatus } from './StatusWave'
import { SessionItem } from './SessionItem'
import { DragRegion } from '../DragRegion'
import { projectActivityLabel, type ProjectActivity } from '../../lib/project-status'
import { byRailOrder, isOnRail } from '../../lib/project-shelf'
import { orderByRoster } from '../../lib/roster'
import { projectAccent } from '../../lib/project-accent'
import { laneTextColor } from '../../lib/lane-color'
import { useHoverCard, closeHoverCards } from '../../lib/use-hover-card'
import { sessionLabel } from '../../lib/session-label'
import { IDLE, installBusy, installTitle, type InstallState } from '../../lib/update-install'
import { currentTaskOf } from '../../lib/session-task'
import { tildePath } from '../../lib/format'
import { resolveLaneInitials } from '../../lib/lane-initial'
import { PlanMeter, usePlanLimits } from './PlanMeter'
import { FOOT_BOX, FOOT_GAP, footCellStyle, footLabelStyle } from './foot-cell'
import { ROW_INSET_L } from './rail-metrics'
import { footDisclosureLabel, readFootExpanded, writeFootExpanded } from '../../lib/rail-foot'

// THE LEFT SURFACE. One component, two widths — there is no rail and no panel any more.
//
// The duplication that kept coming back (an agent listed in the rail AND in the sidebar beside
// it, 40px apart) was never a rule two files failed to keep; it was two files each deciding, on
// their own, to list agents. `Sidebar.tsx` and `SidebarRail.tsx` are deleted, and this renders the
// one list at 70px or at 264px. Collapsed and expanded are mutually exclusive states of ONE
// element, so "a project's agents appear exactly once" holds by construction rather than by
// discipline.
//
// THE MEMBERSHIP RULE, and it is the whole design:
//
//   A project group shows what is LIVE in it. EVERY group, including the open one.
//
// applied identically at both widths — live agents are orbs at 70 and rows at 264. The rule used
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

/** The ELEMENT is 70. The STRIP YOU SEE is 78, and that is the number the traffic lights fix.
 *
 *  `DashboardView`'s root pads 8px and paints it `--bg-sidebar` — the same colour this paints —
 *  so the rail's box does not start at the window edge but the visible strip does. Balance the
 *  cluster in what a person can see, not in the element:
 *
 *      close 9–23 · min 32–46 · zoom 55–69   (14pt buttons, centres (16,16) · (39,16) · (62,16))
 *      cluster = 9 → 69 = 60 wide, sitting 9 clear of the window edge — so mirror that 9 on its
 *      right: visible strip = 9 + 60 + 9 = 78 → element 78 − 8 = 70
 *
 *  These are the MODERN AppKit metrics, which is the whole reason this moved. The number here was
 *  60, derived from a LEGACY cluster — 12pt buttons on 20pt centres, `close 8.0–19.5 · min
 *  28.0–39.5 · zoom 48.0–59.75`, 51.75 wide, visible strip 8 + 51.75 + 8 ≈ 68. That cluster
 *  belonged to the Tauri bundle, which declared `LSMinimumSystemVersion 10.15`; the Electron shell
 *  declares 12.0 and links modern AppKit, so it gets 14pt buttons on 23pt centres under
 *  `titleBarStyle: 'hidden'`. At 60 the zoom button ended ~1pt PAST the strip's right edge.
 *
 *  RETUNE FROM A DEV BUILD — the opposite of what this comment used to say, and for the same
 *  reason it said it. The old warning existed because `target/debug/operator` had no Info.plist
 *  and drew a different cluster from the signed bundle, so only the bundle could be trusted. The
 *  Electron shell has one Info.plist: `cd electron && npm run dev` and the packaged app draw the
 *  SAME 14pt cluster. (An `LSMinimumSystemVersion 10.15` override does NOT bring the small
 *  buttons back — probed. The style mask is not the lever either; `hidden` and `hiddenInset`
 *  differ only in origin.) */
const RAIL_W = 70
/** Expanded. NOT forced by anything any more — the constant-x invariant that fixed it at
 *  2 × the axis was retired on 2026-08-04 (see `ROW_INSET_L`), and 264 outlived it as a value the
 *  name column was already tuned to. It does NOT follow `RAIL_W`: expanded content starts at
 *  `ROW_INSET_L`, not on the axis, so widening the collapsed strip leaves this alone. */
const RAIL_W_OPEN = 264
/** ZERO. There is nothing left for the content to be inset FROM.
 *
 *  This was 8 while the rail had a right-hand seam: the visible column ended at that line, so the
 *  field had to stop short of it. Deleting the seam moved the boundary and the inset was never
 *  re-derived — which is a sequencing artifact, and the exact mistake this file's header warns
 *  about: measuring to the element's box instead of to the column a person can see.
 *
 *      window edge 0 │ root pad 8 │ rail element 8→78 │ gap 8 │ card edge 86
 *
 *  Both fields are painted `--bg-sidebar`, the rail's own colour, and the rail draws no edge on
 *  either side — so the column runs 0 → 86 and its centre is 43. An 8px inset puts the content
 *  4px left of the middle of what you see (it was 34 against 38 when the strip was 60 wide, and
 *  the error is the same half-inset at any width), which is what the user reported as "not
 *  optically centred". At 0 the element's own midpoint IS the optical centre. */
const CONTENT_INSET_R = 0
/** The optical axis: 35 element-local = **43 from the window edge** = the centre of the visible
 *  column, window edge to card edge. The second number is the one that matters — a driver that
 *  only checks the elements agree with each other at 35 would have passed a wrong 31 too. */
const AXIS = (RAIL_W - CONTENT_INSET_R) / 2
/** A member's hit box — the orb's 24px disc inside it, and `+ Add an agent` and Home on the same
 *  box, so every clickable thing in the strip is one column at one x. */
const MEMBER_BOX = 36
/** COLLAPSED, a member's box is centred on the axis: `AXIS − MEMBER_BOX / 2` = 17. That is the
 *  optical-centre rule and it is untouched — only the axis it is measured from moved. */
const MEMBER_INSET_L = AXIS - MEMBER_BOX / 2
const ORB = 24
/** The `+`'s ink, EXPANDED. Sized against the orb's painted extent, measured rather than chosen:
 *  the disc paints 24×24 and the plus at 24 painted 24×24 too — the same extent, which is exactly
 *  why it read heavier. A cross reaches the corners of its box; a disc of dots does not, so equal
 *  extents are not equal mass (405px² of ink against 92px²). At 20 it is 83% of the disc and reads
 *  as its junior, which is what it is.
 *
 *  IT IS LEFT-ALIGNED IN THE COLUMN, not centred. Shrinking a centred glyph moves its left ink
 *  edge — measured 8 → 9 → 10 → 11 as the svg went 24 → 22 → 20 → 18 — and that edge is the one
 *  thing FIX-5 put there. So the mark column stays 24 wide (the labels after it stay on one x) and
 *  the glyph hugs its left. */
const ADD_GLYPH = 20
/** Air between member rows, expanded. The tinted rows used to stack flush, so a selected row's
 *  fill butted against its neighbours and each member stopped reading as its own object.
 *
 *  6 belongs to the family already here: the group boundary is 6 + hairline + 6, and the foot's
 *  dividers are 9 + 9. It is also HALF the group separation (12 + the hairline), which is the
 *  constraint that matters — a divider must out-space what it divides, or the grouping inverts.
 *  `dev/drive-rail-invariant.mjs` asserts that relationship rather than trusting this comment. */
const MEMBER_GAP = 6
/** Foot geometry — shared with `PlanMeter`, which brings its own button (see `foot-cell.ts`).
 *  24 at a 4px gap was derived when the collapsed field was 52 (24 + 4 + 24 = 52, exactly): it FIT,
 *  and the fit is what set it. The field is 70 now, so nothing forces 24 any more — deliberately
 *  left alone rather than drifting. What the wider field buys is that the pair no longer has to be
 *  flush: `FOOT_PAD` centres it under the member column. */
/** (70 − (24 + 4 + 24)) / 2 = 9. The foot pair straddles the axis instead of hugging the left
 *  edge — and the SAME padding applies at 264, so the left glyph column holds its x across ⌘B
 *  just as the orb column does. The foot keeps its own rhythm (it is not on the member column,
 *  by design), but it must not MOVE. */
const FOOT_PAD = (RAIL_W - (FOOT_BOX * 2 + FOOT_GAP)) / 2

/** The fold control's box. 18 x 14 is a real target on a 70px strip while staying narrower than a
 *  foot cell's 24 — it is the seam's ornament, not a ninth control, and it must not read as one.
 *  It overhangs the hairline's 9px of air either side rather than adding height of its own. */
const DISCLOSURE_W = 18
const DISCLOSURE_H = 14

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

/** THE SAME-KIND RULE, AND IT IS THE DRAG'S MIME TYPE — not a check inside a drop handler.
 *
 *  Two kinds of member row sit in one column and they are ordered by different things: a LANE row
 *  by its project's roster (durable, shared with the Team screen), an AD-HOC row by the live
 *  `terminals` order (per-run). There is no sensible merge of the two, so a cross-kind drag must
 *  do nothing — and, per the brief, must not even LOOK droppable.
 *
 *  Encoding the kind in the drag TYPE gets that for free and in one place. `dragover` can read
 *  `dataTransfer.types` but NOT `getData` (the payload is withheld until drop, deliberately), so
 *  the type is the only thing a row can filter on while the drag is still in the air — which is
 *  exactly when the drop line is drawn. A row that does not recognise the type never previews a
 *  drop, so `onDrop` never fires and there is nothing to silently discard.
 *
 *  THE PROJECT IS IN THE TYPE for the same reason. This strip shows several projects at once and
 *  role ids are only unique within one (`code` exists in most of them), so a lane dragged across
 *  group boundaries would otherwise land in the wrong roster — or self-drop, since `code` onto
 *  `code` is a valid pair in both. A per-project type makes a cross-project lane drag inert by the
 *  same mechanism as a cross-kind one, rather than by a second rule someone has to remember.
 *  Project ids are already `[a-z0-9-]` (`lib/project-id`), so they survive the lowercasing the
 *  drag-and-drop API applies to type strings. */
const laneDragType = (projectId: string) => `operator/lane-${projectId}`
const SESSION_DRAG_TYPE = 'text/session'

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
   *  scroller at the window's edge, so a menu parented to a row would be cut off at 70. */
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
   *  window's edge, so a popover parented to a row would be cut off at 70. */
  onAgentMenu?: (projectId: string, anchor: { top: number; left: number }) => void
  onAddLane?: () => void
  /** Reorder two AD-HOC session rows. Lane rows are ordered by the roster instead. */
  onReorderSession?: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
  /** Reorder two LANE rows — by `roleId`, because the ROSTER is what orders them, and by
   *  `projectId` because this strip shows several projects at once and a role id is only unique
   *  within one of them (`code` exists in most). The pre-join sidebar could omit the project: it
   *  was scoped to exactly one. */
  onReorderLane?: (projectId: string, draggedRoleId: string, targetRoleId: string, edge: 'before' | 'after') => void
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
  /** What the install is doing, so the arrow can be the thing you watch rather than a button
   *  that stays pressable through its own download. Absent = idle. */
  installState?: InstallState
  onInstallUpdate?: () => void
}

export function ProjectRail({
  collapsed, projects, activities, activeProjectId,
  onOpenProject, onOpenProjectHome, projectHomeActive,
  onShowGallery, onOpenFolder, onOpenAgents, agentsActive,
  onReorder, onTileMenu, menuProjectId,
  sessions = [], activeSessionId, onSelectSession, accentOf, onPickAccent,
  onRestoreProject, customNames = {}, effortLevels = {}, fanInfo = {}, shortcutIndices = {},
  onRenameSession, onCloseSession, onAgentMenu, onAddLane, onReorderSession, onReorderLane,
  activeFolderPrefs, globalPrefsActive, prefsViewActive, isDark,
  onOpenFolderPrefs, onOpenGlobalPrefs, onOpenPrefs, onToggleTheme,
  version, update, installState, onInstallUpdate,
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
  // Membership is `isOnRail` (lib/project-shelf), not an inline copy of it: CLOSE's gate asks
  // the same question — "is there a rail entry to take off?" — and two copies of that predicate
  // could disagree about whether a control should exist for a tile that is right there.
  const shown = projects
    .filter((p) => isOnRail(p, activities[p.id], activeProjectId))
    .sort(byRailOrder)
  const canReorder = !!onReorder && shown.length > 1
  const endDrag = () => { dragRef.current = null; setDrag(null); setDropAt(null) }

  // A group's live members, with its LANES in roster order — see `orderByRoster`. Ordering here
  // rather than at the render site is what makes both widths agree: the orbs and the rows read
  // the same list, so a lane dragged at 264 is in the same place at 70.
  const liveOf = (projectId: string) => {
    const live = sessions.filter((s) => s.projectId === projectId && s.status !== 'ended')
    const roster = projects.find((p) => p.id === projectId)?.roster ?? []
    return orderByRoster(live, roster)
  }

  // NO FOLD. A group shows every agent that is live in it, at both widths.
  //
  // There was a `FOLD = 4` here, and it was a CONSTANT PRETENDING TO BE A MEASUREMENT: the comment
  // justified it as keeping the neighbouring projects on screen, but nothing in it ever looked at
  // how much room there was. Observed live: five live agents rendered `O C D Q` then `+1` with the
  // lower half of the rail empty — an agent hidden to save space that was never short. The user's
  // call (2026-08-04): "there's plenty of space… i rather view all the agents, and the whole rail
  // to scroll if needed."
  //
  // The overflow behaviour is the SCROLLER below, which already had `overflowY: 'auto'` — so a
  // strip that genuinely runs out of height scrolls, and no agent is unreachable. A cap that
  // engages only on measurement was considered and rejected: at 264 a member row is a
  // `SessionItem` with no constant height (it grows a task line), so the budget would have to be
  // guessed, and a cap computed from RENDERED height oscillates — folding shrinks the group, which
  // re-measures as fitting, which unfolds it.

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
    <div
      data-rail
      data-rail-collapsed={collapsed ? '' : undefined}
      // The rail's own boundary. `pointerleave` fires once for the whole strip whatever row the
      // pointer was over, so it catches the case a per-row `mouseleave` misses: leaving sideways
      // into the content card fast enough that the row never sees its own leave.
      onPointerLeave={closeHoverCards}
      style={{
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
          bare titlebar, still draggable, nothing drawn in it. 40 is the VERTICAL half of the same
          clearance `RAIL_W` is the horizontal half of, and it did not have to move with it: the
          modern cluster spans y 9→23 (14pt buttons centred on y 16), so the band clears it by 17
          — more air than the 9.25 it had under the old `hiddenInset` + `{14,18}` origin, not less.
          `ProjectGallery`'s own 40px strip is the same number for the same reason. */}
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
        {/* THE EMPTY RAIL IS A CORRECT AND FREQUENT STATE, not an error: close your only live
            project from a non-project screen and there is genuinely nothing on the strip. It had
            no empty state at all, which left a bare band under the traffic lights that reads as
            a rendering failure. One line, in the same mono/uppercase/muted vocabulary as the
            gallery's shelf headers — structure, not content. Omitted at 70px: there is nowhere
            to put it, and a blank strip beside a visible gallery is not ambiguous. */}
        {shown.length === 0 && expanded && (
          <div data-rail-empty style={{
            fontFamily: 'var(--font-mono)', fontSize: 9.5, textTransform: 'uppercase',
            letterSpacing: '0.1em', color: 'var(--fg-muted)', padding: '6px 12px',
          }}>nothing running</div>
        )}
        {shown.map((p, i) => {
          const edge = dropAt?.id === p.id ? dropAt.edge : null
          const open = p.id === activeProjectId
          const live = liveOf(p.id)
          // Per KIND, because each kind's drag is guarded by how many rows it could drop onto —
          // one lane beside three ad-hoc sessions still has nowhere to go.
          const laneCount = live.reduce((n, s) => n + (s.roleId ? 1 : 0), 0)
          const adHocCount = live.length - laneCount
          // HOW THIS MEMBER REORDERS — decided once for the group, and read by BOTH widths.
          //
          // A lane row reorders the ROSTER, which is what orders it and what the Team screen
          // writes too, so one order shows on both surfaces. An ad-hoc row carries no lane, so
          // nothing else orders it and the drag is its only handle. The kind (and the project) is
          // carried in the drag's TYPE — see `laneDragType` — so a cross-kind or cross-project
          // drag is refused by the receiving row rather than accepted and silently discarded.
          //
          // `undefined` when it would be the only row of its kind: a drag whose only possible
          // drop is onto itself is an affordance that cannot do anything. That guard is what the
          // pre-join sidebar had (`laneRows.length > 1` / `adHocRows.length > 1`).
          const dragFor = (s: AgentSession) => {
            if (s.roleId) {
              if (!onReorderLane || laneCount < 2) return undefined
              return {
                type: laneDragType(p.id),
                id: s.roleId,
                onReorder: (dragged: string, target: string, edge: 'before' | 'after') => onReorderLane(p.id, dragged, target, edge),
              }
            }
            if (!onReorderSession || adHocCount < 2) return undefined
            return { type: SESSION_DRAG_TYPE, id: s.id, onReorder: onReorderSession }
          }
          const roster = p.roster ?? []
          const liveRoles = new Set(live.map((s) => s.roleId).filter(Boolean))
          // WHICH LANE, resolved for the WHOLE group at once — an initial depends on its peers
          // (`Research` is `RS` only because `Review` is here too), so it cannot be computed per
          // orb. The set is everything that can appear as a disc in this group: the roster, plus
          // any ad-hoc session that has no lane of its own. Those are exactly the names a person
          // can see side by side, which is the collision the rule protects against.
          //
          // COLLAPSED ONLY. The letter's job is to identify a lane where nothing else can — at 264
          // the name is spelled out on the row beside the disc, so the letter would be saying a
          // second time what the row already says. Not faded or shrunk at 264: simply absent.
          //
          // "A mark that appears on ⌘B is a moving target" is the standing objection and it is a
          // fair one, but it does not reach this: nothing moves or resizes. The orb keeps its size,
          // its x and its box in both states — only ink INSIDE it appears, which is a different
          // thing from a row appearing and re-flowing the stack, which is what that rule is about.
          // The constant-x invariant is asserted unchanged.
          const initials = collapsed ? resolveLaneInitials([
            ...roster.map((r) => ({ id: r.id, name: r.name })),
            ...live.filter((s) => !s.roleId).map((s) => ({ id: s.id, name: sessionLabel({ session: s, customName: customNames[s.id] }) })),
          ]) : {}
          const initialFor = (s: AgentSession) => initials[s.roleId ?? s.id]
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
              <div data-member-column style={{
                display: 'flex', flexDirection: 'column',
                // Header → first member is 4px; members are `MEMBER_GAP` apart. Collapsed they
                // stay flush: the orbs are a column of discs, not a stack of tinted rows, so the
                // air that separates the rows has nothing to separate there.
                ...(expanded ? { gap: MEMBER_GAP, marginTop: 4 } : null),
              }}>
              {live.length === 0 && (
                <HomeRow
                  collapsed={collapsed}
                  current={open && projectHomeActive}
                  onClick={() => (open ? onOpenProjectHome() : onOpenProject(p.id))}
                />
              )}

              {collapsed
                ? live.map((s) => (
                  <RailOrb
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    accent={accentOf?.(s)}
                    initial={initialFor(s)}
                    // The SAME drag the expanded row gets — one surface at two widths, so a
                    // gesture that worked at 264 and not at 70 would be two surfaces again.
                    drag={dragFor(s)}
                    onSelect={() => onSelectSession?.(s)}
                    onPickAccent={onPickAccent}
                  />
                ))
                : live.map((s) => (
                  <MemberRow
                    key={s.id}
                    session={s}
                    // BOTH kinds drag, each among its own — see `dragFor` above.
                    drag={dragFor(s)}
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

              {/* The `+N` that stood here is gone with the fold it counted. It was also the
                  two-verbs-one-glyph trap in miniature: it LOOKED like an expander and its
                  `onClick` was `onOpenProject`, so pressing the control that promised "show me
                  those agents" switched the active project instead. Nothing is hidden now, so
                  there is no count to show and no second verb to confuse it with. */}

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
                    height: MEMBER_BOX, padding: `0 8px 0 ${ROW_INSET_L}px`, boxSizing: 'border-box',
                    background: 'transparent', border: 'none', borderRadius: 8,
                    color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
                    fontFamily: 'var(--font-body)', fontSize: 11.5, textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-muted)' }}
                >
                  {/* `ADD_GLYPH` of ink, LEFT-ALIGNED in the disc's 24px column: its left ink edge
                      lands on the strip's one left edge, the label after it stays on the same x as
                      every lane's, and the glyph itself is the orb's junior rather than its equal.
                      The stroke is scaled so the painted line stays 1.2 whatever the size is. */}
                  <span style={{ width: ORB, display: 'grid', placeItems: 'center start', flexShrink: 0 }}>
                    <svg width={ADD_GLYPH} height={ADD_GLYPH} viewBox="0 0 16 16" fill="none">
                      <path d="M8 0.4v15.2M0.4 8h15.2" stroke="currentColor" strokeWidth={16 * 1.2 / ADD_GLYPH} strokeLinecap="round" />
                    </svg>
                  </span>
                  <span style={{ transition: REVEAL, whiteSpace: 'nowrap' }}>{idleLanes.length ? 'Start an agent' : 'Add an agent'}</span>
                </button>
              )}
              </div>
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
        installState={installState}
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
 *  Measured at 60, every single-token name in the real store fit and only the hyphenated compounds
 *  ellipsised, with the hover card carrying those whole. The strip is 70 now, so that bound only
 *  loosens — `EL-ENCANTO` fits where it used to clip — and nothing here had to change for it. */
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
            padding: collapsed ? 0 : `0 8px 0 ${ROW_INSET_L}px`,
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
            so. The chip is the state AND the way out of it. Expanded only: at 70 there is no room
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
          carries it.
          ON `ROW_INSET_L` LIKE EVERYTHING ELSE, and it was a bare 8 that agreed with the edge only
          because the edge happened to be 8 too — the moment the inset moved, the path was the one
          line in the strip still starting 4px left of the name above it. Assertion L does not
          cover it (it measures the header, the orb and the `+`), so nothing would have caught it. */}
      {!collapsed && open && project.path && (
        <div data-rail-path style={{
          padding: `0 8px 2px ${ROW_INSET_L}px`, fontFamily: 'var(--font-mono)', fontSize: 9.5,
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
        height: MEMBER_BOX, padding: `0 8px 0 ${collapsed ? MEMBER_INSET_L : ROW_INSET_L}px`, boxSizing: 'border-box',
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
      <span style={{ width: collapsed ? MEMBER_BOX : ORB, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        {/* A framed column board — one outlined rect with two dividers. Checked against every other
            glyph in the chrome; the only near-collision is the foot's 2×2 "all projects", and one
            frame against four separate squares separates cleanly.
            COLLAPSED it is 17px of ink centred in the 36px box: it sits alone against a 24px dot
            disc there, and 14 reads small beside that mass. EXPANDED it is drawn to the disc's own
            24px — edge to edge of its viewBox, with the stroke scaled down to keep the painted line
            at 1.2 — so its ink starts on the strip's one left edge instead of 3.5px inside it. */}
        {collapsed ? (
          <svg data-rail-home-mark width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" />
            <path d="M6 2.6v10.8M10 2.6v10.8" />
          </svg>
        ) : (
          <svg data-rail-home-mark width={ORB} height={ORB} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="0.8">
            <rect x="0.4" y="3" width="15.2" height="10" rx="1.6" />
            <path d="M5.6 3v10M10.4 3v10" />
          </svg>
        )}
      </span>
      {!collapsed && <span style={{ transition: REVEAL, whiteSpace: 'nowrap' }}>Home</span>}
    </button>
  )
}

/** One live agent, COLLAPSED. A 24px disc in the 36px member box, centred on the axis — the same
 *  disc, at the same x, that the expanded row carries. */
function RailOrb({ session, active, accent, initial, drag, onSelect, onPickAccent }: {
  session: AgentSession
  active: boolean
  accent?: string
  /** WHICH lane, in the disc. The collapsed strip has no other channel for it — and it is the
   *  same letter the expanded row draws, because the orb does not change meaning with the width. */
  initial?: string
  /** Same shape, same drag types and therefore the same same-kind rule as `MemberRow`. */
  drag?: {
    type: string
    id: string
    onReorder: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
  }
  onSelect: () => void
  onPickAccent?: (session: AgentSession, anchor: { top: number; left: number }) => void
}) {
  const hoverCard = useHoverCard(`orb:${session.id}`)
  const [edge, setEdge] = useState<'before' | 'after' | null>(null)
  const label = sessionLabel({ session })
  const status = waveStatusOf(session)
  return (
    <Fragment>
      <button
        ref={hoverCard.ref as React.RefObject<HTMLButtonElement>}
        data-rail-session={session.id}
        {...(drag && session.roleId ? { 'data-lane-orb': session.roleId } : null)}
        // THE ORB IS THE HANDLE, at this width too — see the RESULT for why reordering was taken
        // past the regression and given to the collapsed strip as well.
        draggable={!!drag}
        onDragStart={drag && ((e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(drag.type, drag.id)
          // The card is anchored to a row about to move out from under the cursor, and a drag
          // never fires the mouseleave that would close it — the same hardening the group header
          // needed for exactly this reason.
          hoverCard.onMouseLeave()
        })}
        onDragEnd={drag && (() => setEdge(null))}
        onDragOver={drag && ((e) => {
          if (!e.dataTransfer.types.includes(drag.type)) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setEdge(e.clientY - r.top < r.height / 2 ? 'before' : 'after')
        })}
        onDragLeave={drag && (() => setEdge(null))}
        onDrop={drag && ((e) => {
          if (!e.dataTransfer.types.includes(drag.type)) return
          e.preventDefault()
          const dragged = e.dataTransfer.getData(drag.type)
          const r = e.currentTarget.getBoundingClientRect()
          if (dragged && dragged !== drag.id) {
            drag.onReorder(dragged, drag.id, e.clientY - r.top < r.height / 2 ? 'before' : 'after')
          }
          setEdge(null)
        })}
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
          // Positioned ONLY so the drop line below can hang off it without taking any layout.
          position: 'relative',
        }}
        onMouseEnter={(e) => { hoverCard.onMouseEnter(e) }}
        onMouseLeave={() => { hoverCard.onMouseLeave() }}
      >
        {/* THE DROP LINE, ABSOLUTELY POSITIONED — and that is not a style preference. The expanded
            row can afford constant transparent borders because its rows already sit `MEMBER_GAP`
            apart; the collapsed orbs are FLUSH, so 2px of border top and bottom would take the
            member pitch from 36 to 40 and spread the whole column. `dev/drive-rail-invariant.mjs`
            asserts that pitch, and it would be right to fail. Out of flow, it costs nothing at
            rest and nothing while dragging. */}
        {edge && (
          <span style={{
            position: 'absolute', left: MEMBER_INSET_L, right: 4, height: 2, borderRadius: 1,
            ...(edge === 'before' ? { top: 0 } : { bottom: 0 }),
            background: 'var(--accent)', pointerEvents: 'none',
          }} />
        )}
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
            <StatusWave status={status} seed={session.id} size={ORB} accent={accent} initial={initial} />
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
function MemberRow({ session, project, role, active, accent, customName, effortLevel, fan, shortcutIndex, drag, onSelect, onRename, onClose, onPickAccent }: {
  session: AgentSession
  project: Project
  role?: Role
  active: boolean
  accent?: string
  customName?: string
  effortLevel?: string | null
  fan?: { index: number; total: number }
  shortcutIndex: number | null
  /** How this row reorders, or `undefined` for no handle at all. ONE shape for both kinds: the
   *  row does not know whether it is a lane or an ad-hoc session, it knows a drag `type` (which
   *  is what makes a drag from the other kind invisible to it), the `id` to send, and where to
   *  send it. The kind-specific decision is made once, at the call site. */
  drag?: {
    type: string
    id: string
    onReorder: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
  }
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
  return (
    <div
      // BOTH hooks, and they are the pre-join sidebar's own names: a lane is identified by its
      // ROLE (which is what its order is), an ad-hoc session by its session id. Keeping them
      // distinct means "what order are the lanes in" stays one selector rather than a filter.
      //
      // THE WRAPPER IS UNCONDITIONAL, and only `draggable` is not. These attributes are the row's
      // IDENTITY, not its draggability — some two dozen drivers select rows by them. Hanging them
      // off the drag condition (as the ad-hoc-only version did) meant the last row of its kind
      // silently lost its test hook the moment the "no drag with nothing to drop onto" guard came
      // back, which is a harness regression bought for nothing.
      {...(session.roleId ? { 'data-lane-row': session.roleId } : { 'data-session-row': session.id })}
      // THE ROW IS THE HANDLE. No grip: a hover-only grip has to reserve its space at rest or the
      // row twitches when you approach it, and grips belong on cards, not on 36px rows.
      draggable={!!drag}
      onDragStart={drag && ((e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(drag.type, drag.id) })}
      onDragOver={drag && ((e) => {
        // The KIND (and the project) filter, and the only place it can be applied: `dragover`
        // may read `types` but not `getData`. A row that does not recognise the type returns
        // without `preventDefault`, so it is not a drop target and draws no line — a cross-kind
        // drag is refused rather than accepted and silently discarded.
        if (!e.dataTransfer.types.includes(drag.type)) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        setEdge(e.clientY - r.top < r.height / 2 ? 'before' : 'after')
      })}
      onDragLeave={drag && (() => setEdge(null))}
      onDragEnd={drag && (() => setEdge(null))}
      onDrop={drag && ((e) => {
        if (!e.dataTransfer.types.includes(drag.type)) return
        e.preventDefault()
        const dragged = e.dataTransfer.getData(drag.type)
        const r = e.currentTarget.getBoundingClientRect()
        // Read the edge off the EVENT, not off state: a fast drag can drop before the line has
        // committed, and a drop with no line drawn must still land under the cursor.
        if (dragged && dragged !== drag.id) {
          drag.onReorder(dragged, drag.id, e.clientY - r.top < r.height / 2 ? 'before' : 'after')
        }
        setEdge(null)
      })}
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
 *  identical y at 70 and at 264. That is the analogue of the member column's constant x: the
 *  bottom of the strip is as fixed as the top, so ⌘B adds words and moves nothing, anywhere.
 *
 *  All eight are present in BOTH states, which is the defect this whole change fixes: ⌘B used to
 *  unmount `Sidebar.tsx`, and with it the theme toggle, Preferences and both `.claude` shortcuts
 *  simply stopped existing. */
function RailFoot({ collapsed, planLimits, agentsActive, onOpenAgents, onShowGallery, onOpenFolder, project, activeFolderPrefs, globalPrefsActive, prefsViewActive, isDark, onOpenFolderPrefs, onOpenGlobalPrefs, onOpenPrefs, onToggleTheme, version, update, installState = IDLE, onInstallUpdate }: {
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
  /** What the install is doing, so the arrow can be the thing you watch rather than a button
   *  that stays pressable through its own download. Absent = idle. */
  installState?: InstallState
  onInstallUpdate?: () => void
}) {
  /** A divider has to out-space the things it divides: 9px either side against a 24px row. */
  const hairline = <span data-rail-seam style={{ width: '100%', height: 1, background: SEAM, margin: '9px 0', flexShrink: 0 }} />

  // Which of the eight stay at rest is decided in `lib/rail-foot` — the reasoning is long enough
  // to deserve its own file, and the drivers assert against the same tier lists.
  const [footExpanded, setFootExpanded] = useState(readFootExpanded)
  const toggleFoot = useCallback(() => setFootExpanded((prev) => { writeFootExpanded(!prev); return !prev }), [])

  return (
    <div data-rail-foot style={{
      flexShrink: 0, width: '100%', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      padding: `10px ${FOOT_PAD}px`,
    }}>
      {/* Views ACROSS projects — not ways of moving between them, which is the next pair. */}
      <FootRow>
        <FootItem
          collapsed={collapsed}
          attr="data-rail-agents"
          label="Agents"
          title="Agents"
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
        </FootItem>
        {/* Needs no session and no project — `claude -p "/usage"` spawns its own short-lived
            process — so it is live at the gallery and on first launch, which is exactly when you
            are deciding what to start.
            It renders its OWN button, so it takes the cell treatment rather than being wrapped in
            one: a button inside a button passes a click test and is still wrong for the keyboard. */}
        <PlanMeter
          collapsed={collapsed}
          label="Plan usage"
          limits={planLimits.limits}
          loading={planLimits.loading}
          now={planLimits.now}
          onRefresh={planLimits.refresh}
          onRevalidate={planLimits.revalidate}
        />
      </FootRow>
      {hairline}
      {/* Navigation BETWEEN projects. */}
      <FootRow>
        <FootItem collapsed={collapsed} attr="data-rail-gallery" label="All projects" title="All projects" hint="⌘⇧O" onClick={onShowGallery} strokeWidth={1.05}>
          <rect x="2" y="2" width="5" height="5" rx="1.2" />
          <rect x="9" y="2" width="5" height="5" rx="1.2" />
          <rect x="2" y="9" width="5" height="5" rx="1.2" />
          <rect x="9" y="9" width="5" height="5" rx="1.2" />
        </FootItem>
        <FootItem collapsed={collapsed} attr="data-rail-open-folder" label="Open folder" title="Open folder" hint="⌘N" onClick={onOpenFolder} strokeWidth={1.45}>
            {/* Spans 2–14 of the viewBox, not 3.5–12.5: the two navigation verbs are a matched
                pair, and every box being the same size said nothing about their drawn extents
                differing by 27%. Only the painted extent did. */}
          <path d="M8 2v12M2 8h12" strokeLinecap="round" />
        </FootItem>
      </FootRow>
      {/* THE FOLD, and it lands on a hairline that was already here — see `lib/rail-foot` for which
          tier is which and why. The seam between "navigation between projects" and "Claude files"
          IS the control, so unfolding costs no extra row: expanded, the foot is exactly as tall as
          it has always been; folded, it loses two rows and a hairline and keeps its rhythm. */}
      <FootDisclosure expanded={footExpanded} onToggle={toggleFoot} />
      {footExpanded && (
        <>
          {/* The two Claude-file shortcuts. A folder and a globe cannot say "project" and "global"
              on their own, which is the argument for labelling all eight rather than some. */}
          <FootRow>
          <FootItem
            collapsed={collapsed}
            attr="data-rail-folder-prefs"
            label=".claude"
            mono
            title={project ? `${project.name} Claude files (.claude)` : 'Project Claude files'}
            hint="this project"
            disabled={!project?.path}
            active={!!activeFolderPrefs && activeFolderPrefs === project?.path}
            onClick={() => project && onOpenFolderPrefs?.(project.path, project.name)}
          >
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" strokeLinejoin="round" />
          </FootItem>
          <FootItem collapsed={collapsed} attr="data-rail-global-prefs" label="~/.claude" mono title="Global Claude files (~/.claude)" hint="every project" active={globalPrefsActive} onClick={() => onOpenGlobalPrefs?.()}>
            <circle cx="8" cy="8" r="6" />
            <ellipse cx="8" cy="8" rx="2.5" ry="6" />
            <path d="M2 8h12" />
          </FootItem>
          </FootRow>
          {hairline}
          <FootRow>
          <FootItem collapsed={collapsed} attr="data-rail-prefs" label="Preferences" title="Operator preferences" hint="settings" active={prefsViewActive} onClick={() => onOpenPrefs?.()} viewBox="0 0 24 24" strokeWidth={1.8} inkSize={12}>
              <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </FootItem>
            {/* 15 for the MOON, 14 for the sun. A crescent's silhouette is smaller than its own
                box — it painted 11px against every other glyph's 12, i.e. the theme toggle read a
                size smaller than its neighbours on exactly the three light palettes, where it is
                the one that shows. Measured, not guessed: assertion S sweeps all six. */}
          <FootItem collapsed={collapsed} attr="data-rail-theme" label={isDark ? 'Light mode' : 'Dark mode'} title={isDark ? 'Switch to light mode' : 'Switch to dark mode'} hint="theme" inkSize={isDark ? 14 : 15} onClick={() => onToggleTheme?.()}>
              {isDark ? (
                <>
                  {/* Filled core so the sun reads distinct from the hollow-centred gear beside it. */}
                  <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />
                  <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.7 3.7l1 1M11.3 11.3l1 1M3.7 12.3l1-1M11.3 4.7l1-1" strokeLinecap="round" />
                </>
              ) : (
              <path d="M13.5 9.5a5.5 5.5 0 0 1-7-7A5.5 5.5 0 1 0 13.5 9.5Z" />
            )}
          </FootItem>
          </FootRow>
        </>
      )}
      {/* The app's identity, on its own line at the bottom of the grid — CENTRED ON THE AXIS, the
          same 35 element-local (43 from the window edge) that every orb, every collapsed name and
          every Home mark sits on. It was the one element in the strip that did not, which is
          exactly why it was the one thing still reading as unbalanced once Fix 1 put everything
          else on the axis: bare left-aligned text under a foot whose every other row is a tiled
          two-column grid, i.e. an orphan rather than a caption.
          NOT `marginLeft: auto` and not "fill the leftover space" — that is what the OLD comment
          here was written to prevent (the foot used to shove the version into whatever gap was
          left, and with `flexWrap` on it would drop to a line of its own the moment it did not
          fit). That prevention still stands; what changed is the answer to "then where?", which is
          the axis, because the axis is where the whole strip already is.
          The box is `2 × AXIS` — the widest a box centred on the axis can be inside a 70px strip —
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
          // DOWNLOADING IS A STATE OF THIS BUTTON, not a second control and not a new row. The
          // ring is already here and already the accent, so the download FILLS it: a conic sweep
          // to `percent` inside the same 14px circle, with the arrow held exactly where it was.
          // Nothing moves and nothing is added to the foot, which is the only way progress fits
          // in a strip whose whole budget is 14px (see the fold's note above).
          //
          // A FAILURE STAYS PRESSABLE. It turns the ring to the error colour and says why in the
          // tooltip, but the verb is still "install" — most causes are transient and the
          // alternative to retrying here is quitting the app.
          <button
            onClick={installBusy(installState) ? undefined : onInstallUpdate}
            disabled={installBusy(installState)}
            title={installTitle(installState, update.version)}
            aria-label={installTitle(installState, update.version)}
            // Percent as a live region value, so the state is available to a screen reader
            // without it having to re-read the tooltip.
            role={installState.kind === 'downloading' ? 'progressbar' : undefined}
            aria-valuenow={installState.kind === 'downloading' ? installState.percent : undefined}
            aria-valuemin={installState.kind === 'downloading' ? 0 : undefined}
            aria-valuemax={installState.kind === 'downloading' ? 100 : undefined}
            style={{
              flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 14, padding: 0,
              // The unfilled remainder is the accent at 20% via `color-mix`, NOT opacity on the
              // element — dimming the element would take the arrow and the ring down with it.
              background: installState.kind === 'downloading'
                ? `conic-gradient(var(--accent) ${installState.percent * 3.6}deg, color-mix(in srgb, var(--accent) 20%, transparent) 0deg)`
                : 'transparent',
              color: installState.kind === 'failed' ? 'var(--color-error)' : 'var(--accent)',
              border: `1px solid ${installState.kind === 'failed' ? 'var(--color-error)' : 'var(--accent)'}`,
              borderRadius: 999,
              cursor: installBusy(installState) ? 'default' : 'pointer', outline: 'none',
              transition: 'background 120ms linear',
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

/** THE FOLD — a hairline that is also the control that unfolds it.
 *
 *  WHY THE SEAM AND NOT A ROW. A ninth cell would have cost a whole 24px row to save two, which is
 *  most of the point back. This occupies the height of the hairline it REPLACES — the one that
 *  already separated "navigation between projects" from "Claude files" — so expanded, the foot is
 *  exactly as tall as it was before this change. Its layout box is `height: 1, margin: 9px 0`, the
 *  same 19px a plain hairline takes; the button overhangs into that air without claiming any of
 *  it, which is what keeps the foot's rhythm (assertion V) reading identically.
 *
 *  WHY A CHEVRON IS SAFE HERE. The house rule is that two verbs never share a glyph, and the
 *  sidebar's own collapse control (`SidebarToggle`) draws a PANEL WITH A DIVIDER, not a chevron —
 *  checked, not assumed. Nothing else in the strip uses one: the only other mark near it is the
 *  update affordance's ringed up-ARROW in the identity row, which is a different silhouette in a
 *  ring in the accent. The two verbs are "hide the strip" and "unfold the foot", and they carry
 *  two different marks on two different surfaces.
 *
 *  IT IS NOT HOVER-ONLY. A control that appears on hover would have to reserve its space at rest,
 *  and a foot that only LOOKS emptier saves nothing. This one is drawn always, at `--fg-muted`,
 *  and the space it saves is real: two rows and a hairline, 67px.
 *
 *  ON THE AXIS at both widths, like the identity row below it — `2 × AXIS` wide with the foot's
 *  own padding cancelled, so its centre is 35 element-local at 70 AND at 264 rather than the
 *  midpoint of whatever row it happens to sit in. */
function FootDisclosure({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false)
  const label = footDisclosureLabel(expanded)
  return (
    <div style={{ position: 'relative', width: '100%', height: 1, margin: '9px 0', flexShrink: 0 }}>
      <span data-rail-seam style={{ position: 'absolute', inset: 0, background: SEAM }} />
      <button
        data-rail-foot-disclosure
        aria-expanded={expanded}
        onClick={onToggle}
        title={label}
        aria-label={label}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'absolute', top: '50%',
          // AXIS in foot-local coordinates (the foot pads by FOOT_PAD), minus half the box.
          left: AXIS - FOOT_PAD - DISCLOSURE_W / 2,
          transform: 'translateY(-50%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: DISCLOSURE_W, height: DISCLOSURE_H, padding: 0,
          // Painted with the strip's OWN colour so the hairline reads as passing behind it rather
          // than being interrupted — a surface, never an accent fill. Hover tints with the same
          // overlay the foot cells use, so the seam control joins the family it sits in.
          background: hover ? 'var(--overlay-subtle)' : 'var(--bg-sidebar)',
          border: 'none', borderRadius: 5,
          color: hover ? 'var(--fg)' : 'var(--fg-muted)',
          cursor: 'pointer', outline: 'none',
          transition: 'background 120ms ease, color 120ms ease',
        }}
        // A real focus state of its own — the house rule removes browser focus rings, and an inset
        // shadow also dodges the colour-changing-border-on-a-radius trap.
        onFocus={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px var(--accent)' }}
        onBlur={(e) => { e.currentTarget.style.boxShadow = 'none' }}
      >
        {/* 9px of painted ink across, against the foot glyphs' 12. It is the seam's ornament, not
            a ninth control, and the `+`'s rule applies: a junior mark sits AT OR UNDER the family
            it is subordinate to. Chevron down = there is more below; up = fold it away. */}
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d={expanded ? 'M2 7.5 6 3.5l4 4' : 'M2 4.5 6 8.5l4-4'} />
        </svg>
      </button>
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

/** ONE FOOT CONTROL — and the CELL IS THE BUTTON, glyph and label inside it.
 *
 *  It used to be a `<div>` holding a 24px glyph button plus a separate `<span>` for the word, so
 *  `Agents`, `Plan usage`, `.claude`, `~/.claude`, `Preferences` and the theme toggle were dead
 *  text with dead space around them: only the glyph opened anything. A labelled row whose label
 *  does nothing is a WORSE target than a bare glyph, because it advertises a hit area that is not
 *  there. If a future item grows a label, it goes inside the button.
 *
 *  One component for both widths rather than two paths — collapsed, the cell simply IS the glyph
 *  box, which is why the narrow state cannot silently regress. `dev/drive-rail-invariant.mjs`
 *  asserts it from the user's side: the element that receives a click at the LABEL's centre must be
 *  the same control that receives one at the glyph's.
 *
 *  Hover and current are background-only on a radiused box — never a colour-changing border, which
 *  re-rasterizes in WKWebView. */
function FootItem({ attr, label, title, hint, mono, onClick, active, disabled, collapsed, viewBox = '0 0 16 16', strokeWidth = 1.2, inkSize = 14, children }: {
  attr: string
  /** The word in the cell. Short — it is the widest thing in the foot. */
  label: string
  /** The tooltip's name, which can be longer and more precise than the label (`.claude` is the
   *  label; "operator Claude files (.claude)" is what it means). Also the accessible name. */
  title: string
  hint: string
  /** Paths are named in mono — precise, short, and what the user recognises. */
  mono?: boolean
  onClick: () => void
  active?: boolean
  disabled?: boolean
  collapsed: boolean
  viewBox?: string
  /** OPTICAL correction, not a free knob: the grid draws four closed rects against the plus's two
   *  strokes — a 3:1 mass difference at the same weight, which is why the two navigation verbs did
   *  not read as a pair even once their extents matched. */
  strokeWidth?: number
  /** The RENDERED svg size, which is not the same thing as the painted extent. Every 16-viewBox
   *  glyph here is drawn 2–14, so at 14px it paints 12 — the gear fills its 24-viewBox edge to
   *  edge and the moon's crescent is smaller than its box, so both depart to land on 12. */
  inkSize?: number
  children: React.ReactNode
}) {
  const rest = active ? 'var(--overlay-subtle)' : 'transparent'
  return (
    <button
      {...{ [attr]: '' }}
      onClick={onClick}
      disabled={disabled}
      title={`${title} (${hint})`}
      aria-label={title}
      aria-current={active || undefined}
      style={footCellStyle({ collapsed, active, disabled })}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
      onMouseLeave={(e) => { if (!disabled) e.currentTarget.style.background = rest }}
    >
      <span style={{ width: FOOT_BOX, height: FOOT_BOX, flexShrink: 0, display: 'grid', placeItems: 'center' }}>
        <svg width={inkSize} height={inkSize} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
          {children}
        </svg>
      </span>
      {!collapsed && <span data-foot-label style={{ ...footLabelStyle(mono), transition: REVEAL }}>{label}</span>}
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
