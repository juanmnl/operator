import { useEffect, useMemo, useRef } from 'react'
import { StatusWave } from './sidebar/StatusWave'
import { quitGuardCopy, quitGuardRows, type LaneIdentity, type QuitRequest } from '../lib/quit-guard'

// THE APP'S FIRST REAL DIALOG. The confirm idiom everywhere else is a two-click arm (CardMenu's
// `confirm`, SessionItem's `×?`), and that is wrong here for two reasons: it cannot name what
// you are about to lose, and there is no hover target on a ⌘Q.
//
// The skeleton is CommandPalette's — scrim + centred panel — with the two literals it hardcodes
// replaced by the tokens that already define them (--radius-lg, --shadow-panel), so this can be
// the precedent rather than a second copy of the palette's private values.
//
// THE ASYMMETRY IS THE GUARD. `Stay open` takes focus on mount, answers Return, Esc and ⌘., and
// is the bordered shape. The destructive verb has no key at all — pointer only. ⌘Q while this is
// open does nothing (Rust holds `prompting`), so nobody quits by double-firing the shortcut.

const Z = 1100 // above the palette (1000) and toasts (900)

export function QuitGuard({ request, identify, onStay, onQuit }: {
  /** The frozen snapshot from Rust. Deliberately not live: a list that re-orders or a dialog
   *  that vanishes under a moving pointer is a mis-click generator, and a mis-click here is the
   *  accident again. */
  request: QuitRequest
  identify: (terminalId: string) => LaneIdentity | undefined
  onStay: () => void
  onQuit: () => void
}) {
  const stayRef = useRef<HTMLButtonElement>(null)
  const quitRef = useRef<HTMLButtonElement>(null)
  const copy = useMemo(() => quitGuardCopy(request), [request])
  const { rows } = useMemo(() => quitGuardRows(request, identify), [request, identify])

  useEffect(() => { stayRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.key === '.' && e.metaKey)) {
        e.preventDefault()
        e.stopPropagation()
        onStay()
        return
      }
      // Focus is trapped to the two buttons and nothing else — Tab cycles them.
      if (e.key === 'Tab') {
        e.preventDefault()
        const next = document.activeElement === stayRef.current ? quitRef.current : stayRef.current
        next?.focus()
      }
    }
    // Capture, so a chord handler further down (⌘K, ⌘W, ⌘1-9) never sees a key aimed at this.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onStay])

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
        aria-labelledby="quit-guard-title"
        aria-describedby="quit-guard-body"
        style={{
          width: 420, maxWidth: 'calc(100vw - 80px)',
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-panel)',
          padding: '18px 18px 14px',
        }}
      >
        <h2 id="quit-guard-title" style={{
          margin: 0, fontFamily: 'var(--font-disp)', fontSize: 15, fontWeight: 600, color: 'var(--fg)',
        }}>{copy.title}</h2>

        {/* --fg-muted IS the recede; never stack opacity on it. */}
        <p id="quit-guard-body" style={{
          margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)',
        }}>{copy.body}</p>

        <div style={{ height: 1, background: 'var(--border)', margin: '14px 0 10px' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {rows.map((row) => (
            <div key={row.terminalId} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <StatusWave status={row.phase} size={13} seed={row.terminalId} accent={row.accent} />
              {/* min-width 0 or a long lane name (sessionLabel can return a whole prompt
                  sentence) pushes the state text off the panel instead of ellipsing. */}
              <span style={{
                flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{row.name}</span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', flexShrink: 0 }}>{row.state}</span>
            </div>
          ))}
          {copy.overflow && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{copy.overflow}</span>
          )}
        </div>

        {copy.idle && (
          <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--fg-muted)' }}>{copy.idle}</p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: 'var(--fg-muted)' }}>{copy.hint}</span>
          {/* Destructive: borderless, error-coloured, LEFT of the safe verb, no keyboard path. */}
          <button
            ref={quitRef}
            onClick={onQuit}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            onFocus={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px var(--color-error)' }}
            onBlur={(e) => { e.currentTarget.style.boxShadow = 'none' }}
            style={{
              padding: '6px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 500,
              color: 'var(--color-error)', background: 'transparent', border: 'none',
              borderRadius: 7, outline: 'none',
            }}
          >{copy.quitVerb}</button>
          <button
            ref={stayRef}
            onClick={onStay}
            onFocus={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px var(--accent)' }}
            onBlur={(e) => { e.currentTarget.style.boxShadow = 'none' }}
            style={{
              padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
              color: 'var(--fg)', background: 'var(--btn-bg)', border: '1px solid var(--border)',
              borderRadius: 7, outline: 'none',
            }}
          >{copy.stayVerb}</button>
        </div>
      </div>
    </div>
  )
}
