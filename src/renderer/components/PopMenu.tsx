import type { ReactNode } from 'react'

// ONE popover menu, shared. It was private to ChatComposer; the channel composer needs the same
// "pick one of these" affordance for its send target, and a second implementation of a menu is how
// an app ends up with two menus that drift. Positioned `absolute` against the nearest positioned
// ancestor and opening UPWARD (`bottom: calc(100% - 6px)`), because both callers sit at the foot
// of their pane.

export function PopMenu({ title, items, footer, onClose }: {
  title: string
  /** `keepOpen` = the item reveals more UI in this menu (the custom-model row) rather than
   *  committing a choice, so the click must not close it. */
  items: { key: string; label: string; hint?: string; active?: boolean; keepOpen?: boolean; onClick: () => void }[]
  footer?: ReactNode
  onClose: () => void
}) {
  return (
    <div
      style={{
        position: 'absolute', left: 12, right: 12, bottom: 'calc(100% - 6px)', zIndex: 20,
        marginBottom: 6, maxWidth: 260,
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
          onClick={() => { it.onClick(); if (!it.active && !it.keepOpen) onClose?.() }}
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
