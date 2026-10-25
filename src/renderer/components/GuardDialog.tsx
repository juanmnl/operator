import { useEffect, useRef } from 'react'
import { StatusWave, type WaveStatus } from './sidebar/StatusWave'
import { guardKeyAction, keepFocus } from '../lib/guard-keys'

// THE APP'S CONFIRM DIALOG FOR ENDING LANES, shared by the quit guard and the project close guard.
// The confirm idiom everywhere else is a two-click arm (CardMenu's `confirm`, the rail row's
// `stop?`), and that is wrong for these two: it cannot name what you are about to lose.
//
// The skeleton is CommandPalette's — scrim + centred panel — with the two literals it hardcodes
// replaced by the tokens that already define them (--radius-lg, --shadow-panel).
//
// THE ASYMMETRY IS THE GUARD. The safe verb takes focus on mount, answers Return, Esc and ⌘., and
// is the bordered shape. The destructive verb has no key at all — pointer only.

const Z = 1100 // above the palette (1000) and toasts (900)

export interface GuardRow {
  key: string
  name: string
  /** Right-aligned state text. */
  state: string
  wave: WaveStatus
  accent?: string
}

export function GuardDialog({ id, title, body, rows, overflow, note, hint, safeVerb, dangerVerb, onSafe, onDanger, restoreFocus }: {
  /** Prefix for the aria ids, so two guards never share one. */
  id: string
  title: string
  body: string
  /** Frozen by the caller. A list that re-orders under a moving pointer is a mis-click generator. */
  rows: GuardRow[]
  overflow: string | null
  /** A line under the rows (the quit guard's idle count, the close guard's mid-turn count). */
  note: string | null
  hint: string
  safeVerb: string
  dangerVerb: string
  onSafe: () => void
  onDanger: () => void
  /** Where focus goes on close when the element that had it is gone or was `body` (review T2). */
  restoreFocus?: () => void
}) {
  const safeRef = useRef<HTMLButtonElement>(null)
  const dangerRef = useRef<HTMLButtonElement>(null)

  // Focus goes back where it was when the dialog closes (lib/guard-keys `keepFocus`, review R5).
  // Read once, at mount: the dialog's own focus is not where it was.
  const restoreFocusRef = useRef(restoreFocus)
  restoreFocusRef.current = restoreFocus
  useEffect(() => {
    const restore = keepFocus(document, () => restoreFocusRef.current?.())
    safeRef.current?.focus()
    return restore
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = guardKeyAction(e)
      if (action === 'safe') {
        e.preventDefault()
        e.stopPropagation()
        onSafe()
        return
      }
      // The app's chords stop here (lib/guard-keys, review R4). preventDefault too: ⌘W's native
      // menu item closes the window when nothing takes it.
      if (action === 'block') {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // Focus is trapped to the two buttons and nothing else — Tab cycles them.
      if (action === 'cycle') {
        e.preventDefault()
        const next = document.activeElement === safeRef.current ? dangerRef.current : safeRef.current
        next?.focus()
      }
    }
    // Capture, so the window's chord handler (⌘K, ⌘W, ⌘N, ⌘1-9) never sees a key while this is up.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onSafe])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: Z,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-body)',
        // Opacity only. The panel does not scale, slide or bounce: motion means BUSY in this
        // app, and the orbs below are the one thing here that is.
        animation: 'quit-guard-in 90ms ease-out',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        style={{
          width: 420, maxWidth: 'calc(100vw - 80px)',
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-panel)',
          padding: '18px 18px 14px',
        }}
      >
        <h2 id={`${id}-title`} style={{
          margin: 0, fontFamily: 'var(--font-disp)', fontSize: 15, fontWeight: 600, color: 'var(--fg)',
        }}>{title}</h2>

        {/* --fg-muted IS the recede; never stack opacity on it. */}
        <p id={`${id}-body`} style={{
          margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)',
        }}>{body}</p>

        <div style={{ height: 1, background: 'var(--border)', margin: '14px 0 10px' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {rows.map((row) => (
            <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <StatusWave status={row.wave} size={13} seed={row.key} accent={row.accent} />
              {/* min-width 0 or a long lane name (sessionLabel can return a whole prompt
                  sentence) pushes the state text off the panel instead of ellipsing. */}
              <span style={{
                flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{row.name}</span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', flexShrink: 0 }}>{row.state}</span>
            </div>
          ))}
          {overflow && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{overflow}</span>
          )}
        </div>

        {note && (
          <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--fg-muted)' }}>{note}</p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: 'var(--fg-muted)' }}>{hint}</span>
          {/* Destructive: borderless, error-coloured, LEFT of the safe verb, no keyboard path. */}
          <button
            ref={dangerRef}
            onClick={onDanger}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            onFocus={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px var(--color-error)' }}
            onBlur={(e) => { e.currentTarget.style.boxShadow = 'none' }}
            style={{
              padding: '6px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 500,
              color: 'var(--color-error)', background: 'transparent', border: 'none',
              borderRadius: 7, outline: 'none',
            }}
          >{dangerVerb}</button>
          <button
            ref={safeRef}
            onClick={onSafe}
            onFocus={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px var(--accent)' }}
            onBlur={(e) => { e.currentTarget.style.boxShadow = 'none' }}
            style={{
              padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
              color: 'var(--fg)', background: 'var(--btn-bg)', border: '1px solid var(--border)',
              borderRadius: 7, outline: 'none',
            }}
          >{safeVerb}</button>
        </div>
      </div>
    </div>
  )
}
