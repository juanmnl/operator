import { useState } from 'react'
import type { Project } from '../../../shared/types'

// The project's dispatch activity log — every routed `OPERATOR-DISPATCH` directive
// (who asked whom to do what, and how it landed). Collapsed by default under the task
// queue; the durable record behind the transient dispatch toasts.

const OUTCOME_LABEL: Record<string, string> = {
  sent: 'sent',       // typed into the live lane
  queued: 'queued',   // lane idle → queued for it
  unassigned: 'no lane', // role didn't resolve → unassigned backlog
}

export function DispatchLog({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  const dispatches = project.dispatches ?? []
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
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {recent.map((d) => {
            const from = roleOf(d.fromRoleId)
            const to = roleOf(d.toRoleId)
            const time = d.at.slice(11, 16) // HH:MM — the date is rarely the point here
            return (
              <div key={d.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 2px', fontSize: 11 }}>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{time}</span>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: from?.accent || 'var(--fg-muted)' }}>{from?.name ?? 'agent'}</span>
                <span style={{ flexShrink: 0, color: 'var(--fg-muted)', fontSize: 10 }}>→</span>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: to?.accent || 'var(--fg-muted)' }}>{to?.name ?? '?'}</span>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.task}>{d.task}</span>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: d.outcome === 'sent' ? 'var(--accent)' : 'var(--fg-muted)' }}>
                  {OUTCOME_LABEL[d.outcome] ?? d.outcome}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
