import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useDismiss } from '../lib/use-dismiss'

// ONE popover menu, shared, and a second implementation of it is how an app ends up with two
// menus that drift. Positioned `absolute` against the nearest positioned ancestor.
//
// `placement` because the callers no longer agree on a direction: a composer at the foot of its
// pane opens UPWARD and stretches to the pane's width, while a toolbar chip at the top of the
// window opens DOWNWARD and hangs from its own right edge. Same menu, two anchors — the
// alternative was a second component, which is the thing this file exists to prevent.
//
// `data-no-drag` on the panel: a toolbar is a `DragRegion`, and `-webkit-app-region: drag`
// INHERITS, so without the opt-out every item in this menu would be a window-drag handle
// instead of a button. Harmless where there is no drag region.

export function PopMenu({ title, items, footer, placement = 'up', onClose }: {
  title: string
  /** `keepOpen` = the item reveals more UI in this menu (the custom-model row) rather than
   *  committing a choice, so the click must not close it. */
  items: { key: string; label: string; hint?: string; active?: boolean; keepOpen?: boolean; onClick: () => void }[]
  footer?: ReactNode
  /** `up` = the composer anchor (full pane width, above the trigger). `down` = the toolbar
   *  anchor (hangs from the trigger's right edge, below it). */
  placement?: 'up' | 'down'
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  // The full dismissal contract — outside pointer-down, Escape (with focus returned to the
  // trigger), focus leaving, and scroll. It was doing none of them: the menu only closed when you
  // picked something, so clicking anywhere else left it open over the feed.
  useDismiss(true, { panelRef, onDismiss: onClose })
  return (
    <div
      ref={panelRef}
      data-no-drag
      style={{
        position: 'absolute', zIndex: 20, maxWidth: 260,
        ...(placement === 'down'
          ? { top: 'calc(100% + 6px)', right: 0, minWidth: 160 }
          : { left: 12, right: 12, bottom: 'calc(100% - 6px)', marginBottom: 6 }),
        borderRadius: 10, border: '1px solid var(--border)',
        // AN OPAQUE SURFACE. This was `--overlay-medium`, which is a translucent TINT token — 12%
        // white on the dark palettes, 10% black on the light ones — meant for washing something
        // that already has a background, like a hover state or a selected row. A floating panel
        // has nothing behind it but the content it covers, so at 10% the feed read straight
        // through the menu and the items were unreadable, worst on light.
        // `--bg-surface` is the app's established floating-panel surface; the rail's hover card
        // and the reading panels already use it, so this matches rather than invents.
        background: 'var(--bg-surface)',
        // The blur is GONE, not kept as taste: it was doing the job the background should have
        // been doing, and it cannot do it — a blur displaces detail, it does not hide contrast, so
        // dense text stayed legible straight through 8px of it. With an opaque surface it would
        // now composite against nothing and cost a filter pass for no pixels.
        boxShadow: '0 10px 32px rgba(0,0,0,0.35)', overflow: 'hidden',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-muted)', padding: '8px 12px 4px', fontFamily: 'var(--font-mono)' }}>{title}</div>
      {items.map((it) => (
        <button
          key={it.key}
          data-popmenu-item={it.key}
          // Any choice closes, including re-picking the one already active. The `!it.active` guard
          // that used to be here meant clicking the selected row did nothing at all — no change and
          // no dismissal — which reads as a stuck menu rather than as a no-op.
          onClick={() => { it.onClick(); if (!it.keepOpen) onClose?.() }}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
            padding: '7px 12px', border: 'none', background: 'transparent', outline: 'none', cursor: 'pointer',
            color: it.active ? 'var(--accent)' : 'var(--fg)', fontFamily: 'inherit', fontSize: 12,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--overlay-subtle)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span style={{ flexShrink: 0 }}>{it.label}</span>
          {it.hint && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-muted)' }}>{it.hint}</span>}
          {it.active && <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>}
        </button>
      ))}
      {footer}
    </div>
  )
}
