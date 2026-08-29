import type { ReportArtifact } from '../../lib/comms'

// A report's full text and the files it carried back, rendered ONCE and used in both places a
// report surfaces: on its task's Done card (`TaskResultCard`) and in the project's Comms
// timeline (`CommsLog`). Two windows onto one record, never two renderings of it — the settled
// direction is that the WORK is the primary object, and a result that reads differently
// depending on where you met it is the second source of truth that direction exists to avoid.

/** The markdown-freeze cap. A `tool_result` artifact runs to tens of KB and the renderer has a
 *  documented history of being killed at ~1.1GB; 16KB is the same cap the chat panel uses, and
 *  the header says out loud when it has truncated rather than silently showing a prefix. */
const ARTIFACT_CAP = 16 * 1024

export function ReportBody({ summary, artifacts }: { summary: string; artifacts: readonly ReportArtifact[] }) {
  return (
    <>
      {/* `overflowWrap: anywhere` alongside `pre-wrap`: a report routinely quotes a path, a URL or
          a branch name, and `pre-wrap` alone will not break one — in a 330px board column that is
          a card scrolling sideways. The board's own rule is that wide content breaks or scrolls
          inside its own box, never the page. */}
      <div style={{ fontSize: 11, color: 'var(--fg)', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{summary}</div>
      {artifacts.map((a, i) => (
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
    </>
  )
}
