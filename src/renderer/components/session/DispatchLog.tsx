import { useEffect, useState } from 'react'
import type { Project } from '../../../shared/types'
import { localTime } from '../../lib/local-time'
import { chipForOutcome } from '../../lib/dispatch-outcome'

// The project's dispatch activity log — every routed `OPERATOR-DISPATCH` directive AND every
// agent→agent reply delivery (who asked whom to do what, and how it landed). Collapsed by
// default on the Team screen; the durable record behind the transient dispatch toasts.
//
// It is now the ONLY surface for the agent↔agent brake outcomes. The channel used to fold them
// into the reply's own row; the board deliberately excludes them, because a record with a
// `replyId` is chat about work rather than work (see TaskBoard's WAITING_OUTCOMES). So this is
// where a `hop-limit` or a `pair-brake` is visible at all — which is why it stopped carrying its
// own six-entry label map (missing all four brake outcomes, so it printed raw enum strings for
// exactly those records) and reads the shared vocabulary instead.

/** See RosterPanel's WARN_INK: `--color-warning` raw is a dark-field signal colour and fails the
 *  contrast floor as small text on the light palettes. Half way to `--fg` keeps the hue — which is
 *  what makes a held row distinguishable from a delivered one — and clears the bar. */
const WARN_INK = 'color-mix(in srgb, var(--color-warning) 50%, var(--fg))'
/** `progress` — in flight, not finished with. Distinct from `muted` (never arriving) and from
 *  `accent` (arrived). A --fg step-down rather than another hue: three signal colours in one
 *  dense column is a legend, and the distinction that matters here is will-arrive vs won't. */
const PROGRESS_INK = 'color-mix(in srgb, var(--fg) 80%, transparent)'

export function DispatchLog({ project, onApprove, onReject }: {
  project: Project
  /** Approve a held dispatch — delivers it. Absent = read-only log. */
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
}) {
  const dispatches = project.dispatches ?? []
  const pending = dispatches.filter((d) => d.outcome === 'pending-approval')
  // A pending dispatch that is invisible is just a dropped one, so the section starts OPEN when
  // something is waiting instead of hiding it behind the collapsed default — and re-opens if one
  // arrives while you're looking elsewhere. Still collapsible by hand afterwards.
  const [open, setOpen] = useState(pending.length > 0)
  const pendingCount = pending.length
  useEffect(() => { if (pendingCount > 0) setOpen(true) }, [pendingCount])
  if (dispatches.length === 0) return null
  const roleOf = (id?: string) => project.roster?.find((r) => r.id === id)
  const recent = [...dispatches].reverse() // newest first

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 14, fontFamily: 'var(--font-body)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', padding: 0, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>▸</span>
        Dispatches · {dispatches.length}
        {pending.length > 0 && (
          <span data-dispatch-pending-count style={{ color: 'var(--status-waiting, var(--accent))', letterSpacing: '0.06em' }}>
            · {pending.length} needs approval
          </span>
        )}
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {recent.map((d) => {
            const from = roleOf(d.fromRoleId)
            const to = roleOf(d.toRoleId)
            // HH:MM LOCAL — the date is rarely the point here. A slice would show UTC.
            const time = localTime(d.at)
            const isPending = d.outcome === 'pending-approval'
            const chip = chipForOutcome(d.outcome)
            return (
              <div key={d.id} data-dispatch-row={d.id} style={{
                display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 2px', fontSize: 11,
                // A faint tint marks the ones still waiting — no left-edge stripe, no border on a
                // radiused element, and no group opacity (it would halve every child's contrast).
                background: isPending ? 'var(--overlay-subtle)' : 'transparent',
                borderRadius: isPending ? 4 : 0,
              }}>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{time}</span>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: from?.accent || 'var(--fg-muted)' }}>{from?.name ?? 'agent'}</span>
                <span style={{ flexShrink: 0, color: 'var(--fg-muted)', fontSize: 10 }}>→</span>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: to?.accent || 'var(--fg-muted)' }}>{to?.name ?? '?'}</span>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.task}>{d.task}</span>
                <span data-dispatch-outcome title={chip.label} style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em', textTransform: 'uppercase', // `--color-warning`, NOT `--status-waiting`: the latter is #2fe39a on Mission Control — the
                  // same green as --accent — so a HELD row rendered identically to a delivered one. The
                  // rehomed brakes driver caught it: "blocked NOT the same colour as delivered: false".
                  // FOUR tones, four branches. `progress` used to fall through to the muted
                  // ink, so the only outcome carrying it drew exactly like `declined` and
                  // `no matching lane`. Same defect class as the --status-waiting one two
                  // comments up, one tone over. `progress` has no user today (its one holder,
                  // `queued`, turned out to mean "not delivered" and moved to `warn`) — the
                  // branch stays so the union is rendered exhaustively and the next tone to be
                  // added cannot silently collapse into muted the way this one did.
                  color: chip.tone === 'accent' ? 'var(--accent)'
                    : chip.tone === 'warn' ? WARN_INK
                      : chip.tone === 'progress' ? PROGRESS_INK
                        : 'var(--fg-muted)' }}>
                  {/* The chip's own words, minus the `held · ` prefix the row's tint already
                      carries — this column is one short column in a dense log, not a sentence. */}
                  {chip.label.replace(/^held · /, '')}
                </span>
                {/* Explicit, PER DISPATCH. No approve-all and no timeout: a timeout that approves
                    is not a guardrail, and one button that approves eleven things is how you end
                    up commissioning work you never read. */}
                {isPending && onApprove && (
                  <button
                    data-dispatch-approve={d.id}
                    onClick={() => onApprove(d.id)}
                    title={`Deliver this task to ${to?.name ?? 'the target lane'} now`}
                    style={{ flexShrink: 0, padding: '1px 7px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--btn-bg)', color: 'var(--fg)', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}
                  >approve</button>
                )}
                {isPending && onReject && (
                  <button
                    data-dispatch-reject={d.id}
                    onClick={() => onReject(d.id)}
                    title="Decline — this task is never delivered"
                    style={{ flexShrink: 0, padding: '1px 5px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}
                  >reject</button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
