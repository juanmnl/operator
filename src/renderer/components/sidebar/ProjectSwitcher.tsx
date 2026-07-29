import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '../../../shared/types'
import { StatusWave } from './StatusWave'
import { projectActivityLabel, type ProjectActivity } from '../../lib/project-status'
import { relativeTime, tildePath } from '../../lib/format'

// The project switcher — the popover under the sidebar's header row. It is how you move
// between projects without going back to the gallery. Leaving a project stops NOTHING (the
// agents keep running and their card keeps its lit orbs), which the title says out loud.

/** Above this many projects the list gets a type-to-filter field. */
const FILTER_THRESHOLD = 8

export function ProjectSwitcher({
  projects, activeProjectId, activities, onPick, onShowGallery, onOpenFolder, onClose,
}: {
  projects: Project[]
  activeProjectId: string | null
  /** projectId → its rolled-up state (orb + label), from lib/project-status. */
  activities: Record<string, ProjectActivity>
  onPick: (projectId: string) => void
  onShowGallery: () => void
  onOpenFolder: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const showFilter = projects.length > FILTER_THRESHOLD

  // Esc closes the popover WITHOUT leaving the project (spec §4 rule 7); an outside press
  // does the same. Capture phase so a focused field can't swallow the key first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      // The header row is a TOGGLE. Closing here on its mousedown and letting its own click
      // re-open a moment later made the popover impossible to dismiss from the control that
      // opened it — the click looked inert. Let the trigger handle its own toggle.
      if ((target as Element)?.closest?.('[data-switcher-trigger]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) : projects
    // Live first, then most recent — the same read as the gallery's grid.
    return [...list].sort((a, b) =>
      ((activities[b.id]?.live ?? 0) > 0 ? 1 : 0) - ((activities[a.id]?.live ?? 0) > 0 ? 1 : 0)
      || b.lastActiveAt.localeCompare(a.lastActiveAt))
  }, [projects, query, activities])

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 74, left: 8, right: 8, zIndex: 50,
        display: 'flex', flexDirection: 'column', maxHeight: 320,
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
        background: 'var(--bg-surface)', boxShadow: '0 10px 32px rgba(0,0,0,0.35)',
        overflow: 'hidden', fontFamily: 'var(--font-body)',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}
    >
      {showFilter && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter projects…"
          style={{
            flexShrink: 0, boxSizing: 'border-box', width: '100%', padding: '7px 10px',
            background: 'transparent', color: 'var(--fg)', outline: 'none',
            border: 'none', borderBottom: '1px solid var(--border)',
            fontFamily: 'inherit', fontSize: 11.5,
          }}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '3px 0' }}>
        {shown.length === 0 && (
          <div style={{ padding: '8px 11px', fontSize: 11, color: 'var(--fg-muted)' }}>
            No match.
          </div>
        )}
        {shown.map((p) => {
          const activity = activities[p.id] ?? { live: 0, waiting: 0, lanes: p.roster?.length ?? 0, status: 'idle' as const }
          const label = projectActivityLabel(activity)
          const current = p.id === activeProjectId
          return (
            <button
              key={p.id}
              data-switcher-row={p.id}
              onClick={() => onPick(p.id)}
              title={current ? `Back to ${p.name} — its agents, tasks and moodboard` : (p.path || `${p.name} — folder not on record`)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', textAlign: 'left',
                padding: '7px 11px', border: 'none', outline: 'none',
                cursor: 'pointer', fontFamily: 'inherit',
                // "You are here" = a faint surface tint plus accent ink on the name. Never a
                // fill, and never a coloured left-edge stripe.
                background: current ? 'var(--overlay-subtle)' : 'transparent',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-medium)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = current ? 'var(--overlay-subtle)' : 'transparent' }}
            >
              {/* The project's own rolled-up orb, not a decorative dot: it twinkles when
                  something in there is actually working, which is the whole reason to glance
                  at this list before switching. Same language as every other status mark. */}
              <span data-switcher-orb style={{ flexShrink: 0, display: 'flex', marginTop: 1 }}>
                <StatusWave status={activity.status} seed={p.id} size={14} />
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                  <span data-switcher-name style={{
                    flex: 1, minWidth: 0, fontSize: 12,
                    color: current ? 'var(--accent)' : 'var(--fg)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {p.name}
                  </span>
                  {/* This row always DID go to Project Home — it just never said so, which is
                      half of why the project screen read as unreachable. Say it. */}
                  {current && (
                    <span style={{
                      flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9,
                      textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--fg-muted)',
                    }}>
                      home
                    </span>
                  )}
                  {label && (
                    <span data-switcher-state style={{
                      flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5,
                      color: label.accent ? 'var(--accent)' : 'var(--fg-muted)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {label.text}
                    </span>
                  )}
                </span>
                {/* The reference line the popover was missing — same pair the gallery card
                    carries, so switching doesn't mean knowing less than browsing. */}
                <span data-switcher-meta style={{
                  display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0,
                  fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
                }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.path ? tildePath(p.path) : 'folder not on record'}
                  </span>
                  <span style={{ flexShrink: 0 }}>{relativeTime(p.lastActiveAt)}</span>
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: '3px 0' }}>
        <FooterAction label="All projects…" hint="⌘⇧O" onClick={onShowGallery} />
        <FooterAction label="Open folder…" hint="⌘N" onClick={onOpenFolder} />
      </div>
    </div>
  )
}

function FooterAction({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
        padding: '6px 11px', background: 'transparent', border: 'none', outline: 'none',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, color: 'var(--fg-muted)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {label}
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9.5 }}>{hint}</span>
    </button>
  )
}
