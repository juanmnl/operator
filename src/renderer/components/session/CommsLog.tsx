import { useEffect, useState } from 'react'
import type { ArtifactReport, Project } from '../../../shared/types'
import { localTime } from '../../lib/local-time'
import { projectComms, reportStateLabel, rowKey, type CommsRow } from '../../lib/comms'
import { ReportBody } from './ReportBody'

// THE PROJECT'S COMMS RECORD — every routed `OPERATOR-DISPATCH`, every agent→agent reply
// delivery, and every report a lane handed back, on ONE timeline. Who asked whom to do what, how
// it landed, and what came back.
//
// A DIAGNOSTIC, NOT A MAILBOX. Collapsed by default on the Team screen; you open it when
// something looks wrong. It counts nothing that clears by being looked at — the only number in
// its header is `needs approval`, which is a fact about the world that stays true until you act
// on it, not a chore that resolves itself the moment you glance. This is the surface that
// replaced the per-lane Inbox on 2026-08-29; see `lib/comms.ts` for why per-lane lost.
//
// It is the ONLY surface for the agent↔agent brake outcomes. The channel used to fold them into
// the reply's own row; the board deliberately excludes them, because a record with a `replyId` is
// chat about work rather than work (see TaskBoard's WAITING_OUTCOMES). So this is where a
// `hop-limit` or a `pair-brake` is visible at all — which is why it carries no label map of its
// own (an earlier six-entry copy was missing all four brake outcomes, so it printed raw enum
// strings for exactly those records) and reads the shared vocabulary instead.
//
// IT RENDERS ITS HEADER EVEN AT ZERO. An empty surface that hides itself is indistinguishable
// from a broken one, and that ambiguity is the whole reason this record exists.

/** See RosterPanel's WARN_INK: `--color-warning` raw is a dark-field signal colour and fails the
 *  contrast floor as small text on the light palettes. Half way to `--fg` keeps the hue — which is
 *  what makes a held row distinguishable from a delivered one — and clears the bar. */
const WARN_INK = 'color-mix(in srgb, var(--color-warning) 50%, var(--fg))'
/** `progress` — in flight, not finished with. Distinct from `muted` (never arriving) and from
 *  `accent` (arrived). A --fg step-down rather than another hue: three signal colours in one
 *  dense column is a legend, and the distinction that matters here is will-arrive vs won't. */
const PROGRESS_INK = 'color-mix(in srgb, var(--fg) 80%, transparent)'

export function CommsLog({ project, reports, onApprove, onReject }: {
  project: Project
  /** Every report the app knows about; scoped to this project by `projectComms`. */
  reports?: readonly ArtifactReport[]
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
  const [expanded, setExpanded] = useState<string | null>(null)
  const pendingCount = pending.length
  useEffect(() => { if (pendingCount > 0) setOpen(true) }, [pendingCount])

  const roleOf = (id?: string) => project.roster?.find((r) => r.id === id)
  const rows = projectComms({ projectId: project.id, reports: reports ?? [], records: dispatches })

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 14, fontFamily: 'var(--font-body)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', padding: 0, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>▸</span>
        Comms · {rows.length}
        {pending.length > 0 && (
          <span data-dispatch-pending-count style={{ color: 'var(--status-waiting, var(--accent))', letterSpacing: '0.06em' }}>
            · {pending.length} needs approval
          </span>
        )}
      </button>
      {open && rows.length === 0 && (
        // Says what is TRUE. A surface that renders nothing is the same shape a broken one has,
        // which is the ambiguity this whole record exists to remove.
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
          {/* `Dispatches\u00a0appear` — a sentence that begins at a line end must not leave its
              first word stranded past the full stop the reader already took as the stop. */}
          Nothing routed or reported in this project yet. Dispatches&nbsp;appear here with what
          happened to them; a lane&apos;s result lands when it calls{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>mcp__operator__report</code>.
        </div>
      )}
      {open && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {rows.map((row) => (
            <CommsRowView
              key={rowKey(row)}
              row={row}
              fromName={roleOf(row.from)?.name}
              fromAccent={roleOf(row.from)?.accent}
              toName={roleOf(row.to)?.name}
              toAccent={roleOf(row.to)?.accent}
              expanded={expanded === rowKey(row)}
              onToggle={() => setExpanded((k) => (k === rowKey(row) ? null : rowKey(row)))}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CommsRowView({ row, fromName, fromAccent, toName, toAccent, expanded, onToggle, onApprove, onReject }: {
  row: CommsRow
  fromName?: string
  fromAccent?: string
  toName?: string
  toAccent?: string
  expanded: boolean
  onToggle: () => void
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
}) {
  // BRANCH ON THE ENUM, never on the label. `chipForOutcome` owns every word this row prints,
  // and a surface that re-derives meaning by matching its strings is how a second, disagreeing
  // vocabulary gets born — the failure `lib/comms.ts` and `dispatch-outcome.ts` both record.
  const pending = row.kind === 'dispatch' && row.outcome === 'pending-approval'
  // HH:MM LOCAL — the date is rarely the point here. A slice would show UTC.
  const time = localTime(row.at)
  // A REPORT THAT REACHED NOBODY is the one thing in this list that means something is broken
  // right now, so it is the one thing inked as a warning.
  const stateLabel = row.kind === 'report'
    ? reportStateLabel(row.state)
    : row.chip.label.replace(/^held · /, '')
  const stateInk = row.kind === 'report'
    ? (row.state === 'delivered' ? 'var(--fg-muted)' : WARN_INK)
    : row.chip.tone === 'accent' ? 'var(--accent)'
      : row.chip.tone === 'warn' ? WARN_INK
        : row.chip.tone === 'progress' ? PROGRESS_INK
          : 'var(--fg-muted)'

  return (
    <div data-comms-kind={row.kind} data-dispatch-row={row.kind === 'dispatch' ? row.id : undefined}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 2px', fontSize: 11,
        // A faint tint marks the ones still waiting — no left-edge stripe, no border on a
        // radiused element, and no group opacity (it would halve every child's contrast).
        background: pending ? 'var(--overlay-subtle)' : 'transparent',
        borderRadius: pending ? 4 : 0,
      }}>
        <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{time}</span>
        <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: fromAccent || 'var(--fg-muted)' }}>{fromName ?? row.from}</span>
        <span style={{ flexShrink: 0, color: 'var(--fg-muted)', fontSize: 10 }}>→</span>
        <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: toAccent || 'var(--fg-muted)' }}>{toName ?? row.to}</span>
        {/* A REPORT IS THE ONLY EXPANDABLE ROW, and that is its kind marker: it is the only half
            of this list that has a body to open. A dispatch's text is already the whole of it. */}
        {row.kind === 'report' ? (
          <button
            className="comms-expand"
            data-comms-expand={row.id}
            onClick={onToggle}
            aria-expanded={expanded}
            style={{
              flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 5, textAlign: 'left',
              background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', padding: 0,
              fontSize: 11, fontFamily: 'inherit', color: 'var(--fg)',
            }}
          >
            <span style={{ flexShrink: 0, fontSize: 8, color: 'var(--fg-muted)', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none' }}>▸</span>
            {/* The tooltip is the headline plus a taste, never the whole report — a native title
                on a 4000-word summary renders as a screen-tall tooltip you cannot dismiss. */}
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.summary.slice(0, 400)}>
              {row.title || '(no summary)'}
            </span>
            {row.artifacts.length > 0 && (
              <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-muted)' }}>
                {row.artifacts.length} file{row.artifacts.length > 1 ? 's' : ''}
              </span>
            )}
          </button>
        ) : (
          <span style={{ flex: 1, minWidth: 0, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.task}>{row.task}</span>
        )}
        <span data-dispatch-outcome title={stateLabel} style={{
          flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em',
          textTransform: 'uppercase',
          // `--color-warning`, NOT `--status-waiting`: the latter is #2fe39a on Mission Control —
          // the same green as --accent — so a HELD row rendered identically to a delivered one.
          // FOUR tones, four branches. `progress` used to fall through to the muted ink, so the
          // only outcome carrying it drew exactly like `declined` and `no matching lane`. The
          // branch stays so the union is rendered exhaustively and the next tone to be added
          // cannot silently collapse into muted the way this one did.
          color: stateInk,
        }}>
          {/* The chip's own words, minus the `held · ` prefix the row's tint already carries —
              this column is one short column in a dense log, not a sentence. */}
          {stateLabel}
        </span>
        {/* Explicit, PER DISPATCH. No approve-all and no timeout: a timeout that approves is not a
            guardrail, and one button that approves eleven things is how you end up commissioning
            work you never read. */}
        {pending && onApprove && (
          <button
            data-dispatch-approve={row.id}
            onClick={() => onApprove(String(row.id))}
            title={`Deliver this task to ${toName ?? 'the target lane'} now`}
            style={{ flexShrink: 0, padding: '1px 7px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--btn-bg)', color: 'var(--fg)', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}
          >approve</button>
        )}
        {pending && onReject && (
          <button
            data-dispatch-reject={row.id}
            onClick={() => onReject(String(row.id))}
            title="Decline — this task is never delivered"
            style={{ flexShrink: 0, padding: '1px 5px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}
          >reject</button>
        )}
      </div>

      {/* The brake's OWN sentence, persisted at block time. These have existed since the brakes
          shipped and were rendered nowhere; showing them is most of what "naming the brake that
          stopped it" costs. */}
      {row.kind === 'dispatch' && row.note && (
        <div style={{ fontSize: 10, color: WARN_INK, margin: '2px 0 2px 44px', lineHeight: 1.5 }}>ⓘ {row.note}</div>
      )}

      {expanded && row.kind === 'report' && (
        // Bounded and self-scrolling, like the task card's: an expanded 400-line report in a
        // dense log otherwise buries every row after it.
        <div style={{ margin: '4px 0 6px 44px', maxHeight: 340, overflow: 'auto' }}>
          <ReportBody summary={row.summary} artifacts={row.artifacts} />
        </div>
      )}
    </div>
  )
}
