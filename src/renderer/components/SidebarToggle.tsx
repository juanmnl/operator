// The one control that collapses and expands the sidebar.
//
// It lived inline in `SessionToolbar`, and the recorded rationale for not copying it elsewhere was
// sound as far as it went: "SessionToolbar's is the single persistent one — it works in both
// states, so a second copy is the same control twice." But SessionToolbar is drawn for the SESSION
// content mode only, so in the channel and at Project Home there was no toggle at all — and once
// collapsed, no way back.
//
// Shared rather than re-implemented per surface, so "one concept, one control" stays true as it
// spreads: the three toolbar headers now render the same component in the same position, and a
// user switching between them sees the control stay put rather than move or vanish.
//
// ⌘B does this too and always has (registered in `lib/key-routing`'s `isAppChord`, so the terminal
// does not swallow it). The chord was never the gap; discoverability was.

export function SidebarToggle({ collapsed, onToggle, focusRing = true }: {
  collapsed?: boolean
  onToggle: () => void
  /** The channel's header is a DragRegion with its own focus conventions; keep the ring anyway. */
  focusRing?: boolean
}) {
  return (
    <button
      data-sidebar-toggle
      onClick={onToggle}
      title={collapsed ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
      aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-pressed={!collapsed}
      style={{
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 22, padding: 0,
        background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
        color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
        // @ts-expect-error Electron-specific CSS property
        WebkitAppRegion: 'no-drag',
      }}
      // A real focus state of its own — the house rule removes browser focus rings, and a
      // box-shadow also dodges the radiused-element border trap.
      onFocus={(e) => { if (focusRing) e.currentTarget.style.boxShadow = 'inset 0 0 0 1px var(--accent)' }}
      onBlur={(e) => { e.currentTarget.style.boxShadow = 'none' }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-muted)' }}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3.25" width="12" height="9.5" rx="1.6" />
        <line x1="6.25" y1="3.25" x2="6.25" y2="12.75" />
      </svg>
    </button>
  )
}
