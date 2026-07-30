import { useCallback, useEffect, useRef, useState } from 'react'
import {
  hasData, limitRows, glanceLine, updatedAgo, ringDash, toneFor, TONE_FILL, readable,
  type PlanLimits,
} from '../../lib/plan-limits'

// The plan meter — session and weekly limits, permanently visible.
//
// It lives in the RAIL foot beside Agents because the rail persists in every state: expanded,
// collapsed, and at the gallery where the sidebar animates to width 0. The session actions footer
// renders only inside a session, so a control there would be absent exactly when someone deciding
// what to launch wants to know what's left.
//
// 44px has no room for "58%", so the permanent glance is a RING; the popover is the reading. Both
// keep absent and zero apart: no data draws the track alone, never a full or empty-looking bar
// that reads as a number.

const R = 8.2          // ring radius inside a 22px box
const STROKE = 2.2

export function PlanMeter({ limits, loading, onRefresh }: {
  limits: PlanLimits | null
  loading?: boolean
  /** Explicit refresh — skips the backend's 5-minute TTL. */
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Popover, not dialog: Escape closes and focus goes back to the button; an outside click closes.
  // No focus trap, no full-screen overlay — this is a readout, not a decision.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btnRef.current?.focus() }
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown) }
  }, [open])

  const session = readable(limits?.sessionPct)
  const tone = toneFor(session)
  const { dash, gap, circumference } = ringDash(session, R)
  const glance = glanceLine(limits)
  const known = hasData(limits)

  return (
    <>
      <button
        ref={btnRef}
        data-rail-usage
        data-usage-pct={session ?? ''}
        aria-label={glance ? `Plan usage — ${glance}` : 'Plan usage'}
        aria-expanded={open}
        title={glance ?? (loading ? 'Reading your plan usage…' : 'Plan usage — no reading yet')}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 26, height: 26, padding: 0, display: 'grid', placeItems: 'center',
          background: open ? 'var(--overlay-subtle)' : 'transparent',
          border: 'none', borderRadius: 7, cursor: 'pointer', outline: 'none',
          color: 'var(--fg-muted)', transition: 'background 120ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? 'var(--overlay-subtle)' : 'transparent' }}
      >
        {/* The ring. Rotated so the arc starts at 12 o'clock and sweeps clockwise. */}
        <svg width="22" height="22" viewBox="0 0 22 22" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="11" cy="11" r={R} fill="none" stroke="var(--overlay-medium)" strokeWidth={STROKE} />
          {/* Only when there is something to draw — an absent reading shows the track alone. */}
          {known && (
            <circle
              data-usage-arc
              cx="11" cy="11" r={R} fill="none"
              stroke={TONE_FILL[tone]} strokeWidth={STROKE} strokeLinecap="round"
              strokeDasharray={`${dash} ${gap}`}
              // No transition: motion in this app means "busy", and a meter is not busy.
            />
          )}
          {!known && (
            // A dot in the middle so an empty ring doesn't read as a rendering failure.
            <circle cx="11" cy="11" r="1.4" fill="var(--fg-muted)" transform="rotate(90 11 11)" />
          )}
          <title>{glance ?? 'Plan usage'}</title>
        </svg>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {circumference.toFixed(0)}
        </span>
      </button>

      {open && (
        <div
          ref={popRef}
          data-usage-popover
          role="dialog"
          aria-label="Plan usage"
          style={{
            position: 'fixed', left: 50, bottom: 16, zIndex: 60, width: 268,
            padding: '12px 13px 11px', boxSizing: 'border-box',
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            background: 'var(--bg-elevated, var(--bg-sidebar))',
            boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
            fontFamily: 'var(--font-body)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>Plan usage</span>
          </div>
          {limits?.plan && (
            <p style={{ margin: '0 0 10px', fontSize: 10.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
              {limits.plan}
            </p>
          )}

          {limitRows(limits).map((row) => (
            <div key={row.key} data-usage-row={row.key} style={{ marginBottom: 11 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11.5, color: 'var(--fg)' }}>{row.label}</span>
                <span data-usage-value style={{
                  marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5,
                  fontVariantNumeric: 'tabular-nums', color: 'var(--fg)',
                }}>
                  {row.pct}% used
                </span>
              </div>
              {/* NO border on the bar: its fill changes colour at the thresholds, and a
                  colour-changing border on a radiused element re-rasterizes in WKWebView.
                  No gradient, no glow, no animated fill — a bar that animates reads as loading. */}
              <div style={{ height: 4, borderRadius: 2, background: 'var(--overlay-subtle)', overflow: 'hidden' }}>
                <div
                  data-usage-bar={row.key}
                  data-usage-tone={toneFor(row.pct)}
                  style={{ width: `${row.pct}%`, height: '100%', borderRadius: 2, background: TONE_FILL[toneFor(row.pct)] }}
                />
              </div>
              {row.resets && (
                <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)' }}>
                  {/* Verbatim: the string is already localised AND carries its timezone. */}
                  resets {row.resets}
                </p>
              )}
            </div>
          ))}

          {!known && (
            <p data-usage-empty style={{ margin: '2px 0 10px', fontSize: 11, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
              {loading
                ? 'Reading your plan usage…'
                : limits?.note ?? "No reading yet. Operator asks the Claude CLI for this — it needs a signed-in subscription."}
            </p>
          )}
          {/* A note alongside real numbers still shows: a partial parse is worth knowing about. */}
          {known && limits?.note && (
            <p data-usage-note style={{ margin: '2px 0 10px', fontSize: 10.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
              {limits.note}
            </p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <span data-usage-updated style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)' }}>
              {loading ? 'Refreshing…' : updatedAgo(limits?.fetchedAt, Date.now()) ? `Updated ${updatedAgo(limits?.fetchedAt, Date.now())}` : 'Not read yet'}
            </span>
            <button
              data-usage-refresh
              onClick={onRefresh}
              disabled={loading}
              style={{
                marginLeft: 'auto', padding: '2px 9px', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)', background: 'var(--btn-bg)',
                color: loading ? 'var(--fg-muted)' : 'var(--fg)',
                cursor: loading ? 'default' : 'pointer', outline: 'none',
                fontFamily: 'var(--font-body)', fontSize: 11,
              }}
            >Refresh</button>
          </div>
        </div>
      )}
    </>
  )
}

/** Load plan limits once and expose a manual refresh. The backend owns the cache and the
 *  one-process-at-a-time guard, so this is deliberately thin — and it never runs on a timer:
 *  polling a subprocess per render is exactly what the TTL exists to prevent. */
export function usePlanLimits(): { limits: PlanLimits | null; loading: boolean; refresh: () => void } {
  const [limits, setLimits] = useState<PlanLimits | null>(null)
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)

  const read = useCallback((force: boolean) => {
    if (inFlight.current) return // the backend guards this too; this stops the UI flickering
    const p = window.operator.planLimits?.(force)
    if (!p) return
    inFlight.current = true
    setLoading(true)
    void p
      .then((l) => setLimits(l as PlanLimits))
      .catch(() => { /* the command doesn't reject; a missing bridge just leaves it empty */ })
      .finally(() => { inFlight.current = false; setLoading(false) })
  }, [])

  // Deferred past first paint: app start must never wait on a subprocess. The meter renders
  // empty and fills in.
  useEffect(() => {
    const t = setTimeout(() => read(false), 1200)
    return () => clearTimeout(t)
  }, [read])

  return { limits, loading, refresh: useCallback(() => read(true), [read]) }
}
