import { Fragment, useState } from 'react'
import type { Project } from '../../../shared/types'
import { StatusWave } from './StatusWave'
import { DragRegion } from '../DragRegion'
import { projectActivityLabel, type ProjectActivity } from '../../lib/project-status'
import { byActivityThenRecency } from '../../lib/project-shelf'
import { projectAccent, projectInitials } from '../../lib/project-accent'
import { laneTextColor } from '../../lib/lane-color'
import { useHoverCard } from '../../lib/use-hover-card'

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
  onOpenAgents, agentsActive,
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
}) {
  // Same comparator as the gallery grid and the switcher popover. Never a third ordering.
  const shown = projects
    .filter((p) => (activities[p.id]?.live ?? 0) > 0 || p.id === activeProjectId)
    .sort(byActivityThenRecency(activities))

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
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7,
          padding: '4px 0',
          // @ts-expect-error Electron-specific CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        {shown.map((p) => (
          <ProjectTile
            key={p.id}
            project={p}
            activity={activities[p.id] ?? { live: 0, waiting: 0, lanes: p.roster?.length ?? 0, status: 'idle' }}
            current={p.id === activeProjectId}
            onOpen={() => onOpenProject(p.id)}
          />
        ))}
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
        gap: 4, padding: '8px 0 10px',
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
        <span style={{ width: 22, height: 1, background: 'var(--border)', margin: '5px 0' }} />
        <RailFootButton
          attr="data-rail-gallery"
          label="All projects"
          hint="⌘⇧O"
          onClick={onShowGallery}
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
        >
          <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
        </RailFootButton>
      </div>
    </div>
  )
}

/** A foot control. Icon-only at 44px, so the title carries the name and the chord, and the
 *  accessible name comes from `aria-label` — never from the glyph alone. */
function RailFootButton({ attr, label, hint, onClick, active, children }: {
  attr: string
  label: string
  hint: string
  onClick: () => void
  /** Renders as the current view. Background-only, per the foot's existing hover treatment —
   *  a colour-changing border on a radiused element re-rasterizes in WKWebView. */
  active?: boolean
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
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        {children}
      </svg>
    </button>
  )
}

/** One project tile. Its own component so it can own the hover-card hook — the SHARED one
 *  (lib/use-hover-card), which is already hardened for both the row-moves-under-the-cursor
 *  and the cursor-leaves-the-window failures. A new card must not reintroduce either. */
function ProjectTile({ project, activity, current, onOpen }: {
  project: Project
  activity: ProjectActivity
  current: boolean
  onOpen: () => void
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
