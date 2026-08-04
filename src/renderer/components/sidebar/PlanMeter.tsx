import { useCallback, useEffect, useRef, useState } from 'react'
import { useDismiss } from '../../lib/use-dismiss'
import {
  hasCurrentData, freshnessOf, windowEnded, needsRevalidate, limitRows, glanceLine, updatedAgo,
  ringDash, toneFor, TONE_FILL, bindingLimit,
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

// Sized to the corner, not to the 22px box it's drawn in. Drawn ink is 2*(R + STROKE/2), so
// R 8.2 / stroke 2.2 came to 18.6px against the 14px icons either side of it — a third larger,
// and the only saturated thing in a strip of neutral chrome, which made the meter read as the
// corner's primary control. At 16 it is at optical parity (a ring reads smaller than a filled
// glyph at equal size) and still unmistakably a ring. The arc is parametric in R, so the
// reading is unchanged — only the size is.
// Both numbers matter, and the SECOND one is the trap: shrinking the radius alone makes the ring
// proportionally CHUNKIER (at R6/stroke2.2 the band is 18% of the diameter against the original
// 13%), so it stays the loudest thing in the strip no matter how small it gets. Thickness is what
// reads as weight here. 12px across with a 1.5 band is 12.5% — slightly finer than the original
// ratio, which is what makes it recede to telemetry beside the ~11px verbs.
//
// R IS 5.25 BECAUSE THE PAINTED DIAMETER IS 2R + STROKE, NOT 2R. The comment above wanted 12px
// across and set R = 6, which paints 13.5 — the stroke straddles the path, so half of it lies
// outside the radius. That made the meter the largest glyph in the foot (14px measured, against
// 12 for the grid and the plus) while every number in the code said it was the same size, which
// is the exact failure mode this file's own header describes and then repeated. Measured with
// `dev/drive-rail-invariant.mjs`, which diffs screenshots rather than reading boxes.
const R = 5.25
const STROKE = 1.5

export function PlanMeter({ limits, loading, now, onRefresh, onRevalidate, box = 26 }: {
  limits: PlanLimits | null
  loading?: boolean
  /** The glyph box, so this can sit in the rail's foot at the size its neighbours are. The foot
   *  went 26 → 24 when `Sidebar.tsx`'s footer (the row the 26 existed to match) was deleted; the
   *  ring scales with it rather than being redrawn. */
  box?: number
  /** The hook's clock. Passed in rather than read here so the age on screen advances with the
   *  same tick that decides whether to re-ask — one clock, or the two disagree. */
  now: number
  /** Explicit refresh — skips the backend's 5-minute TTL. */
  onRefresh: () => void
  /** Re-ask only if the reading has aged out. Fired on open: the popover is the moment someone
   *  actually reads these numbers, so it is the moment they had better be current. */
  onRevalidate: () => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Popover, not dialog: no focus trap, no full-screen overlay — this is a readout, not a
  // decision. The dismissal itself is the shared contract (lib/use-dismiss): this file had its own
  // Escape + outside-mousedown pair, PopMenu was about to grow a third, and the two would have
  // drifted. The button carries the trigger attribute so a click on it toggles rather than
  // closing-then-reopening.
  useDismiss(open, { panelRef: popRef, onDismiss: () => setOpen(false) })

  // STALE IS NOT CURRENT: past `STALE_MS` with no successful read the meter stops asserting a
  // percentage and degrades to the same "we don't know" it draws for an account with no limits.
  // Everything below reads `known`, so the ring, the arc, the hover line, the rows and the
  // screen-reader label all fall together — a ring still drawing 58% under a popover that says
  // the reading is old is the same lie told twice.
  const known = hasCurrentData(limits, now)
  const fresh = freshnessOf(limits, now)
  const stale = fresh === 'expired'
  const ended = windowEnded(limits, now)
  // The arc draws the BINDING limit — the row furthest along — not the session. One arc gets one
  // job, and the job is "how close am I to being stopped": a 24% session ring above a 65% week is
  // the glance contradicting the popover it stands in for, which is the same failure the staleness
  // work above exists to prevent — one surface asserting what another denies. Its label rides along
  // so the accessible name can say WHICH limit is drawn; a bare percentage is ambiguous now that it
  // isn't always the session. Gated on `known` with everything else: a stale reading has no binding
  // limit to report either.
  const binding = known ? bindingLimit(limits) : null
  const tone = toneFor(binding?.pct)
  const { dash, gap, circumference } = ringDash(binding?.pct ?? null, R)
  const glance = known ? glanceLine(limits) : null
  const rows = known ? limitRows(limits) : []
  const age = updatedAgo(limits?.fetchedAt, now)
  // Three sentences for three genuinely different situations. The ENDED one is the reason this
  // work exists: a percentage next to a reset time that has already passed, both from the same
  // cached reading, is not "possibly out of date" — it is provably describing a window that no
  // longer exists, and saying so is the only honest thing left.
  const emptyLine = loading
    ? 'Reading your plan usage…'
    : ended
      ? `That window closed — the reading was taken ${age} and its own reset time has since passed. Re-reading…`
      : stale
        ? `That reading is ${age} — too old to trust. Refresh to ask again.`
        : limits?.note ?? "No reading yet. Operator asks the Claude CLI for this — it needs a signed-in subscription."

  return (
    <>
      <button
        ref={btnRef}
        data-rail-usage
        data-popmenu-trigger
        data-usage-pct={binding?.pct ?? ''}
        data-usage-binding={binding?.key ?? ''}
        data-usage-stale={stale ? 'true' : undefined}
        data-usage-freshness={fresh}
        aria-label={glance
          ? `Plan usage — ${glance}${binding ? `; closest to its limit: ${binding.label} at ${binding.pct}%` : ''}`
          : 'Plan usage'}
        aria-expanded={open}
        title={glance ?? (loading
          ? 'Reading your plan usage…'
          : stale ? `Plan usage — last read ${age}, too old to show` : 'Plan usage — no reading yet')}
        // Opening is a read, so it is also the cheapest possible moment to re-ask. `onRevalidate`
        // no-ops when the reading is already current, so this costs nothing on a warm meter.
        onClick={() => setOpen((o) => { if (!o) onRevalidate(); return !o })}
        style={{
          width: box, height: box, padding: 0, display: 'grid', placeItems: 'center',
          background: open ? 'var(--overlay-subtle)' : 'transparent',
          border: 'none', borderRadius: 7, cursor: 'pointer', outline: 'none',
          color: 'var(--fg-muted)', transition: 'background 120ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? 'var(--overlay-subtle)' : 'transparent' }}
      >
        {/* The ring. Rotated so the arc starts at 12 o'clock and sweeps clockwise. */}
        {/* 22, NOT `box − 4`. The ring's painted diameter is `2R + STROKE` = 12 units of a 22-unit
            viewBox, so it only measures 12px on screen while the svg renders at 22 — scaling the
            svg with the box (26 → 24) quietly took the ring to 11 and put it out of step with the
            12px glyphs beside it. The box moved; the drawing did not. */}
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

          {/* Past the TTL but the window has not provably closed: the numbers still stand, so
              they stay — but the warning moves out of the footer whisper and above them, since it
              is the only thing telling you they are behind. */}
          {fresh === 'aging' && known && (
            <p data-usage-aging style={{
              margin: '0 0 9px', fontFamily: 'var(--font-mono)', fontSize: 10,
              color: 'var(--status-compacting)',
            }}>
              {`${age} — re-reading…`}
            </p>
          )}

          {rows.map((row) => (
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
            <p data-usage-empty data-usage-empty-kind={stale ? 'stale' : loading ? 'loading' : 'absent'}
              style={{ margin: '2px 0 10px', fontSize: 11, lineHeight: 1.55, color: 'var(--fg-muted)' }}>
              {emptyLine}
            </p>
          )}
          {/* A note alongside real numbers still shows: a partial parse is worth knowing about. */}
          {known && limits?.note && (
            <p data-usage-note style={{ margin: '2px 0 10px', fontSize: 10.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
              {limits.note}
            </p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            {/* Reads `now` from the hook, so this counts up on its own — computed from
                `Date.now()` at render it froze at whatever it said when React last drew, which is
                precisely the freshness claim this whole change exists to stop making. */}
            <span data-usage-updated style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)' }}>
              {loading ? 'Refreshing…' : age ? `Updated ${age}` : 'Not read yet'}
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

/** How often the hook re-examines its own reading. This tick spawns NOTHING — it moves `now`, so
 *  "Updated 4m ago" counts up instead of freezing at whatever it said when React last rendered,
 *  and so `needsRevalidate` gets asked at all. A fetch happens only when that predicate says so. */
const TICK_MS = 30_000

/** Load plan limits, keep them honest, and expose a manual refresh.
 *
 *  It used to read ONCE at mount and never again, which is how a session percentage from a window
 *  that closed hours ago stayed on the ring all day. The backend still owns the cache and the
 *  one-process-at-a-time guard, so the fix is about WHEN to ask, not about asking harder:
 *
 *   - at the moments attention lands — the window regaining focus or visibility, and the popover
 *     being opened (`revalidate`, called from the meter). These are free when the reading is
 *     already current, because they go through `needsRevalidate` first;
 *   - on a slow tick, but ONLY while the document is visible. This is the case the attention
 *     hooks miss: an app left open and focused all day, where nothing ever re-enters. A meter
 *     nobody can see must not spawn a subprocess, so a hidden window ticks not at all.
 *
 *  Which is why this is still not "polling a subprocess per render": the interval moves a clock,
 *  and `FRESH_MS` — the backend's own TTL — decides whether that clock is worth acting on. */
export function usePlanLimits(): {
  limits: PlanLimits | null
  loading: boolean
  now: number
  refresh: () => void
  revalidate: () => void
} {
  const [limits, setLimits] = useState<PlanLimits | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const inFlight = useRef(false)
  // The revalidate path has to read the CURRENT reading without re-subscribing its listeners on
  // every fetch — the same reason the launch path reads role defaults through a ref.
  const limitsRef = useRef<PlanLimits | null>(null)
  limitsRef.current = limits

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

  /** Ask again only if the reading has aged out. Safe to call on every focus and every popover
   *  open — that is the point of it existing separately from `refresh`, which is the user saying
   *  "no, actually go now" and skips both this check and the backend's TTL. */
  const revalidate = useCallback(() => {
    const at = Date.now()
    setNow(at)
    // A window whose own reset time has passed is not merely due a re-check: the cached value is
    // provably describing a window that no longer exists, and the backend would happily serve it
    // again for the rest of its 5-minute TTL. That is the one case worth forcing.
    if (windowEnded(limitsRef.current, at)) read(true)
    else if (needsRevalidate(limitsRef.current, at)) read(false)
  }, [read])

  // Deferred past first paint: app start must never wait on a subprocess. The meter renders
  // empty and fills in.
  useEffect(() => {
    const t = setTimeout(() => read(false), 1200)
    return () => clearTimeout(t)
  }, [read])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined } }
    const start = () => {
      stop()
      // Never leave an interval armed on a hidden window: a backgrounded app should cost nothing,
      // and the visibility handler below re-arms it (and revalidates) the moment it comes back.
      if (document.visibilityState === 'hidden') return
      timer = setInterval(() => {
        const at = Date.now()
        setNow(at)
        if (windowEnded(limitsRef.current, at)) read(true)
        else if (needsRevalidate(limitsRef.current, at)) read(false)
      }, TICK_MS)
    }
    const onVisible = () => {
      start()
      if (document.visibilityState === 'visible') revalidate()
    }
    start()
    document.addEventListener('visibilitychange', onVisible)
    // Focus as well as visibility: a window can be fully visible and simply not the front app,
    // which is most of what "came back after a while" actually looks like on a desktop.
    window.addEventListener('focus', revalidate)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', revalidate)
    }
  }, [read, revalidate])

  return { limits, loading, now, refresh: useCallback(() => read(true), [read]), revalidate }
}
