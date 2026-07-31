import { useEffect, useRef, useState } from 'react'
import { useDismiss } from '../lib/use-dismiss'

// THE project actions menu, shared. It was private to ProjectGallery, where it served the card
// and the archived row; the rail's tile wants the same verbs on the same gesture, and a second
// implementation is how an app ends up with two menus that drift (see PopMenu's own note).
//
// Two positioning modes, because the two hosts differ in exactly one way:
//
//   default   `absolute` under the card's ⋯ button, as it always was. The card is a positioned
//             ancestor and nothing clips it.
//   `at`      `fixed` at viewport coordinates. The ProjectRail is 44px at the window's left edge
//             and its tile column is a clipping scroller, so a menu parented to a tile would be
//             cut off at 44px. AccentPicker is rendered up in DashboardView for precisely this
//             reason; `at` is what lets this menu do the same.
//
// Dismissal is `lib/use-dismiss` — the app's ONE contract (outside pointer-down, Escape with
// focus returned, focus leaving, scroll). This used to hand-roll Escape + outside-mousedown,
// which was the third copy of that pair; the hook exists because of it.

/** How long an armed `confirm` item stays armed. Same 2500ms as the sidebar's close button
 *  (SessionItem), so the one destructive gesture in the app behaves the same everywhere. */
export const CONFIRM_MS = 2500

export interface CardMenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  /** Hairline above this item — separates the shelf/delete verbs from the edit ones. */
  separator?: boolean
  /** Requires a second click: the first arms it and relabels, the second fires. For an
   *  action that persists and can't be taken back by re-opening a folder. */
  confirm?: boolean
}

/** Small popover of project verbs. Each item closes it after running, and the panel stops its
 *  own clicks so a host card's onClick never also fires. */
export function CardMenu({ items, onClose, at, title }: {
  items: CardMenuItem[]
  onClose: () => void
  /** Viewport coords of the anchor's top-right; the menu clamps itself onscreen. Absent =
   *  the original absolute placement inside a positioned card. */
  at?: { top: number; left: number }
  /** Names what the verbs act on. The rail's tile carries only a two-letter acronym and its
   *  hover card is dismissed when this opens, so without a header the menu is unattributed —
   *  and `fastrack` / `Fastrack-landing` / `FastTrack` are exactly the projects you'd confuse.
   *  NOT uppercased, unlike the other section labels in the app: a project name is identity,
   *  and case is one of the few things separating those three. */
  title?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Which item is armed, by label. Disarms itself after CONFIRM_MS so a menu left open
  // doesn't stay one stray click away from a delete.
  const [armed, setArmed] = useState<string | null>(null)
  const armTimer = useRef(0)
  useEffect(() => () => clearTimeout(armTimer.current), [])
  useDismiss(true, { panelRef: ref, onDismiss: onClose })

  // Clamp into the viewport once measured, the same way AccentPicker does — a tile near the
  // bottom of the rail would otherwise open its menu below the window with no way to reach it.
  const [pos, setPos] = useState(at ?? null)
  const atTop = at?.top, atLeft = at?.left
  useEffect(() => {
    if (atTop === undefined || atLeft === undefined) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const next = {
      top: Math.max(margin, Math.min(atTop, window.innerHeight - r.height - margin)),
      left: Math.max(margin, Math.min(atLeft, window.innerWidth - r.width - margin)),
    }
    setPos((cur) => (cur && Math.abs(cur.top - next.top) < 0.5 && Math.abs(cur.left - next.left) < 0.5 ? cur : next))
  }, [atTop, atLeft])

  return (
    <div
      ref={ref}
      data-card-menu
      role="menu"
      onClick={(e) => e.stopPropagation()}
      // Right-clicking the menu itself must not raise the native one on top of it.
      onContextMenu={(e) => e.preventDefault()}
      style={{
        ...(at
          ? { position: 'fixed', top: pos?.top ?? at.top, left: pos?.left ?? at.left, zIndex: 80 }
          : { position: 'absolute', top: 30, right: 10, zIndex: 30 }),
        minWidth: 150,
        borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
        background: 'var(--bg-surface)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        overflow: 'hidden', padding: '3px 0',
      }}
    >
      {title && (
        <div data-card-menu-title style={{
          padding: '5px 11px 4px', maxWidth: 220,
          fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
      )}
      {items.map((it) => (
        <div key={it.label}>
          {it.separator && <div style={{ height: 1, margin: '3px 0', background: 'var(--border)' }} />}
          <button
            data-card-menu-item={it.label}
            role="menuitem"
            disabled={it.disabled}
            onClick={(e) => {
              e.stopPropagation()
              if (it.confirm && armed !== it.label) {
                setArmed(it.label)
                clearTimeout(armTimer.current)
                armTimer.current = window.setTimeout(() => setArmed(null), CONFIRM_MS)
                return
              }
              clearTimeout(armTimer.current)
              it.onClick()
              onClose()
            }}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '6px 11px',
              background: 'transparent', border: 'none', outline: 'none',
              cursor: it.disabled ? 'default' : 'pointer', opacity: it.disabled ? 0.4 : 1,
              fontFamily: 'var(--font-body)', fontSize: 11.5,
              color: it.danger ? 'var(--color-error, #f85149)' : 'var(--fg)',
            }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {armed === it.label ? `${it.label} — click again` : it.label}
          </button>
        </div>
      ))}
    </div>
  )
}
