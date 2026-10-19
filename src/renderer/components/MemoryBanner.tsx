import { useState } from 'react'
import type { MemoryPressureLevel } from '../../shared/types'
import type { BannerCopy } from '../lib/memory-pressure'

/** 32. The strip's fixed height, so the scratch-terminal sheet above the footer can clear it. */
export const MEMORY_BANNER_H = 32

/** The memory-pressure banner (lib/memory-pressure): the last row of the content card, under the
 *  footer, in every mode. A row in the layout rather than a floating card, so it reads as the
 *  window reporting its own state and not as a notification that will fade, and so it never
 *  covers a lane's composer. One line; the text truncates before the button and the close do.
 *
 *  The hue is the toast vocabulary's: warning at 2, error at 4, as a status dot and a faint wash.
 *  The rule on top is neutral and the strip is not radiused (the card clips it). */
export function MemoryBanner({ level, copy, busy, onSuspend, onDismiss }: {
  level: MemoryPressureLevel
  copy: BannerCopy
  busy: boolean
  onSuspend: () => void
  onDismiss: () => void
}) {
  const [hover, setHover] = useState(false)
  const hue = level === 4 ? 'var(--color-error)' : 'var(--color-warning)'
  return (
    <div
      data-memory-banner={level}
      role="status"
      style={{
        flexShrink: 0, height: MEMORY_BANNER_H, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 8px 0 12px',
        background: `color-mix(in srgb, ${hue} 7%, var(--bg-terminal))`,
        borderTop: '1px solid var(--border)',
        fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--fg)',
      }}
    >
      <span aria-hidden style={{
        flexShrink: 0, width: 7, height: 7, borderRadius: '50%',
        background: hue,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${hue} 20%, transparent)`,
      }} />
      <span title={copy.text} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {copy.text}
      </span>
      {copy.action && (
        <button
          data-memory-suspend
          onClick={onSuspend}
          disabled={busy}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          title="Suspend every lane that is between turns and holds nothing unsent. Each resumes its conversation when you open it."
          style={{
            flexShrink: 0, padding: '3px 9px', borderRadius: 'var(--radius-sm)',
            background: hover && !busy ? 'var(--overlay-medium)' : 'var(--btn-bg)',
            border: '1px solid var(--border)', outline: 'none',
            cursor: busy ? 'default' : 'pointer',
            fontFamily: 'inherit', fontSize: 11.5, color: busy ? 'var(--fg-muted)' : 'var(--fg)',
            whiteSpace: 'nowrap',
          }}
        >
          {busy ? 'Suspending…' : copy.action}
        </button>
      )}
      <button
        aria-label="Dismiss"
        onClick={onDismiss}
        title="Hide until memory runs low again"
        style={{
          marginLeft: 'auto', flexShrink: 0, width: 18, height: 18, padding: 0,
          display: 'grid', placeItems: 'center',
          background: 'transparent', border: 'none', borderRadius: 4, outline: 'none',
          color: 'var(--fg-muted)', cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-muted)' }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" />
        </svg>
      </button>
    </div>
  )
}
