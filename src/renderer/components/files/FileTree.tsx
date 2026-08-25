import { useCallback, useEffect, useState } from 'react'
import type { TreeEntry } from '../../../shared/types'

// Lazy per directory — the component asks for a directory the FIRST time it opens, and never
// again unless something changed. No recursive walk on open: `node_modules` is tens of thousands
// of entries and the whole point of lazy is never touching it.

export interface FileTreeProps {
  root: string
  /** Repo-relative paths of the directories that are open. Controlled, because a deep link
   *  expands the ancestors of its target and the tree has to follow. */
  expanded: string[]
  onToggle: (dir: string, open: boolean) => void
  selected?: string
  onSelect: (path: string) => void
  /** `M` / `A` / `??` per path, from the SAME `worktreeDiff` the Diff tab uses — no second
   *  differ, so the letters cannot disagree with the Diff tab's for the same worktree. */
  changed?: Record<string, string>
  showIgnored?: boolean
}

const ROW_H = 20

export function FileTree({ root, expanded, onToggle, selected, onSelect, changed, showIgnored }: FileTreeProps) {
  /** dir → children. `undefined` = never asked; `null` = asked and it failed. */
  const [cache, setCache] = useState<Record<string, TreeEntry[] | null>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})

  const load = useCallback((dir: string) => {
    setLoading((p) => ({ ...p, [dir]: true }))
    window.operator.fileTree(root, dir, showIgnored)
      .then((entries) => setCache((p) => ({ ...p, [dir]: entries })))
      .catch(() => setCache((p) => ({ ...p, [dir]: null })))
      .finally(() => setLoading((p) => ({ ...p, [dir]: false })))
  }, [root, showIgnored])

  // Root, plus any directory the caller expanded that we have not read yet — which is how a deep
  // link's ancestor expansion turns into the reads it needs without the caller orchestrating them.
  useEffect(() => { setCache({}) }, [root, showIgnored])
  useEffect(() => {
    for (const dir of ['', ...expanded]) {
      if (cache[dir] === undefined && !loading[dir]) load(dir)
    }
  }, [expanded, cache, loading, load])

  const rows = flatten('', 0)

  function flatten(dir: string, depth: number): Array<{ entry: TreeEntry; depth: number }> {
    const entries = cache[dir]
    if (!entries) return []
    const out: Array<{ entry: TreeEntry; depth: number }> = []
    for (const e of entries) {
      out.push({ entry: e, depth })
      if (e.dir && expanded.includes(e.path)) out.push(...flatten(e.path, depth + 1))
    }
    return out
  }

  if (cache[''] === null) {
    return <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--fg-muted)' }}>Couldn't read this folder.</div>
  }
  if (cache[''] === undefined) {
    return (
      <div style={{ padding: 8 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ height: ROW_H - 4, marginBottom: 4, background: 'var(--overlay-subtle)', borderRadius: 3 }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {rows.map(({ entry, depth }) => {
        const isOpen = entry.dir && expanded.includes(entry.path)
        const status = changed?.[entry.path]
        const isSelected = !entry.dir && entry.path === selected
        return (
          <button
            key={entry.path}
            onClick={() => (entry.dir ? onToggle(entry.path, !isOpen) : onSelect(entry.path))}
            title={entry.path}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, width: '100%',
              height: ROW_H, padding: `0 8px 0 ${8 + depth * 12}px`, boxSizing: 'border-box',
              background: isSelected ? 'var(--overlay-subtle)' : 'transparent',
              border: 'none', outline: 'none', cursor: 'pointer', textAlign: 'left',
              fontFamily: 'var(--font-mono)', fontSize: 11,
              color: isSelected ? 'var(--accent)' : 'var(--fg)',
            }}
          >
            <span style={{ flex: '0 0 10px', color: 'var(--fg-muted)', fontSize: 9 }}>
              {entry.dir ? (loading[entry.path] ? '⋯' : isOpen ? '▾' : '▸') : ''}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.name}
            </span>
            {/* The porcelain status letters the Diff tab already renders — same glyphs, same
                muted ink, same 9px mono. Not a second vocabulary for the same fact. */}
            {status && (
              <span style={{ flex: '0 0 auto', fontSize: 9, color: 'var(--fg-muted)' }}>{status.trim()}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
