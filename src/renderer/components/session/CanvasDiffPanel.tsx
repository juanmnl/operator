import { useEffect, useState } from 'react'
import type { WorktreeDiff } from '../../../shared/types'
import { DiffBody } from './DiffBody'

// Live diff of the session's working directory — polls `worktree_diff` so the
// agent's changes accumulate in view. Read-only (commit/merge live in the full
// Review panel); this is the at-a-glance "what's it changing" surface. Rendering
// (per-file collapsible sections, tinted rows) lives in the shared DiffBody.

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

  if (loaded && (diff?.files ?? []).length === 0) {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 6, padding: 24, textAlign: 'center', fontFamily: "var(--font-body)",
      }}>
        <span style={{ fontFamily: 'var(--font-disp)', fontSize: 15, fontWeight: 600, color: 'var(--fg)', opacity: 0.9 }}>No changes</span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', maxWidth: 280, lineHeight: 1.5 }}>
          Edits the agent makes in this session’s working tree show up here.
        </span>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', fontFamily: "var(--font-body)", background: 'var(--bg-terminal)' }}>
      {diff && <DiffBody diff={diff} />}
    </div>
  )
}
