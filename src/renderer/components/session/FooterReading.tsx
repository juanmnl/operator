import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentSession } from '../../../shared/types'
import { modelFamilyLabel } from '../../lib/roster'
import { toneFor, TONE_FILL, TONE_INK, updatedAgo, type PlanLimits } from '../../lib/plan-limits'
import {
  contextReading, planReading, planSummary, planCellTitle, planPanelStatus, planPanelPlacement,
  type AnchorRect,
} from '../../lib/footer-reading'
import { useDismiss } from '../../lib/use-dismiss'

// THE READING AT THE RIGHT OF THE SESSION FOOTER. Design: `dev/results/plan-meter-bottom-bar.md`,
// mock `dev/plan-bar-preview.html`; the plan cell's collapse: `dev/results/plan-meter-collapse-RESULT.md`.
//
// Three cells, right to left: this session's context, what it is running, and the plan. The
// session's own numbers sit nearer the session; ambient telemetry sits in the corner.
//
// WHY IT MOVED HERE. The plan reading used to be a 12px unlabelled arc in the rail foot with a
// popover behind it. A one-glyph control cannot carry a three-way distinction, so when the
// per-model row happened to be the binding one the whole thing read as "it's only showing Fable" —
// and the popover spent nine lines of chrome and prose delivering three numbers, in the opposite
// corner of the window from the session you were watching when you asked. None of that was a data
// problem; every function this renders was already written and already tested.
//
// ONE VISUAL LANGUAGE ACROSS THE STRIP: the context bar uses the same `toneFor`/`TONE_FILL`
// thresholds as the plan bars, which is what lets the eye read the whole thing without a legend.

const CELL_GAP = 10

/** Tabular at a fixed width, so a column stays a column when a value changes. */
const NUM: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }

/** A control's label is body ink — never `--fg-muted`, and never an opacity stacked on it. */
const CONTROL_INK = 'color-mix(in srgb, var(--fg) 72%, transparent)'

function k(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** A bar. Background and no border — a radiused element with a changing border colour is the
 *  WKWebView rule this app already carries. */
function Bar({ pct, color, w = 34, h = 3 }: { pct: number; color: string; w?: number | string; h?: number }) {
  return (
    <span style={{ display: 'inline-block', width: w, height: h, borderRadius: 2, background: 'var(--overlay-subtle)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', borderRadius: 2, background: color }} />
    </span>
  )
}

function Rule() {
  return <span aria-hidden style={{ width: 1, height: 14, background: 'var(--border)', flexShrink: 0 }} />
}

/** Transparent, bordered, colour on the text and the border — never a fill. */
function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  const c = tone ?? 'var(--fg-muted)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', height: 14, padding: '0 5px',
      border: `1px solid ${c}`, borderRadius: 3, background: 'transparent', color: c,
      fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

/** The aging marker. A filled dot, never a ring: a dynamic background is cheap, a dynamic border
 *  on a radius is not. */
function AgingDot({ title }: { title?: string }) {
  return <span title={title} style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--yellow)', flexShrink: 0 }} />
}

export function FooterReading({ session, pinnedEffort, limits, now, loading, onOpenTuning, onOpenRoster, onRefresh, onRevalidate }: {
  session: AgentSession
  /** The roster's launch pin, used when the transcript has not reported an effort yet. */
  pinnedEffort?: string
  limits: PlanLimits | null
  /** The hook's clock, so freshness advances with the same tick that decides whether to re-ask. */
  now: number
  /** A plan read is in flight. */
  loading?: boolean
  onOpenTuning?: () => void
  onOpenRoster?: () => void
  /** Force a fresh read — the panel's Refresh. */
  onRefresh?: () => void
  /** Re-read only if the reading has aged out — called when the panel opens. */
  onRevalidate?: () => void
}) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: CELL_GAP, flexShrink: 0 }}>
      <Rule />
      <ContextCell session={session} />
      <Rule />
      <ModelCell session={session} pinnedEffort={pinnedEffort} onOpenRoster={onOpenRoster} />
      <Rule />
      <PlanCell
        limits={limits} now={now} loading={!!loading}
        onOpenTuning={onOpenTuning} onRefresh={onRefresh} onRevalidate={onRevalidate}
      />
    </span>
  )
}

// ── 3.1 context ──────────────────────────────────────────────────────────────────────────────

function ContextCell({ session }: { session: AgentSession }) {
  // THE WIDEST WINDOW EACH SESSION HAS BEEN SHOWN TO HAVE. `inferContextWindow` reads 1M off a
  // prompt bigger than 200k — a 200k lane cannot hold one — but that evidence disappears at the
  // next compaction, and without remembering it a 1M lane at 150k would go back to reading 75%
  // full and "about to compact". Kept per session id, so switching lanes does not carry one
  // lane's answer to another.
  const windows = useRef(new Map<string, number>())
  const known = windows.current.get(session.id)
  const { used, window, pct, compacting, compactions } = contextReading(session, known)
  if (window !== known) windows.current.set(session.id, window)

  // NOT A BUTTON. It describes this session and there is nothing to open.
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...NUM, fontSize: 10, color: 'var(--fg-muted)' }}>
      <span>ctx</span>
      {compacting ? (
        // A TEXT SWAP, NOT AN ANIMATION. Motion in this app means busy, and a moving bar reads as
        // loading — the same note `PlanMeter` keeps about its ring.
        <span style={{ color: 'var(--status-compacting, var(--yellow))' }}>compacting…</span>
      ) : (
        <>
          {/* ABSENT IS NOT ZERO. Before the first assistant turn there is nothing to measure, so
              this draws `—` over a bare track rather than `0k` under a full-looking bar. */}
          <span style={{ color: used ? 'var(--fg)' : 'var(--fg-muted)' }}>
            {used ? k(used) : '—'} / {k(window)}
          </span>
          <Bar pct={pct} color={used ? TONE_FILL[toneFor(pct)] : 'transparent'} />
        </>
      )}
      {/* Only above zero, so its PRESENCE is the signal. */}
      {compactions > 0 && (
        <span
          title={`compacted ${compactions === 1 ? 'once' : compactions === 2 ? 'twice' : `${compactions} times`} this session`}
          style={{ color: 'var(--fg-muted)' }}
        >↺{compactions}</span>
      )}
    </span>
  )
}

// ── 3.2 model · effort ───────────────────────────────────────────────────────────────────────

function ModelCell({ session, pinnedEffort, onOpenRoster }: {
  session: AgentSession; pinnedEffort?: string; onOpenRoster?: () => void
}) {
  // The transcript's own value first — it is what is RUNNING, and a mid-session `/effort` changes
  // it where the launch pin cannot see. The pin is the fallback, and says so.
  const live = session.effort
  const effort = live ?? pinnedEffort
  const fromPin = !live && !!pinnedEffort
  const label = effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : null

  return (
    <button
      onClick={onOpenRoster}
      title={fromPin
        ? `${modelFamilyLabel(session.model)} · ${label} — from the roster pin; this session has not reported an effort yet`
        : 'Model and effort for this lane — opens its roster entry'}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 4,
        border: 'none', background: 'transparent', borderRadius: 4, padding: '2px 4px',
        cursor: onOpenRoster ? 'pointer' : 'default', outline: 'none',
        fontFamily: 'var(--font-mono)', fontSize: 10, color: CONTROL_INK, whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => { if (onOpenRoster) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <span>{modelFamilyLabel(session.model)}</span>
      {label && <span>·</span>}
      {/* A VALUE CARRIES ITS PROVENANCE (`lane-meta`'s rule, one altitude down). There is no room
          for two readings side by side in 34px, so a value known only from the pin takes a 1px
          dotted underline and explains itself in the title. The INK does not change — this is a
          control's label. */}
      {label && (
        <span style={fromPin ? { textDecoration: 'underline dotted', textUnderlineOffset: 2 } : undefined}>
          {label}
        </span>
      )}
    </button>
  )
}

// ── 3.3 plan ─────────────────────────────────────────────────────────────────────────────────
//
// ONE CELL, ONE PANEL. The cell used to lay every limit out inline (`Current session 6% · Current
// week 83% · Current week (Fable) 97%`, three bars), which spent most of the bar's right end on
// telemetry. Collapsed, it names the limit closest to its cap — label, percentage, bar, in that
// limit's tone — and adds `+N` when other limits are also past the warn line, so a second limit
// near its cap is still seen without opening anything. Clicking opens the panel with everything.

function PlanCell({ limits, now, loading, onOpenTuning, onRefresh, onRevalidate }: {
  limits: PlanLimits | null; now: number; loading: boolean
  onOpenTuning?: () => void; onRefresh?: () => void; onRevalidate?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // Outside pointer-down, Escape (focus back to the cell) and focus leaving all close it. Scroll
  // does NOT: the panel is fixed to the window, and the terminal beside it scrolls every time the
  // lane prints.
  useDismiss(open, { panelRef, onDismiss: close, closeOnScroll: false })

  const measure = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setAnchor({ left: r.left, right: r.right, top: r.top })
  }, [])
  // Measured before paint so the panel never flashes at a stale position; re-measured on resize
  // because the cell moves when the window does.
  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, measure])
  // Focus INTO the panel once it exists, so Escape and Tab act on it rather than on the terminal.
  const placed = anchor !== null
  useEffect(() => { if (open && placed) panelRef.current?.focus() }, [open, placed])

  const summary = planSummary(limits, now, loading)
  const age = updatedAgo(limits?.fetchedAt, now)
  const hasPct = summary.label != null && summary.pct != null
  const high = summary.tone !== 'normal'

  return (
    <>
      <button
        ref={triggerRef}
        data-popmenu-trigger
        data-plan-cell
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // Opening is a moment attention lands: re-read if the reading has aged out. Free when it
          // is current, because the hook checks first.
          if (!open) onRevalidate?.()
          setOpen((v) => !v)
        }}
        title={planCellTitle(summary, age)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          border: 'none', borderRadius: 4, padding: '2px 5px', cursor: 'pointer', outline: 'none',
          background: open ? 'var(--overlay-subtle)' : 'transparent',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = 'transparent' }}
        onFocus={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
        onBlur={(e) => { if (!open) e.currentTarget.style.background = 'transparent' }}
      >
        {summary.state === 'aging' && <AgingDot />}
        {hasPct ? (
          <>
            <span style={{ ...NUM, fontSize: 10, whiteSpace: 'nowrap', color: CONTROL_INK }}>
              {summary.label}{' '}
              {/* THE NUMBER CARRIES THE WARNING, in ink that clears contrast; the bar carries it in
                  the raw tone. The label stays a control's label. */}
              <span style={{ color: high ? TONE_INK[summary.tone] : CONTROL_INK }}>{summary.pct}%</span>
            </span>
            <Bar pct={summary.pct!} color={TONE_FILL[summary.tone]} />
            {summary.alsoHigh.length > 0 && (
              <span style={{ ...NUM, fontSize: 9.5, color: TONE_INK[summary.alsoHighTone] }}>
                +{summary.alsoHigh.length}
              </span>
            )}
          </>
        ) : (
          // NO DATA NEVER RENDERS AS 0%. The three unknown states keep their words.
          <>
            <span style={{ ...NUM, fontSize: 10, color: 'var(--fg-muted)' }}>plan</span>
            {summary.state === 'loading'
              ? <span style={{ ...NUM, fontSize: 10, color: 'var(--fg-muted)' }}>…</span>
              : <Chip tone={summary.state === 'window-closed' ? 'var(--yellow)' : undefined}>
                  {summary.state === 'window-closed' ? 'window closed' : 'no reading'}
                </Chip>}
          </>
        )}
        {/* Opens upward, so the caret points up at rest. */}
        <span aria-hidden style={{ fontSize: 8, lineHeight: 1, color: CONTROL_INK }}>{open ? '▾' : '▴'}</span>
      </button>
      {open && anchor && (
        <PlanPanel
          panelRef={panelRef} anchor={anchor}
          limits={limits} now={now} loading={loading}
          onRefresh={onRefresh} onOpenTuning={onOpenTuning} onClose={close}
        />
      )}
    </>
  )
}

/** Everything the plan reading knows, in a panel above the cell.
 *
 *  PORTALLED TO `body` and fixed-positioned from `planPanelPlacement`, so it is always inside the
 *  window and no ancestor's `overflow: hidden` or transform can clip or displace it. */
function PlanPanel({ panelRef, anchor, limits, now, loading, onRefresh, onOpenTuning, onClose }: {
  panelRef: React.RefObject<HTMLDivElement | null>
  anchor: AnchorRect
  limits: PlanLimits | null; now: number; loading: boolean
  onRefresh?: () => void; onOpenTuning?: () => void; onClose: () => void
}) {
  const { state, rows } = planReading(limits, now, loading)
  const place = planPanelPlacement(anchor, { w: window.innerWidth, h: window.innerHeight })
  const age = updatedAgo(limits?.fetchedAt, now)

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Plan usage"
      tabIndex={-1}
      data-no-drag
      data-plan-panel
      style={{
        position: 'fixed', left: place.left, bottom: place.bottom, width: place.width,
        maxHeight: place.maxHeight, overflowY: 'auto', boxSizing: 'border-box', zIndex: 950,
        // The app's floating-panel surface, opaque — see PopMenu for why a tint token fails here.
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
        boxShadow: 'var(--shadow-panel)', outline: 'none', fontFamily: 'var(--font-body)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 2px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
          Plan usage
        </span>
        {limits?.plan && <span style={{ marginLeft: 'auto' }}><Chip>{limits.plan}</Chip></span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 10px', ...NUM, fontSize: 9.5, color: 'var(--fg-muted)' }}>
        {state === 'aging' && <AgingDot />}
        <span>{planPanelStatus(state, age)}</span>
      </div>

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 12px 12px' }}>
          {rows.map((row) => {
            const pct = Math.round(row.pct)
            const tone = toneFor(pct)
            return (
              <div key={row.key} data-plan-row={row.key}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--fg)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.label}
                  </span>
                  {/* EVERY BAR IN ITS OWN TONE, here. The strip coloured only the binding row
                      because three amber bars side by side read as three alarms; in a list where
                      each bar sits beside its own number, a grey bar next to "83%" would disagree
                      with the number. */}
                  <span style={{ marginLeft: 'auto', ...NUM, fontSize: 11, color: TONE_INK[tone] }}>{pct}%</span>
                </div>
                <Bar pct={pct} color={TONE_FILL[tone]} w="100%" h={4} />
                {/* The reset clause VERBATIM — already localised and zoned. */}
                {row.resets && (
                  <div style={{ marginTop: 4, ...NUM, fontSize: 9.5, color: 'var(--fg-muted)' }}>
                    Resets {row.resets}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {limits?.note && (
        <div style={{ padding: '0 12px 10px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--fg-muted)' }}>
          {limits.note}
        </div>
      )}

      {(onRefresh || onOpenTuning) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px', borderTop: '1px solid var(--border)' }}>
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              style={{ ...panelBtn, color: loading ? 'var(--fg-muted)' : CONTROL_INK, cursor: loading ? 'default' : 'pointer' }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >{loading ? 'Refreshing…' : 'Refresh'}</button>
          )}
          {onOpenTuning && (
            <button
              onClick={() => { onClose(); onOpenTuning() }}
              style={{ ...panelBtn, marginLeft: 'auto', color: 'var(--accent)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >Open Tuning →</button>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}

const panelBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', outline: 'none', borderRadius: 5,
  padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 600,
}
