import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

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

/**
 * One rendered card, standing for one or more byte-identical toasts. Four copies
 * of the same sentence is a rendering artefact, not four pieces of news, so they
 * collapse into a single card carrying a count.
 */
export interface ToastGroup {
  /** Stable card key — the OLDEST occurrence's id, so a repeat increments in place
   *  instead of re-entering at the bottom of the stack. */
  id: string
  /** Every occurrence this card stands for, oldest first. Dismissing clears them all. */
  ids: string[]
  /** The NEWEST occurrence: its `action`/`onClick` are the ones the card offers. */
  message: ToastMessage
  count: number
  /** True when 2+ occurrences carried an action, so the card's button reaches only
   *  the newest of them — the label says "latest" rather than quietly dropping the rest. */
  actionIsLatestOnly: boolean
}

/**
 * What the user perceives as "the same toast": same kind, same headline, same
 * detail line. Deliberately NOT keyed on `action`/`onClick` — those are closures,
 * and the undelivered-dispatch burst that motivated this is precisely N identical
 * sentences whose Show buttons each target a different terminal. Grouping on the
 * closure identity would group nothing.
 */
function coalesceKey(m: ToastMessage): string {
  // Separator is the ESCAPE `\u0000`, never a raw NUL byte typed into the source:
  // one NUL in the file makes git classify Toast.tsx as binary, and every future
  // diff of this component turns into "Bin 6957 -> 15839 bytes". A NUL is still
  // the right separator at runtime — no toast text can contain one, so the fields
  // can't collide the way a space or a pipe would let them.
  return `${m.kind ?? 'info'}\u0000${m.text}\u0000${m.detail ?? ''}`
}

/** Collapse identical toasts, preserving first-seen order. Pure — unit tested. */
export function coalesceToasts(messages: ToastMessage[]): ToastGroup[] {
  const byKey = new Map<string, ToastGroup>()
  // How many occurrences of a key carried their own action — if 2+, the single
  // card's button reaches only one of them and has to say so.
  const actionCount = new Map<string, number>()

  for (const m of messages) {
    const key = coalesceKey(m)
    if (m.action) actionCount.set(key, (actionCount.get(key) ?? 0) + 1)

    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { id: m.id, ids: [m.id], message: m, count: 1, actionIsLatestOnly: false })
      continue
    }
    existing.ids.push(m.id)
    existing.count += 1
    // Newest occurrence wins the action/onClick — the recovery you most likely
    // want is for the thing that just happened. A later occurrence with no action
    // must not blank out an earlier one's.
    if (m.action || m.onClick) existing.message = m
  }

  const groups = [...byKey.values()]
  for (const g of groups) {
    g.actionIsLatestOnly = (actionCount.get(coalesceKey(g.message)) ?? 0) > 1
  }
  return groups
}

interface ToastsProps {
  messages: ToastMessage[]
  onDismiss: (id: string) => void
  /** Clears the listed ids in one state update. Optional: falls back to per-id dismiss.
   *  Takes ids rather than clearing wholesale so a toast that arrives during the
   *  clear-all fade is not silently eaten. */
  onDismissAll?: (ids: string[]) => void
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

/** Cards rendered at once, after coalescing. A card is ~56-72px tall plus an 8px
 *  gap and the column starts 52px down, so four cards plus both stack rows still
 *  clear the bottom of a small window. Older cards fold into a counted marker. */
export const MAX_VISIBLE = 4
/** Below this the stack control is noise: with one card its ✕ is exactly as fast. */
export const DISMISS_ALL_THRESHOLD = 2

export function Toasts({ messages, onDismiss, onDismissAll }: ToastsProps) {
  // The ids caught by a Dismiss all, held for the length of the exit animation.
  // A SET, not a boolean: a toast pushed during the 180ms fade is not in it, so it
  // neither animates out nor gets cleared — it just arrives, as it should.
  const [clearingIds, setClearingIds] = useState<ReadonlySet<string>>(() => new Set())

  // Keep the latest handlers without re-arming the clear timer below.
  const handlersRef = useRef({ onDismiss, onDismissAll })
  handlersRef.current = { onDismiss, onDismissAll }

  const dismissAll = useCallback((ids: string[]) => {
    setClearingIds(new Set(ids))
    // Let every card play its exit before the parent unmounts them.
    setTimeout(() => {
      const h = handlersRef.current
      if (h.onDismissAll) h.onDismissAll(ids)
      else ids.forEach((id) => h.onDismiss(id))
      setClearingIds(new Set())
    }, ANIM_MS)
  }, [])

  const groups = coalesceToasts(messages)
  // Keep the NEWEST cards: the hidden ones are the older news, and they sit above
  // in a stack that grows downward, which is where the marker goes.
  const visible = groups.slice(-MAX_VISIBLE)
  const hiddenCount = groups.length - visible.length

  return (
    <div style={{
      // Top-right: clear of the macOS traffic lights (which live in the left
      // sidebar) and below the drag region / SessionToolbar strip. New toasts
      // stack downward from here.
      position: 'fixed', top: 52, right: 16, zIndex: 900,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
      pointerEvents: 'none',
    }}>
      {hiddenCount > 0 && <StackRow>{`+${hiddenCount} earlier`}</StackRow>}

      {visible.map((g) => (
        <Toast
          key={g.id}
          message={g.message}
          count={g.count}
          actionIsLatestOnly={g.actionIsLatestOnly}
          exiting={g.ids.some((id) => clearingIds.has(id))}
          onDismiss={() => g.ids.forEach(onDismiss)}
        />
      ))}

      {groups.length >= DISMISS_ALL_THRESHOLD && (
        <StackRow
          // Worded, never a bare glyph: the card's ✕ already means "dismiss this
          // one" and two verbs must not share a glyph.
          onClick={clearingIds.size ? undefined : () => dismissAll(messages.map((m) => m.id))}
          title="Clear every notice. The dispatch log keeps its own record."
        >
          Dismiss all
        </StackRow>
      )}
    </div>
  )
}

/**
 * The stack's own chrome — the overflow marker and the Dismiss all control. Same
 * surface and radius as a card but one step quieter, so it reads as the column's
 * frame rather than another notice.
 */
function StackRow({ children, onClick, title }: { children: ReactNode; onClick?: () => void; title?: string }) {
  const [hover, setHover] = useState(false)
  const interactive = !!onClick
  const style: CSSProperties = {
    pointerEvents: interactive ? 'auto' : 'none',
    padding: '4px 10px',
    background: interactive && hover ? 'var(--overlay-medium)' : 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.22)',
    fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.06em',
    // The token IS the recede — never stack opacity on top of --fg-muted.
    color: interactive && hover ? 'var(--fg)' : 'var(--fg-muted)',
    cursor: interactive ? 'pointer' : 'default',
    outline: 'none',
    transition: `color ${ANIM_MS}ms ease, background ${ANIM_MS}ms ease`,
  }

  // The overflow marker is a statement, not a control — a disabled button would
  // put a dead tab stop in the stack.
  if (!interactive) return <div style={style} title={title}>{children}</div>

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    >
      {children}
    </button>
  )
}

function Toast({ message, count, actionIsLatestOnly, exiting, onDismiss }: {
  message: ToastMessage
  count: number
  actionIsLatestOnly: boolean
  exiting: boolean
  onDismiss: () => void
}) {
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
    // Actionable toasts stay until the user acts or dismisses. `count` is in the
    // deps so a repeat re-arms the dwell instead of inheriting the first one's.
    const auto = message.action ? undefined : setTimeout(beginExit, AUTO_DISMISS_MS)
    return () => { cancelAnimationFrame(enter); if (auto) clearTimeout(auto) }
  }, [message.action, count, beginExit])

  // Dismiss all: every card plays its exit together.
  useEffect(() => { if (exiting) beginExit() }, [exiting, beginExit])

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
          {count > 1 && (
            // Transparent chip with a hairline, no fill. An --overlay-subtle wash
            // reads fine on the dark palettes but drags the chip's backdrop toward
            // --fg-muted on the light ones (2.85:1 on Mr Pink light) — measured, so
            // the badge outlines instead of filling and the ink keeps the card's
            // own backdrop.
            // Inline, not a flex sibling: as a sibling it anchors to the right edge
            // and floats away from a headline that wraps. It belongs to the sentence.
            <span
              title={`Happened ${count} times`}
              style={{
                display: 'inline-block', marginLeft: 6, verticalAlign: '1px',
                padding: '0 4px', whiteSpace: 'nowrap',
                background: 'transparent',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700,
                color: 'var(--fg-muted)', letterSpacing: '0.02em',
              }}
            >
              ×{count}
            </span>
          )}
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
          // When several occurrences each carried their own action (each undelivered
          // dispatch's Show targets a different lane), the button can only reach one.
          // Say which one rather than letting the count imply it covers them all.
          title={actionIsLatestOnly ? 'Applies to the most recent occurrence' : undefined}
          style={{
            flexShrink: 0, alignSelf: 'center', padding: '5px 11px',
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.06em',
            whiteSpace: 'nowrap',
            cursor: 'pointer', borderRadius: 'var(--radius-sm)', outline: 'none',
            // Surface button, not an accent fill (per UI rules).
            background: 'var(--btn-bg)', color: 'var(--fg)',
            border: '1px solid var(--border)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-medium)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--btn-bg)' }}
        >
          {actionIsLatestOnly ? `${message.action.label} latest` : message.action.label}
        </button>
      )}

      {/* Explicit dismiss affordance. */}
      <button
        // Must not read as "Dismiss all" — that name belongs to the stack control,
        // and the same rule that stops two verbs sharing a glyph applies to the
        // accessible name a screen reader announces.
        aria-label={count > 1 ? `Dismiss these ${count}` : 'Dismiss'}
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
