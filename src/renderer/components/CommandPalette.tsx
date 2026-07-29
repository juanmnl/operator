import { useEffect, useRef, useState, useMemo, Fragment } from 'react'

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

// Section order when browsing (no query), most-reached first. Sections are set apart
// by their headers + spacing alone — no decorative colour (it carried no meaning).
const GROUP_ORDER = ['Session', 'Continue', 'Recent', 'New', 'View', 'Settings']

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
  const searching = !!query.trim()

  useEffect(() => { inputRef.current?.focus() }, [])

  // When searching: rank across everything (flat). When browsing: keep every action
  // but order it by section so the rendered headers group cleanly.
  const ordered = useMemo(() => {
    if (searching) {
      return actions
        .map((a) => ({ a, s: score(query.trim(), `${a.label} ${a.detail || ''} ${a.group || ''}`) }))
        .filter((x) => x.s >= 0)
        .sort((x, y) => x.s - y.s)
        .map((x) => x.a)
    }
    const rank = (g?: string) => { const i = GROUP_ORDER.indexOf(g || ''); return i < 0 ? 999 : i }
    return [...actions].sort((a, b) => rank(a.group) - rank(b.group))
  }, [query, actions, searching])

  useEffect(() => { setSelectedIdx(0) }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${selectedIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(ordered.length - 1, i + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(0, i - 1)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const chosen = ordered[selectedIdx]
      if (chosen) { chosen.run(); onClose() }
    }
  }

  const Row = ({ a, i }: { a: PaletteAction; i: number }) => (
    <div
      data-row={i}
      onMouseEnter={() => setSelectedIdx(i)}
      onClick={() => { a.run(); onClose() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 14px', cursor: 'pointer', borderRadius: 6, margin: '0 6px',
        background: i === selectedIdx ? 'var(--bg-surface)' : 'transparent',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {a.label}
        </div>
        {a.detail && (
          <div style={{
            fontSize: 10, color: 'var(--fg-muted)', marginTop: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
          }}>
            {a.detail}
          </div>
        )}
      </div>
      {/* While searching there are no section headers, so tag the group inline. */}
      {searching && a.group && (
        <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--fg-muted)', flexShrink: 0 }}>
          {a.group}
        </span>
      )}
      {a.hint && (
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0, fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace" }}>
          {a.hint}
        </span>
      )}
    </div>
  )

  let lastGroup = ''

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 100,
        fontFamily: "var(--font-body)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: 'calc(100vw - 80px)',
          maxHeight: '64vh', display: 'flex', flexDirection: 'column',
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
          placeholder="Search sessions, settings, actions…"
          style={{
            padding: '12px 16px',
            fontSize: 14, fontFamily: 'var(--font-disp)',
            background: 'transparent',
            color: 'var(--fg)',
            border: 'none',
            borderBottom: '1px solid var(--border)',
            outline: 'none',
          }}
        />
        <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
          {ordered.length === 0 && (
            <div style={{ padding: '20px 16px', fontSize: 12, color: 'var(--fg-muted)', textAlign: 'center' }}>
              No matches
            </div>
          )}
          {ordered.map((a, i) => {
            // Browsing: emit a section header whenever the group changes.
            const header = !searching && a.group !== lastGroup ? a.group : null
            lastGroup = a.group || ''
            return (
              <Fragment key={a.id}>
                {header && (
                  <div style={{
                    padding: '10px 20px 4px', fontFamily: 'var(--font-mono)', fontSize: 9.5,
                    textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--fg-muted)', 
                  }}>
                    {header}
                  </div>
                )}
                <Row a={a} i={i} />
              </Fragment>
            )
          })}
        </div>
        {/* Shortcut legend — keeps the panel from reading as just a list. */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14,
          padding: '7px 16px', borderTop: '1px solid var(--border)',
          fontSize: 10, color: 'var(--fg-muted)', 
        }}>
          <Legend k="↑↓" label="navigate" />
          <Legend k="↵" label="open" />
          <Legend k="esc" label="close" />
          <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{ordered.length}</span>
        </div>
      </div>
    </div>
  )
}

function Legend({ k, label }: { k: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <kbd style={{
        fontFamily: "'SF Mono', Menlo, monospace", fontSize: 9.5, color: 'var(--fg)',
        padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-surface)',
      }}>{k}</kbd>
      {label}
    </span>
  )
}
