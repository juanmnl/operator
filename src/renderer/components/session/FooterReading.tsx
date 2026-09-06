import { useRef } from 'react'
import type { AgentSession } from '../../../shared/types'
import { modelFamilyLabel } from '../../lib/roster'
import { toneFor, TONE_FILL, updatedAgo, type PlanLimits } from '../../lib/plan-limits'
import { contextReading, planReading } from '../../lib/footer-reading'

// THE READING AT THE RIGHT OF THE SESSION FOOTER. Design: `dev/results/plan-meter-bottom-bar.md`,
// mock `dev/plan-bar-preview.html`.
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
function Bar({ pct, color, w = 34 }: { pct: number; color: string; w?: number }) {
  return (
    <span style={{ display: 'inline-block', width: w, height: 3, borderRadius: 2, background: 'var(--overlay-subtle)', overflow: 'hidden', verticalAlign: 'middle' }}>
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

export function FooterReading({ session, pinnedEffort, limits, now, onOpenTuning, onOpenRoster }: {
  session: AgentSession
  /** The roster's launch pin, used when the transcript has not reported an effort yet. */
  pinnedEffort?: string
  limits: PlanLimits | null
  /** The hook's clock, so freshness advances with the same tick that decides whether to re-ask. */
  now: number
  onOpenTuning?: () => void
  onOpenRoster?: () => void
}) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: CELL_GAP, flexShrink: 0 }}>
      <Rule />
      <ContextCell session={session} />
      <Rule />
      <ModelCell session={session} pinnedEffort={pinnedEffort} onOpenRoster={onOpenRoster} />
      <Rule />
      <PlanCell limits={limits} now={now} onOpenTuning={onOpenTuning} />
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

function PlanCell({ limits, now, onOpenTuning }: {
  limits: PlanLimits | null; now: number; onOpenTuning?: () => void
}) {
  const { state, rows } = planReading(limits, now)

  const shell = (children: React.ReactNode, title?: string) => (
    <button
      onClick={onOpenTuning}
      title={title ?? 'What is driving this — opens Tuning'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 10,
        border: 'none', background: 'transparent', borderRadius: 4, padding: '2px 4px',
        cursor: onOpenTuning ? 'pointer' : 'default', outline: 'none',
      }}
      onMouseEnter={(e) => { if (onOpenTuning) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >{children}</button>
  )

  // NO DATA NEVER RENDERS AS 0%, in any of these states. That rule is load-bearing in
  // `plan-limits.ts` and this only changes what the three freshness states look like in 34px.
  if (state !== 'current' && state !== 'aging') {
    const ended = state === 'window-closed'
    return shell(
      <>
        <span style={{ ...NUM, fontSize: 10, color: 'var(--fg-muted)' }}>plan</span>
        <Chip tone={ended ? 'var(--yellow)' : undefined}>{ended ? 'window closed' : 'no reading'}</Chip>
      </>,
      ended
        ? 'The plan window this reading described has closed — opens Tuning'
        : 'No plan reading available right now — opens Tuning',
    )
  }

  const age = updatedAgo(limits?.fetchedAt, now)
  return shell(
    <>
      {/* AGING KEEPS ITS NUMBERS — they are still the best thing available, and one dot is the
          only warning there is room for. An EXPIRED one shows no percentage at all, above,
          because by then we genuinely do not know. */}
      {state === 'aging' && (
        <span title={age ? `Updated ${age}` : undefined}
          style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--yellow)', flexShrink: 0 }} />
      )}
      {rows.map((row) => {
        const isBinding = row.binding
        const tone = TONE_FILL[toneFor(row.pct)]
        return (
          <span
            key={row.key}
            // The reset clause VERBATIM, on the binding row — it is already localised and already
            // carries its zone, and re-deriving it is how you print the wrong hour.
            title={isBinding && row.resets ? `${row.label} — ${row.pct}% used, resets ${row.resets}` : `${row.label} — ${row.pct}% used`}
            style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}
          >
            <span style={{ ...NUM, fontSize: 9.5, whiteSpace: 'nowrap', color: isBinding ? 'var(--fg)' : 'var(--fg-muted)' }}>
              {row.label} {row.pct}%
            </span>
            {/* ONLY THE BINDING ROW IS COLOURED. Three amber bars would say three alarms are
                ringing when only one of them can stop you. */}
            <Bar pct={row.pct} color={isBinding ? tone : 'var(--fg-muted)'} w={44} />
            {/* Marked three ways at once, none of them a fill: ink, bar colour, and this 1px
                rule. Straight, so it never lands on a radiused edge. */}
            <span aria-hidden style={{ width: 44, height: 1, background: isBinding ? tone : 'transparent' }} />
          </span>
        )
      })}
    </>,
  )
}
