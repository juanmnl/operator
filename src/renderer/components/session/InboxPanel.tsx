import { useCallback, useMemo, useState } from 'react'
import type { ArtifactReport, DispatchRecord } from '../../../shared/types'
import { laneComms, type CommsRow } from '../../lib/inbox'
import { PANEL_SUBHEAD_H } from '../../lib/chrome'

// THE MISSING CONSUMER. `artifactReports` was wired at the IPC layer and called from nowhere in
// the renderer, so a report that reached the database was exactly as invisible as one that was
// never sent (the audit's loss #2).
//
// Built to `dev/results/inbox-outbox-design.md` as reconciled in `inbox-outbox-reconcile.md`:
// ONE chronological list (A2 — the question is "what happened with this lane", and the answer is
// chronological), ack-on-open (A1 — expanding a report is the only moment the system can honestly
// claim someone read it) with `mark unread` for reversibility, and every outcome label from
// `chipForOutcome` via lib/inbox, never rewritten here (D1).

/** `color-mix(… var(--color-warning) 50%, var(--fg))`, the ink `RosterPanel` and `DispatchLog`
 *  already use — and they use it because the RAW token measured 3.05 / 3.03 / 1.86:1 as small
 *  text on the three light palettes, i.e. invisible on 1984-light. This surface draws warn ink at
 *  9px and 11px, which is exactly the size that fails (D2). */
const WARN_INK = 'color-mix(in srgb, var(--color-warning) 50%, var(--fg))'

export interface InboxPanelProps {
  role: string
  isCoordinator: boolean
  records: readonly DispatchRecord[]
  /** Lane accent, for the unread marker. */
  accent?: string
  /** Reports, fetched once in DashboardView and shared with the rail/toolbar counts, so this
   *  panel is not the only thing that knows the number (D3). */
  reports: readonly ArtifactReport[]
  onRefresh: () => void
}

/** The markdown-freeze cap, applied to artifact bodies for the same reason. */
const ARTIFACT_CAP = 16 * 1024

export function InboxPanel({ role, isCoordinator, records, accent, reports, onRefresh }: InboxPanelProps) {
  const [open, setOpen] = useState<string | null>(null)

  const rows = useMemo(
    () => laneComms({ role, isCoordinator, reports, records }),
    [role, isCoordinator, reports, records],
  )

  const toggle = useCallback((row: CommsRow) => {
    const key = `${row.kind}:${row.id}`
    const next = open === key ? null : key
    setOpen(next)
    // ACK ON OPEN, and only for a report addressed HERE — opening your own outbox row is not
    // somebody else reading it.
    if (next && row.kind === 'received' && row.state !== 'acked') {
      void window.operator.artifactMarkAcked?.(row.id).then(onRefresh).catch(() => {})
    }
  }, [open, onRefresh])

  const markUnread = useCallback((id: number) => {
    void window.operator.artifactMarkUnread?.(id).then(onRefresh).catch(() => {})
  }, [onRefresh])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        height: PANEL_SUBHEAD_H, padding: '0 12px', boxSizing: 'border-box',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)',
        textTransform: 'uppercase', letterSpacing: '0.14em',
      }}>
        <span>{rows.length} message{rows.length === 1 ? '' : 's'}</span>
        <button onClick={onRefresh} style={{ ...linkBtn, marginLeft: 'auto', letterSpacing: 'inherit' }}>refresh</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {rows.length === 0 && (
          // Says what is TRUE. "No messages" is the same sentence the broken build would have
          // shown, which is the ambiguity this whole surface exists to remove.
          <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
            Nothing sent to or from this lane yet. Reports land here when a lane calls{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>mcp__operator__report</code>; dispatches
            appear with what happened to them.
          </div>
        )}
        {rows.map((row) => (
          <Row
            key={`${row.kind}:${row.id}`}
            row={row}
            accent={accent}
            open={open === `${row.kind}:${row.id}`}
            onToggle={() => toggle(row)}
            onMarkUnread={markUnread}
          />
        ))}
      </div>
    </div>
  )
}

function Row({ row, accent, open, onToggle, onMarkUnread }: {
  row: CommsRow; accent?: string; open: boolean; onToggle: () => void; onMarkUnread: (id: number) => void
}) {
  const unread = row.kind === 'received' && row.state !== 'acked'
  const warn = row.kind === 'sent' && row.chip.tone === 'warn'
  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '7px 12px' }}>
      <button onClick={onToggle} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', outline: 'none', cursor: 'pointer', padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          {/* A MARKER, never a dimmer — the house rule the 0.17.2 orb mute was measured against.
              And the ONLY unread channel: a weight shift on the title would be a second one, and
              on a dense list it is what stops resting rows receding. */}
          <span style={{ flex: '0 0 6px', fontSize: 9, color: unread ? (accent || 'var(--accent)') : 'transparent' }}>●</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>
            {/* `→` is the sent-direction glyph and is used for nothing else here; a received row
                is marked by the dot, not by a mirrored arrow. */}
            {row.kind === 'received' ? row.from : `→ ${row.to}`}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)' }}>{row.at.slice(11, 16)}</span>
          <span style={{
            marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9,
            color: warn || (row.kind === 'received' && row.state === 'written') ? WARN_INK : 'var(--fg-muted)',
          }}>
            {row.kind === 'sent' ? row.chip.label : row.state === 'written' ? 'unread' : row.state}
          </span>
        </div>
        <div style={{ fontSize: 11, color: unread ? 'var(--fg)' : 'var(--fg-muted)', margin: '3px 0 0 14px', lineHeight: 1.5 }}>
          {row.title || '(no summary)'}
        </div>
      </button>

      {row.kind === 'received' && row.artifacts.length > 0 && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', margin: '3px 0 0 14px' }}>
          {row.artifacts.length} artifact{row.artifacts.length === 1 ? '' : 's'}
          {row.artifacts[0]?.name ? ` · ${row.artifacts[0].name}` : ''}
        </div>
      )}

      {/* The brake's OWN sentence, persisted at block time. These have existed since the brakes
          shipped and have been rendered nowhere; showing them is most of what "naming the brake
          that stopped it" costs. */}
      {row.kind === 'sent' && row.note && (
        <div style={{ fontSize: 10, color: WARN_INK, margin: '4px 0 0 14px', lineHeight: 1.5 }}>ⓘ {row.note}</div>
      )}

      {open && row.kind !== 'sent' && (
        <div style={{ margin: '8px 0 2px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--fg)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{row.summary}</div>
          {row.kind === 'received' && row.artifacts.map((a, i) => (
            <div key={i} style={{ marginTop: 10 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                {a.name || `artifact ${i + 1}`}
                {(a.content?.length ?? 0) > ARTIFACT_CAP && ` · showing the first 16 KB of ${Math.round((a.content!.length) / 1024)} KB`}
              </div>
              <pre style={{
                margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto',
              }}>{(a.content ?? '').slice(0, ARTIFACT_CAP)}</pre>
            </div>
          ))}
          {/* Ack-on-open is irreversible and reachable by a stray click, and an acked report loses
              the only mark saying it was never read. One line puts it back. */}
          {row.kind === 'received' && row.state === 'acked' && (
            <button onClick={() => onMarkUnread(row.id)} style={{ ...linkBtn, marginTop: 8 }}>mark unread</button>
          )}
        </div>
      )}
    </div>
  )
}

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', outline: 'none', cursor: 'pointer',
  color: 'var(--accent)', fontSize: 10, fontFamily: 'var(--font-mono)', padding: 0,
}
