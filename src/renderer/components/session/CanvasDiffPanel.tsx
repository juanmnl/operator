import { useEffect, useMemo, useState } from 'react'
import type { WorktreeDiff, FileChange } from '../../../shared/types'

// Live diff of the session's working directory — polls `worktree_diff` so the
// agent's changes accumulate in view. Read-only (commit/merge live in the full
// Review panel); this is the at-a-glance "what's it changing" surface. The raw
// unified diff is parsed into per-file, collapsible sections with tinted +/− rows.

interface DiffFile {
  path: string
  lines: string[] // hunk + content lines (noise headers stripped)
}

// Split a unified diff into per-file bodies. A file starts at `diff --git`; the
// b/ path is the file name. Strip the low-value headers (index/+++/---/new file/…)
// since the section header already shows the file.
function parseDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = []
  let cur: DiffFile | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/)
      cur = { path: m ? m[1] : line.replace('diff --git ', ''), lines: [] }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (
      line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
      line.startsWith('new file') || line.startsWith('deleted file') ||
      line.startsWith('similarity ') || line.startsWith('rename ') || line.startsWith('old mode') || line.startsWith('new mode')
    ) continue
    cur.lines.push(line)
  }
  return out
}

export function CanvasDiffPanel({ path }: { path?: string | null }) {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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
  // Per-file counts by path, to annotate each parsed section header.
  const countByPath = useMemo(() => {
    const m = new Map<string, FileChange>()
    for (const f of files) m.set(f.path, f)
    return m
  }, [files])
  const parsed = useMemo(() => parseDiff(diff?.diff ?? ''), [diff?.diff])

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

  const toggle = (p: string) =>
    setCollapsed((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif", background: 'var(--bg-terminal)' }}>
      {/* Summary bar */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        height: 30, padding: '0 14px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--fg-muted)',
      }}>
        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{files.length} file{files.length === 1 ? '' : 's'}</span>
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: 'var(--color-success, #3fb950)' }}>+{totalAdded}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-error, #f85149)' }}>−{totalRemoved}</span>
      </div>

      <div className="scroll-hidden" style={{ flex: 1, overflow: 'auto' }}>
        {parsed.map((file) => {
          const fc = countByPath.get(file.path)
          const isCollapsed = collapsed.has(file.path)
          return (
            <section key={file.path}>
              {/* Sticky file header — also the collapse toggle + navigation anchor */}
              <button
                onClick={() => toggle(file.path)}
                title={file.path}
                style={{
                  position: 'sticky', top: 0, zIndex: 1,
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 12px', border: 'none', borderBottom: '1px solid var(--border)',
                  background: 'var(--bg-surface, var(--overlay-subtle))', cursor: 'pointer',
                  fontFamily: 'inherit', textAlign: 'left', outline: 'none',
                }}
              >
                <span style={{
                  flexShrink: 0, width: 10, color: 'var(--fg-muted)', fontSize: 9,
                  transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.12s',
                }}>▾</span>
                <FilePath path={file.path} />
                {fc && fc.added > 0 && <span style={{ flexShrink: 0, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--color-success, #3fb950)' }}>+{fc.added}</span>}
                {fc && fc.removed > 0 && <span style={{ flexShrink: 0, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--color-error, #f85149)' }}>−{fc.removed}</span>}
              </button>
              {!isCollapsed && (
                <div style={{ fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, lineHeight: 1.55 }}>
                  {file.lines.map((line, i) => <DiffLine key={i} line={line} />)}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// Show the directory muted + the file name in full strength, with the directory
// truncating from the LEFT so the file name is never clipped (the old single-span
// ellipsis hid the start of the path).
function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  return (
    <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', fontFamily: "'SF Mono', Menlo, monospace", fontSize: 11.5 }}>
      {dir && (
        <span style={{ color: 'var(--fg-muted)', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
          {dir}
        </span>
      )}
      <span style={{ flexShrink: 0, color: 'var(--fg)', fontWeight: 500 }}>{name}</span>
    </span>
  )
}

// One diff line: tinted row for +/−, subtle separator for @@ hunks, muted context.
function DiffLine({ line }: { line: string }) {
  const base: React.CSSProperties = { padding: '0 12px', whiteSpace: 'pre', minHeight: '1.55em' }
  if (line.startsWith('@@')) {
    return <div style={{ ...base, color: 'var(--mcp-http, #56b6c2)', background: 'var(--overlay-subtle)', opacity: 0.85, padding: '2px 12px' }}>{line}</div>
  }
  if (line.startsWith('+')) {
    return <div style={{ ...base, color: 'var(--color-success, #3fb950)', background: 'color-mix(in srgb, var(--color-success, #3fb950) 13%, transparent)' }}>{line}</div>
  }
  if (line.startsWith('-')) {
    return <div style={{ ...base, color: 'var(--color-error, #f85149)', background: 'color-mix(in srgb, var(--color-error, #f85149) 13%, transparent)' }}>{line}</div>
  }
  return <div style={{ ...base, color: 'var(--fg-muted)' }}>{line || ' '}</div>
}
