import { useEffect, useState } from 'react'
import type { WorktreeDiff } from '../../../shared/types'

// Live diff of the session's working directory — polls `worktree_diff` so the
// agent's changes accumulate in view. Read-only (commit/merge live in the
// full Review panel); this is the at-a-glance "what's it changing" surface.
export function CanvasDiffPanel({ path }: { path?: string | null }) {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!path) { setDiff(null); setLoaded(true); return }
    let cancelled = false
    const load = () => window.operator.worktreeDiff?.(path)
      .then((d) => { if (!cancelled) { setDiff(d as WorktreeDiff); setLoaded(true) } })
      .catch(() => { if (!cancelled) setLoaded(true) })
    load()
    const iv = setInterval(load, 3000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [path])

  const files = diff?.files ?? []
  const totalAdded = files.reduce((n, f) => n + (f.added || 0), 0)
  const totalRemoved = files.reduce((n, f) => n + (f.removed || 0), 0)

  if (loaded && files.length === 0) {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 6, padding: 24, textAlign: 'center', fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        <span style={{ fontSize: 12, color: 'var(--fg)' }}>No changes</span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.7, maxWidth: 280, lineHeight: 1.5 }}>
          Edits the agent makes in this session’s working tree show up here.
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--fg-muted)',
      }}>
        <span style={{ fontWeight: 600 }}>{files.length} file{files.length === 1 ? '' : 's'}</span>
        <span style={{ color: 'var(--color-success, #3fb950)' }}>+{totalAdded}</span>
        <span style={{ color: 'var(--color-error, #f85149)' }}>−{totalRemoved}</span>
      </div>
      <div className="scroll-hidden" style={{ flex: 1, overflow: 'auto' }}>
        {/* File summary */}
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          {files.map((f) => (
            <div key={f.path} style={{ display: 'flex', gap: 8, fontSize: 11.5, padding: '2px 0', alignItems: 'baseline' }}>
              <span style={{ color: 'var(--fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'SF Mono', Menlo, monospace" }} title={f.path}>{f.path}</span>
              {f.added > 0 && <span style={{ color: 'var(--color-success, #3fb950)' }}>+{f.added}</span>}
              {f.removed > 0 && <span style={{ color: 'var(--color-error, #f85149)' }}>−{f.removed}</span>}
            </div>
          ))}
        </div>
        {/* Colorized unified diff */}
        <pre style={{
          margin: 0, padding: '8px 12px', fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
          fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre', tabSize: 2,
        }}>
          {(diff?.diff ?? '').split('\n').map((line, i) => (
            <div key={i} style={lineStyle(line)}>{line || ' '}</div>
          ))}
        </pre>
      </div>
    </div>
  )
}

function lineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return { color: 'var(--fg-muted)', opacity: 0.6 }
  }
  if (line.startsWith('@@')) return { color: 'var(--cyan, #56b6c2)', opacity: 0.85 }
  if (line.startsWith('+')) return { color: 'var(--color-success, #3fb950)' }
  if (line.startsWith('-')) return { color: 'var(--color-error, #f85149)' }
  return { color: 'var(--fg-muted)' }
}
