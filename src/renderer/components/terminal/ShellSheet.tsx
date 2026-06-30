import { useEffect, useRef, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import { TerminalSurface } from './TerminalSurface'

// A scratch terminal as a BOTTOM SHEET. Rendered inside the main content card (so
// it spans the main view's width and stays clear of the Canvas panel), it slides up
// from the bottom, above the main actions footer. A plain interactive shell in the
// session's path, for shell work outside the Claude session. The shell + scrollback
// persist across close→reopen (only hidden, kept mounted); the pty is killed when
// this unmounts (session switched/closed). `bottom` clears the footer beneath it.
export function ShellSheet({ cwd, theme, open, bottom = 0, onClose }: {
  cwd: string
  theme: ITheme
  open: boolean
  bottom?: number
  onClose: () => void
}) {
  const [termId, setTermId] = useState<string | null>(null)
  const idRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.operator.shellSpawn(cwd)
      .then((id) => {
        if (cancelled) { void window.operator.terminalKill(id); return }
        idRef.current = id
        setTermId(id)
      })
      .catch(() => { /* spawn failed; sheet shows the starting state */ })
    return () => {
      cancelled = true
      if (idRef.current) { void window.operator.terminalKill(idRef.current); idRef.current = null }
    }
  }, [cwd])

  // On open: nudge a resize so the fit addon recomputes for the now-shown box, and
  // wire Esc-to-close.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom,
        height: 'min(58%, calc(100% - 84px))', minHeight: 200,
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg-terminal)',
        borderTop: '1px solid var(--border)',
        transform: open ? 'translateY(0)' : 'translateY(calc(100% + 24px))',
        transition: 'transform 0.24s cubic-bezier(.32,.72,0,1)',
        pointerEvents: open ? 'auto' : 'none',
        overflow: 'hidden', zIndex: 30,
      }}
    >
      <div style={{
        position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, height: 34, padding: '0 8px 0 14px', flexShrink: 0,
        borderBottom: '1px solid var(--border)',
      }}>
        {/* Grab affordance */}
        <span style={{
          position: 'absolute', top: 5, left: '50%', transform: 'translateX(-50%)',
          width: 30, height: 3, borderRadius: 2, background: 'var(--overlay-medium)',
        }} />
        <span style={{
          fontSize: 11, color: 'var(--fg-muted)',
          fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {cwd}
        </span>
        <button
          onClick={onClose}
          title="Hide terminal (the shell keeps running) · Esc"
          style={{
            flexShrink: 0, border: 'none', background: 'transparent',
            color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none',
            fontSize: 16, lineHeight: 1, padding: '2px 6px', borderRadius: 4,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {termId ? (
          // Tight inset (8px ≈ one cell, which read as a wide leading space). 4px on
          // the sides matches the grid pane; a little top breathing room under the header.
          <div style={{ position: 'absolute', top: 6, left: 4, right: 4, bottom: 4 }}>
            <TerminalSurface terminalId={termId} theme={theme} active={open} />
          </div>
        ) : (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--fg-muted)' }}>Starting shell…</div>
        )}
      </div>
    </div>
  )
}
