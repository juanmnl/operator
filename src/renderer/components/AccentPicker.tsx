import { useEffect, useRef, useState } from 'react'
import { ACCENT_SWATCHES, normalizeHex, sameAccent } from '../lib/lane-accents'

// Compact swatch popover, anchored to the orb/dot that opened it (right-click).
//
// Fixed-position, like the sidebar's hover cards: the rail and the session list are
// clipping scrollers, so an absolutely-positioned popover would be cut off at their edge.
// Selection reads as a faint tint + an inset ring — never a colour-changing border, which
// re-rasterises a rounded element in WKWebView (the freeze rule), and never a solid accent
// fill for state. The swatch's own colour IS its content, not a state signal.
export function AccentPicker({ top, left, value, title, onPick, onClose }: {
  /** Viewport coords of the anchor's bottom-left; the popover flips/clamps to stay onscreen. */
  top: number
  left: number
  /** The colour currently in effect, ticked in the grid. */
  value?: string
  /** What's being recoloured, e.g. "Code lane" — names the consequence of a pick. */
  title?: string
  onPick: (accent: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hex, setHex] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number }>({ top, left })

  // Esc closes; so does any pointer press outside. Capture phase so a click that also
  // hits a session row closes the popover instead of being swallowed by that row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    // A second right-click elsewhere should move the picker, not leave two behind.
    window.addEventListener('contextmenu', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('contextmenu', onDown, true)
    }
  }, [onClose])

  // Clamp into the viewport once measured — near the window's right/bottom edge the
  // popover would otherwise open offscreen with no way to reach its swatches.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const next = {
      top: Math.max(margin, Math.min(top, window.innerHeight - r.height - margin)),
      left: Math.max(margin, Math.min(left, window.innerWidth - r.width - margin)),
    }
    if (Math.abs(next.top - pos.top) > 0.5 || Math.abs(next.left - pos.left) > 0.5) setPos(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top, left])

  const commitHex = () => {
    const v = normalizeHex(hex)
    if (v) { onPick(v); setHex('') }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title ? `Colour for ${title}` : 'Pick a colour'}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed', top: pos.top, left: pos.left, zIndex: 80,
        padding: 8, width: 148, boxSizing: 'border-box',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {title && (
        <div style={{
          fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--fg-muted)', marginBottom: 6,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {ACCENT_SWATCHES.map((accent) => {
          const picked = sameAccent(accent, value)
          return (
            <button
              key={accent}
              data-accent-swatch={accent}
              aria-label={accent}
              aria-pressed={picked}
              title={accent}
              onClick={() => onPick(accent)}
              style={{
                width: 18, height: 18, padding: 0, borderRadius: 5, cursor: 'pointer',
                // Static border + inset ring for the picked state: the ring is a
                // box-shadow, so no rounded element ever changes border COLOUR.
                border: '1px solid var(--border)',
                background: accent,
                boxShadow: picked
                  ? 'inset 0 0 0 2px var(--bg-surface), 0 0 0 1px color-mix(in srgb, var(--fg) 55%, transparent)'
                  : 'none',
                outline: 'none',
              }}
            />
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 7 }}>
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation() // typing "e"/Escape here shouldn't reach the app's shortcuts
            if (e.key === 'Enter') commitHex()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="#hex"
          maxLength={7}
          spellCheck={false}
          data-accent-hex
          style={{
            flex: 1, minWidth: 0, background: 'transparent',
            border: '1px solid var(--border)', borderRadius: 4,
            color: 'var(--fg)', fontFamily: 'inherit', fontSize: 9.5,
            padding: '2px 5px', outline: 'none',
          }}
        />
        <button
          onClick={commitHex}
          disabled={!normalizeHex(hex)}
          title="Use this hex"
          style={{
            flexShrink: 0, fontSize: 9.5, fontFamily: 'inherit',
            padding: '2px 6px', borderRadius: 4,
            border: '1px solid var(--border)', background: 'transparent',
            // Disabled reads as muted TEXT, not a filled/greyed block.
            color: normalizeHex(hex) ? 'var(--fg)' : 'var(--fg-muted)',
            cursor: normalizeHex(hex) ? 'pointer' : 'default',
            outline: 'none',
          }}
        >
          Set
        </button>
      </div>
    </div>
  )
}
