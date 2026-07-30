import { useEffect, useState } from 'react'
import type { Project } from '../../../shared/types'
import { localTime } from '../../lib/local-time'

// The project's dispatch activity log — every routed `OPERATOR-DISPATCH` directive
// (who asked whom to do what, and how it landed). Collapsed by default under the task
// queue; the durable record behind the transient dispatch toasts.

const OUTCOME_LABEL: Record<string, string> = {
  sent: 'sent',         // typed into the live lane
  launched: 'launched', // lane was idle → spawned with the task
  queued: 'queued',     // task queued (legacy records / failed launch)
  unassigned: 'no lane', // role didn't resolve → unassigned backlog
  'pending-approval': 'needs approval', // a non-coordinator lane asked; NOT delivered
  rejected: 'rejected', // declined; never delivered
}

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
                <span data-dispatch-outcome style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: d.outcome === 'sent' || d.outcome === 'launched' ? 'var(--accent)' : 'var(--fg-muted)' }}>
                  {OUTCOME_LABEL[d.outcome] ?? d.outcome}
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
