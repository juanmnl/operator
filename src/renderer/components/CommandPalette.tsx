import { useEffect, useRef, useState, useMemo } from 'react'

export interface PaletteAction {
  id: string
  label: string
  /** Short hint shown right-aligned (e.g. shortcut). */
  hint?: string
  /** Optional second line for context (e.g. project path). */
  detail?: string
  /** Category for grouping/badge. */
  group?: string
  run: () => void
}

interface CommandPaletteProps {
  actions: PaletteAction[]
  onClose: () => void
}

/** Cheap fuzzy match: returns a score (lower = better) or -1 for no match. */
function score(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let lastIdx = -1
  let gaps = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (lastIdx >= 0) gaps += i - lastIdx - 1
      lastIdx = i
      qi++
    }
  }
  if (qi < q.length) return -1
  return gaps + (lastIdx - q.length + 1) // prefer earlier and contiguous matches
}

export function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    if (!query.trim()) return actions
    const scored = actions
      .map((a) => {
        const haystack = `${a.label} ${a.detail || ''} ${a.group || ''}`
        const s = score(query.trim(), haystack)
        return { action: a, score: s }
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score)
    return scored.map((s) => s.action)
  }, [query, actions])

  useEffect(() => { setSelectedIdx(0) }, [query])

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(0, i - 1)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const chosen = filtered[selectedIdx]
      if (chosen) { chosen.run(); onClose() }
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 100,
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: 'calc(100vw - 80px)',
          maxHeight: '60vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type to search…"
          style={{
            padding: '12px 16px',
            fontSize: 13, fontFamily: 'inherit',
            background: 'transparent',
            color: 'var(--fg)',
            border: 'none',
            borderBottom: '1px solid var(--border)',
            outline: 'none',
          }}
        />
        <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '20px 16px', fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6, textAlign: 'center' }}>
              No matches
            </div>
          )}
          {filtered.map((a, i) => (
            <div
              key={a.id}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => { a.run(); onClose() }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 14px',
                cursor: 'pointer',
                background: i === selectedIdx ? 'var(--bg-surface)' : 'transparent',
              }}
            >
              {a.group && (
                <span style={{
                  fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: 0.5, color: 'var(--fg-muted)', opacity: 0.6,
                  width: 56, flexShrink: 0,
                }}>
                  {a.group}
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.label}
                </div>
                {a.detail && (
                  <div style={{
                    fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5, marginTop: 1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                  }}>
                    {a.detail}
                  </div>
                )}
              </div>
              {a.hint && (
                <span style={{
                  fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5, flexShrink: 0,
                  fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                }}>
                  {a.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
