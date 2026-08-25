import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArtifactReport, DispatchRecord } from '../../../shared/types'
import { laneTraffic, type InboxItem } from '../../lib/inbox'
import { PANEL_SUBHEAD_H } from '../../lib/chrome'

// THE MISSING CONSUMER. `artifactReports` was wired at the IPC layer and called from nowhere in
// the renderer, so a report that reached the database was exactly as invisible as one that was
// never sent (`dev/results/agent-comms-audit.md`, loss #2).
//
// The audit is specific that the fix is a DURABLE LIST, not a toast on insert — "sent dispatches
// + their outcome, received reports + ack state, blocked replies + the specific brake that
// stopped them" — because a toast is gone by the time anyone asks what happened.
//
// ACK ON OPEN. Expanding a report is the only moment the system can honestly claim someone read
// it, so that is where `acked_at` is written. Nothing else in this file claims delivery.

export interface InboxPanelProps {
  /** The lane this panel belongs to. */
  role: string
  isCoordinator: boolean
  /** The project's dispatch log — sent, queued, and every blocked one with its brake. */
  records: readonly DispatchRecord[]
}

const POLL_MS = 4000

export function InboxPanel({ role, isCoordinator, records }: InboxPanelProps) {
  const [reports, setReports] = useState<ArtifactReport[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    window.operator.artifactReports?.(200)
      .then((rs) => { setReports(rs ?? []); setFailed(false) })
      .catch(() => setFailed(true))
  }, [])

  // Polled rather than pushed: reports are written by a SEPARATE PROCESS (a lane's MCP call into
  // `--mcp-serve`), so there is no in-renderer event to subscribe to. Four seconds is well inside
  // the time it takes a human to wonder whether a lane reported.
  useEffect(() => {
    load()
    const t = window.setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const items = useMemo(
    () => laneTraffic({ role, isCoordinator, reports, records }),
    [role, isCoordinator, reports, records],
  )

  const toggle = useCallback((item: InboxItem) => {
    const next = open === item.id ? null : item.id
    setOpen(next)
    // ACK ON OPEN, and only for a report addressed here — opening your own outbox row is not
    // someone reading it.
    if (next && item.kind === 'report' && !item.acked) {
      const id = Number(item.id.split(':')[1])
      void window.operator.artifactMarkAcked?.(id).then(load).catch(() => {})
    }
  }, [open, load])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        height: PANEL_SUBHEAD_H, padding: '0 12px', boxSizing: 'border-box',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)',
        textTransform: 'uppercase', letterSpacing: '0.14em',
      }}>
        <span>{items.length} message{items.length === 1 ? '' : 's'}</span>
        <button
          onClick={load}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', outline: 'none', cursor: 'pointer', color: 'var(--fg-muted)', font: 'inherit', letterSpacing: 'inherit', padding: 0 }}
        >refresh</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {failed && (
          <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--fg)' }}>
            Couldn't read the report store.
          </div>
        )}
        {!failed && items.length === 0 && (
          // Says what is TRUE. "No messages" would be the same sentence the broken build would
          // have shown, which is the ambiguity this whole panel exists to remove.
          <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
            Nothing sent to or from this lane yet. Reports land here when a lane calls{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>mcp__operator__report</code>; dispatches
            and replies appear with what happened to them.
          </div>
        )}
        {items.map((item) => (
          <Row key={item.id} item={item} open={open === item.id} onToggle={() => toggle(item)} />
        ))}
      </div>
    </div>
  )
}

function Row({ item, open, onToggle }: { item: InboxItem; open: boolean; onToggle: () => void }) {
  const unread = item.kind === 'report' && !item.acked
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
          padding: '7px 12px', background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer',
        }}
      >
        {/* The kind, as one mono word rather than an icon — three kinds do not need a legend. */}
        <span style={{
          flex: '0 0 52px', fontFamily: 'var(--font-mono)', fontSize: 9,
          textTransform: 'uppercase', letterSpacing: '0.1em',
          color: item.kind === 'blocked' ? 'var(--yellow)' : 'var(--fg-muted)',
        }}>{item.kind === 'report' ? 'report' : item.kind === 'blocked' ? 'blocked' : 'sent'}</span>
        <span style={{ flex: '0 0 76px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.who}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          // Unread is the ONE thing worth weighting: it is the answer to "did I miss something".
          color: 'var(--fg)', fontWeight: unread ? 600 : 400,
        }}>{item.title || '(no summary)'}</span>
        {unread && <span style={{ flex: '0 0 auto', fontSize: 9, color: 'var(--accent)' }}>●</span>}
      </button>
      {open && (
        <div style={{ padding: '0 12px 10px 72px' }}>
          {item.blockedBy && (
            <div style={{ fontSize: 11, color: 'var(--yellow)', marginBottom: 6 }}>
              Not delivered — {item.blockedBy}.
            </div>
          )}
          {item.kind !== 'blocked' && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              {item.at}
              {item.kind === 'report' && ` · ${item.delivered ? 'delivered' : 'not yet announced'}${item.acked ? ' · read' : ''}`}
              {item.outcome && ` · ${item.outcome}`}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--fg)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {item.body || '(empty)'}
          </div>
        </div>
      )}
    </div>
  )
}
