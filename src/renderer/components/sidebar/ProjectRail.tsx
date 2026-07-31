import { Fragment, useRef, useState } from 'react'
import type { Project } from '../../../shared/types'
import { StatusWave } from './StatusWave'
import { DragRegion } from '../DragRegion'
import { projectActivityLabel, type ProjectActivity } from '../../lib/project-status'
import { byRailOrder } from '../../lib/project-shelf'
import { projectAccent, projectInitials } from '../../lib/project-accent'
import { laneTextColor } from '../../lib/lane-color'
import { useHoverCard } from '../../lib/use-hover-card'
import { PlanMeter, usePlanLimits } from './PlanMeter'

// The persistent project rail — 44px, full height, outboard of the sidebar. It is the ONE
// surface that never goes away: here with the sidebar expanded, with it collapsed to the 64px
// SidebarRail, and at the gallery where the sidebar animates to width 0. That permanence is
// the whole point; a strip that disappears when you leave a project can't be the thing you
// orient by.
//
// SHAPE IS THE GRAMMAR. A session is a CIRCLE (the StatusWave orb, carrying a lane accent);
// a project is a ROUNDED SQUARE. That contrast is what stops a project reading as an agent —
// not the absence of a glyph — which is why the tiles can carry an acronym at all. Never draw
// a project round or a session square.
//
// Each tile carries TWO identity channels and one state channel:
//   colour   — hashed from the project id (lib/project-accent), never from status, so it can
//              be learned. A rail coloured by what a project was doing would repaint itself
//              as work happened and teach you nothing.
//   acronym  — because colour alone cannot separate fastrack / Fastrack-landing / FastTrack.
//   corner pip — a small StatusWave, so the app's one motion rule comes for free: only
//              running/compacting animate. No pip at all when idle; an always-present grey
//              dot is noise.
//
// Membership is what you have OPEN (live > 0), plus the current project so the rail is never
// empty while you're inside one. Deliberately NOT the full active shelf — that's what the
// sidebar's ALSO ACTIVE section is, and two renderings of the same list 40px apart is the
// duplication this split exists to avoid. An archived project still appears if something is
// live in it: a running agent must never be hidden.

const RAIL_W = 44

export function ProjectRail({
  projects, activities, activeProjectId, onOpenProject, onShowGallery, onOpenFolder,
  onOpenAgents, agentsActive, onReorder,
}: {
  projects: Project[]
  activities: Record<string, ProjectActivity>
  /** Null at the gallery — nothing is ringed, everything else is unchanged. */
  activeProjectId: string | null
  onOpenProject: (projectId: string) => void
  /** Foot control: leave every project. */
  onShowGallery: () => void
  /** Foot control: pick a folder, register it as a project, enter it. */
  onOpenFolder: () => void
  /** Foot control: the cross-project Agents hub. It lives here rather than in the sidebar
   *  because `AgentsHubView` iterates ALL projects — and because the sidebar animates to width 0
   *  at the gallery, which is exactly where you most want a view across them. */
  onOpenAgents: () => void
  /** Agents is a VIEW, unlike the two navigation verbs, so it can be the current one. */
  agentsActive?: boolean
  /** Drag one tile before/after another. Absent = tiles are not draggable at all. */
  onReorder?: (draggedId: string, targetId: string, edge: 'before' | 'after') => void
}) {
  const planLimits = usePlanLimits()
  const [drag, setDrag] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  // The drag id is also held in a ref: `onDragOver` fires on a DIFFERENT element than the one
  // that started the drag, and reading React state there can lag a frame behind on a fast drag.
  const dragRef = useRef<string | null>(null)

  // THE USER'S ORDER, not a computed one.
  //
  // It used to re-sort with `byActivityThenRecency`, shared with the gallery and the switcher.
  // That cannot coexist with dragging: a comparator recomputed on every activity change undoes
  // the drag the moment an agent starts or stops — the worst kind of "it didn't save", because it
  // does save and is then overwritten. So the automatic sort is GONE here, outright; "sometimes it
  // resorts" was never an option. Liveness is still on screen — that is what the corner pip is for.
  //
  // This is the same argument the header of this file already makes about COLOUR: a rail that
  // repaints itself as work happens teaches you nothing, which is why the tint is hashed from the
  // id. Position is the stronger memory channel, and it was the one still moving on its own.
  //
  // `railOrder` is a durable field on Project (see shared/types), NOT this array's order. Array
  // order does happen to survive every write path today — they are all map/filter/append — but
  // that is an accident nothing declares, and one `.sort()` added anywhere upstream would undo a
  // user's arrangement with no error and no way to notice.
  const shown = projects
    .filter((p) => (activities[p.id]?.live ?? 0) > 0 || p.id === activeProjectId)
    .sort(byRailOrder)
  const canReorder = !!onReorder && shown.length > 1

  const endDrag = () => { dragRef.current = null; setDrag(null); setDropAt(null) }

  return (
    <div style={{
      width: RAIL_W, flexShrink: 0, height: '100%',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border)',
      boxSizing: 'border-box', userSelect: 'none',
    }}>
      {/* The rail is now the leftmost strip, so IT hosts the macOS traffic lights: the same
          40px clearance the sidebar reserves, and still draggable. */}
      <DragRegion style={{ paddingTop: 40, width: '100%', flexShrink: 0 }} />

      <div
        className="scroll-hidden"
        style={{
          flex: 1, minHeight: 0, width: '100%', overflowY: 'auto', overflowX: 'hidden',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          // 8 here + the 2px transparent borders each tile wrapper always carries = 12px between
          // tile BOXES — but the box was never the number that mattered. Two things are drawn
          // outside it: the corner pip hangs ~3px below its tile, and the current-tile ring
          // (`boxShadow 0 0 0 2px`) sits 2px beyond it on every side. At the old flat `gap: 7`
          // that left 4–5px of real clearance, and the worst pair in the column — a pipped tile
          // directly above the ringed one, where BOTH overhangs eat the same gap — was tighter
          // still. Sized against the drawn extent instead, the worst pair now clears 8px and an
          // ordinary pair 12px. The borders are constant so the drop line can never shift the
          // stack while you drag over it.
          gap: 8,
          // 6 here + the wrapper's constant 2px border = 8px of air around every tile BOX, which
          // is exactly what the 44px rail already gives it sideways: (44 − 28) / 2 = 8. That
          // equality is the whole fix, and it is the one number to keep in step — the sides are
          // fixed by the rail's width, so the padding is the only free variable.
          //
          // Both ornaments overhang the box by the same 2px (the ring is `0 0 0 2px`; the pip is
          // offset -3 but its StatusWave svg carries a pixel of its own padding, so it PAINTS 2
          // past the edge — measured, not read off the offset). So a ringed or pipped tile clears
          // 6 on every side and a plain one clears 8, uniformly. It used to be 4 here, giving the
          // box 6 vertically against 8 sideways: a current tile then read 4 top / 6 sides, and
          // with one tile — the common case after the prune — that 2px was the entire impression.
          padding: '6px 0',
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        {shown.map((p) => {
          const edge = dropAt?.id === p.id ? dropAt.edge : null
          return (
            /* The drop line lives on THIS wrapper, never on the tile: the tile is radiused, and a
               colour-changing border on a radiused element re-rasterizes in WKWebView. A straight
               2px rule is safe, and it is always present (transparent at rest) so showing it
               cannot move anything. */
            <div
              key={p.id}
              data-rail-slot={p.id}
              style={{
                flexShrink: 0, width: '100%', display: 'flex', justifyContent: 'center',
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
                // Read the edge off the EVENT, not off `dropAt`: on a fast drag the state may not
                // have committed, and a drop with no line drawn must still land under the cursor.
                if (d && d !== p.id) {
                  const r = e.currentTarget.getBoundingClientRect()
                  onReorder?.(d, p.id, e.clientY - r.top < r.height / 2 ? 'before' : 'after')
                }
                endDrag()
              }}
            >
              <ProjectTile
                project={p}
                activity={activities[p.id] ?? { live: 0, waiting: 0, lanes: p.roster?.length ?? 0, status: 'idle' }}
                current={p.id === activeProjectId}
                onOpen={() => onOpenProject(p.id)}
                draggable={canReorder}
                dragging={drag === p.id}
                onDragStart={() => { dragRef.current = p.id; setDrag(p.id) }}
                onDragEnd={endDrag}
              />
            </div>
          )
        })}
      </div>

      {/* The foot: AGENTS, then the seam, then PROJECT NAVIGATION — the two verbs that move you
          between projects rather than within one. They used to live in the switcher popover's
          footer and, for "open folder", a second time in the sidebar's icon row. All three belong
          here: the rail is the only strip present in every state, including the gallery where the
          sidebar is gone.
          Agents goes FIRST and above the seam so the navigation pair stays adjacent — it is a view
          ACROSS projects, not a way of moving between them, and the existing hairline is what says
          so (no second divider invented for it). */}
      <div style={{
        flexShrink: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
        // Symmetric. The 10 at the bottom is load-bearing — it is what puts this strip's last
        // icon on the same baseline as the sidebar footer's — so the 8 at the top came up to
        // meet it rather than the other way round.
        gap: 4, padding: '10px 0',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}>
        <RailFootButton
          attr="data-rail-agents"
          label="Agents"
          hint="every agent across your projects"
          active={agentsActive}
          onClick={onOpenAgents}
        >
          {/* The same robot as the old sidebar button — it is what the user recognises. The eyes
              and antenna dot are FILLED, so they set fill explicitly against the svg's fill:none. */}
          <rect x="3" y="5.5" width="10" height="7.5" rx="2" />
          <path d="M8 3v2.5" strokeLinecap="round" />
          <circle cx="8" cy="2.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="6" cy="9" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="10" cy="9" r="0.9" fill="currentColor" stroke="none" />
        </RailFootButton>
        {/* USAGE sits beside Agents, above the seam: both are cross-project VIEWS, where the two
            below are navigation verbs. It needs no session and no project — `claude -p "/usage"`
            spawns its own short-lived process — so it is live at the gallery and on first launch,
            which is exactly when you're deciding what to start. */}
        <PlanMeter limits={planLimits.limits} loading={planLimits.loading} onRefresh={planLimits.refresh} />
        {/* A divider has to out-space the things it divides. At `margin: 5` it sat in 16–17px of
            painted air while the buttons either side of it had 20px — so the one element whose
            whole job is to separate two groups was the most crowded thing in the strip, and the
            foot read as five items in a row rather than 2 + 2. At 11 it gets 22–23px and the
            grouping comes back. */}
        <span style={{ width: 22, height: 1, background: 'var(--border)', margin: '11px 0' }} />
        <RailFootButton
          attr="data-rail-gallery"
          label="All projects"
          hint="⌘⇧O"
          onClick={onShowGallery}
          strokeWidth={1.05}
        >
          <rect x="2" y="2" width="5" height="5" rx="1.2" />
          <rect x="9" y="2" width="5" height="5" rx="1.2" />
          <rect x="2" y="9" width="5" height="5" rx="1.2" />
          <rect x="9" y="9" width="5" height="5" rx="1.2" />
        </RailFootButton>
        <RailFootButton
          attr="data-rail-open-folder"
          label="Open folder"
          hint="⌘N"
          onClick={onOpenFolder}
          strokeWidth={1.45}
        >
          {/* Spans 2–14 of the viewBox, not 3.5–12.5. Measured painted heights across the foot
              were robot 10 · grid 11 · plus 8: the two NAVIGATION VERBS, which should be a
              matched pair, differed by 27%. Every box is 26 and every svg is 14, so the box
              said nothing about it — only the drawn extent did. */}
          <path d="M8 2v12M2 8h12" strokeLinecap="round" />
        </RailFootButton>
      </div>
    </div>
  )
}

/** A foot control. Icon-only at 44px, so the title carries the name and the chord, and the
 *  accessible name comes from `aria-label` — never from the glyph alone. */
function RailFootButton({ attr, label, hint, onClick, active, strokeWidth = 1.2, children }: {
  attr: string
  label: string
  hint: string
  onClick: () => void
  /** Renders as the current view. Background-only, per the foot's existing hover treatment —
   *  a colour-changing border on a radiused element re-rasterizes in WKWebView. */
  active?: boolean
  /** OPTICAL correction, not a free knob. 1.2 is the shared default; a glyph departs from it
   *  only to cancel a density difference the geometry forces. The grid draws four closed rects
   *  (~72 units of outline) against the plus's two strokes (~24) — a 3:1 mass difference at the
   *  same weight, which is why the two navigation verbs did not read as a pair even once their
   *  extents matched. Nudging them toward each other (1.05 / 1.45) closes it to ~2:1, which is
   *  as far as it goes before the plus reads as a bar and the grid as a ghost. */
  strokeWidth?: number
  children: React.ReactNode
}) {
  const rest = active ? 'var(--overlay-subtle)' : 'transparent'
  const ink = active ? 'var(--fg)' : 'var(--fg-muted)'
  return (
    <button
      {...{ [attr]: '' }}
      onClick={onClick}
      title={`${label} (${hint})`}
      aria-label={label}
      aria-current={active || undefined}
      style={{
        width: 26, height: 26, padding: 0, display: 'grid', placeItems: 'center',
        background: rest, border: 'none', borderRadius: 7,
        color: ink, cursor: 'pointer', outline: 'none',
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = rest; e.currentTarget.style.color = ink }}
    >
      {/* 14px ink in the 26px box — the ONE icon spec shared with the sidebar's footer row,
          which sits 1px away across the hairline and reads as the other arm of this corner.
          At 13 the two rows' glyphs were visibly different weights side by side. */}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
        {children}
      </svg>
    </button>
  )
}

/** One project tile. Its own component so it can own the hover-card hook — the SHARED one
 *  (lib/use-hover-card), which is already hardened for both the row-moves-under-the-cursor
 *  and the cursor-leaves-the-window failures. A new card must not reintroduce either. */
function ProjectTile({ project, activity, current, onOpen, draggable, dragging, onDragStart, onDragEnd }: {
  project: Project
  activity: ProjectActivity
  current: boolean
  onOpen: () => void
  draggable?: boolean
  dragging?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const [hover, setHover] = useState(false)
  const hoverCard = useHoverCard(`rail:${project.id}`)
  const label = projectActivityLabel(activity)
  const accent = projectAccent(project.id)
  return (
    <Fragment>
      <button
        ref={hoverCard.ref as React.RefObject<HTMLButtonElement>}
        data-rail-tile={project.id}
        // The identity colour, exposed so a harness can assert it never moves — it reaches
        // the DOM as three different color-mix expressions, so reading it back off any one
        // of them would be comparing encodings rather than the value.
        data-rail-accent={accent}
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          // The card is anchored to a tile that is about to move out from under the cursor —
          // exactly the case the shared hook hardens against, but the drag never fires the
          // mouseleave that would close it, so it is dismissed explicitly.
          setHover(false)
          hoverCard.onMouseLeave()
          onDragStart?.()
        }}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        aria-label={`${project.name}${label ? ` — ${label.text}` : ''}`}
        aria-current={current || undefined}
        title={`${project.name}${label ? ` — ${label.text}` : ''}`}
        style={{
          position: 'relative', flexShrink: 0, width: 28, height: 28, padding: 0,
          display: 'grid', placeItems: 'center',
          // ROUNDED SQUARE — the grammar that separates a project from a session's circle.
          borderRadius: 7,
          // Transparent badge, per house style: a tint and a hairline of the identity colour,
          // never a solid accent fill. The border is per-project and therefore STATIC — it
          // never changes colour, so it doesn't trip the WKWebView radiused-border rule.
          background: `color-mix(in srgb, ${accent} ${hover ? 26 : 16}%, transparent)`,
          border: `1px solid color-mix(in srgb, ${accent} 38%, transparent)`,
          // laneTextColor folds in each theme's --lane-ink-blend: raw accents collapse to
          // ~1.4:1 as text on the three light palettes.
          color: laneTextColor(accent),
          // "You are here" is a RING, drawn as a box-shadow: a colour-changing BORDER on a
          // radiused element re-rasterizes in WKWebView. A box-shadow is not a border.
          boxShadow: current ? '0 0 0 2px var(--accent)' : 'none',
          fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
          letterSpacing: '0.02em', lineHeight: 1,
          // The tile IS the handle — no grip appears on hover. At 28px in a 44px strip there is
          // nowhere to put one that wouldn't either reserve space at rest or shrink the target.
          opacity: dragging ? 0.4 : 1,
          cursor: 'pointer', outline: 'none', transition: 'background 120ms ease',
        }}
        onMouseEnter={(e) => { setHover(true); hoverCard.onMouseEnter(e) }}
        onMouseLeave={() => { setHover(false); hoverCard.onMouseLeave() }}
      >
        <span data-rail-initials>{projectInitials(project.name)}</span>
        {/* State gets its own channel, overlapping the tile's corner. Nothing at all when
            idle — a permanent grey dot on every tile would be one more thing to look past. */}
        {activity.status !== 'idle' && (
          <span data-rail-pip style={{
            position: 'absolute', right: -3, bottom: -3, display: 'flex', lineHeight: 0,
            pointerEvents: 'none',
          }}>
            <StatusWave status={activity.status} seed={project.id} size={9} accent={accent} />
          </span>
        )}
      </button>
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
                // Same 30%-toward-fg mix the sidebar's collapsed tail uses: bare var(--accent)
                // at this size drops under 3:1 on two of the light palettes.
                color: label.accent ? 'color-mix(in srgb, var(--accent) 70%, var(--fg))' : 'var(--fg-muted)',
              }}>
                {label.text}
              </span>
            )}
          </div>
        </div>
      )}
    </Fragment>
  )
}
