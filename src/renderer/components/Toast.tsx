import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastMessage {
  id: string
  text: string
  kind?: 'info' | 'success' | 'error'
  /** Optional small detail line under the main text. */
  detail?: string
  /** Optional action button; while present the toast stays until acted on/dismissed. */
  action?: { label: string; run: () => void }
  /** Clicking the toast body runs this (then dismisses) — e.g. focus the session it's about. */
  onClick?: () => void
}

interface ToastsProps {
  messages: ToastMessage[]
  onDismiss: (id: string) => void
}

// Per-kind hue, all semantic theme vars (defined across every theme). Used for
// the status dot and a whisper-faint background wash — never a solid fill or a
// left-border marker stripe.
const COLOR_BY_KIND: Record<NonNullable<ToastMessage['kind']>, string> = {
  info: 'var(--status-running)',
  success: 'var(--color-success)',
  error: 'var(--color-error)',
}

// Enter/leave animation duration; the local exit timer waits this out before the
// parent actually unmounts the toast, so leaving animates instead of popping.
const ANIM_MS = 180
const AUTO_DISMISS_MS = 3500

export function Toasts({ messages, onDismiss }: ToastsProps) {
  return (
    <div style={{
      // Top-right: clear of the macOS traffic lights (which live in the left
      // sidebar) and below the drag region / SessionToolbar strip. New toasts
      // stack downward from here.
      position: 'fixed', top: 52, right: 16, zIndex: 900,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
      pointerEvents: 'none',
    }}>
      {messages.map((m) => (
        <Toast key={m.id} message={m} onDismiss={() => onDismiss(m.id)} />
      ))}
    </div>
  )
}

function Toast({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  const [phase, setPhase] = useState<'enter' | 'in' | 'leaving'>('enter')
  const kind = message.kind || 'info'
  const hue = COLOR_BY_KIND[kind]

  // Keep the latest onDismiss without re-arming the timers below every parent
  // render (the parent hands us a fresh closure each time).
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const leavingRef = useRef(false)

  const beginExit = useCallback(() => {
    if (leavingRef.current) return
    leavingRef.current = true
    setPhase('leaving')
    setTimeout(() => onDismissRef.current(), ANIM_MS)
  }, [])

  useEffect(() => {
    const enter = requestAnimationFrame(() => setPhase('in'))
    // Actionable toasts stay until the user acts or dismisses.
    const auto = message.action ? undefined : setTimeout(beginExit, AUTO_DISMISS_MS)
    return () => { cancelAnimationFrame(enter); if (auto) clearTimeout(auto) }
  }, [message.action, beginExit])

  const leaving = phase === 'leaving'
  const shown = phase === 'in'

  return (
    <div
      onClick={() => { message.onClick?.(); beginExit() }}
      title={message.onClick ? 'Go to session' : undefined}
      style={{
        pointerEvents: 'auto',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 12px 10px 13px',
        // Elevated surface with a whisper of the kind hue mixed in — reads as a
        // tinted panel, not a coloured fill. Border stays neutral (never a
        // colour-changing border on a rounded element → no WKWebView freeze).
        background: `color-mix(in srgb, ${hue} 7%, var(--bg-surface))`,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.28), 0 1px 2px rgba(0,0,0,0.22)',
        fontFamily: 'var(--font-body)',
        cursor: message.onClick ? 'pointer' : 'default',
        minWidth: 260, maxWidth: 360,
        // Enter slides DOWN from above; leave lifts back up. Never recede via a
        // group opacity that would compound across children — this is a single
        // element fade on the whole card, which is fine.
        transform: shown ? 'translateY(0)' : `translateY(${leaving ? -8 : -12}px)`,
        opacity: shown ? 1 : 0,
        transition: `transform ${ANIM_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${ANIM_MS}ms ease`,
      }}
    >
      {/* Status dot: solid kind hue with a soft transparent halo. */}
      <span style={{
        flexShrink: 0, marginTop: 5,
        width: 7, height: 7, borderRadius: '50%',
        background: hue,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${hue} 20%, transparent)`,
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.35, color: 'var(--fg)', fontWeight: 550 }}>
          {message.text}
        </div>
        {message.detail && (
          <div style={{
            fontSize: 10.5, lineHeight: 1.4, color: 'var(--fg-muted)', marginTop: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
          }}>
            {message.detail}
          </div>
        )}
      </div>

      {message.action && (
        <button
          onClick={(e) => { e.stopPropagation(); message.action!.run(); beginExit() }}
          style={{
            flexShrink: 0, alignSelf: 'center', padding: '5px 11px',
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.06em',
            cursor: 'pointer', borderRadius: 'var(--radius-sm)', outline: 'none',
            // Surface button, not an accent fill (per UI rules).
            background: 'var(--btn-bg)', color: 'var(--fg)',
            border: '1px solid var(--border)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-medium)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--btn-bg)' }}
        >
          {message.action.label}
        </button>
      )}

      {/* Explicit dismiss affordance. */}
      <button
        aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); beginExit() }}
        style={{
          flexShrink: 0, alignSelf: 'flex-start', marginTop: -1, marginRight: -2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, padding: 0,
          cursor: 'pointer', borderRadius: 'var(--radius-sm)', outline: 'none',
          background: 'transparent', border: 'none', color: 'var(--fg-muted)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-muted)' }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" />
        </svg>
      </button>
    </div>
  )
}
