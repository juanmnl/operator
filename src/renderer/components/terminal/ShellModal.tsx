import { useEffect, useRef, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import { TerminalPane } from './TerminalPane'

// A modal scratch terminal: a plain interactive shell in the session's path, for
// pure shell work outside the Claude session. Spawns a shell on mount (shell_spawn,
// reusing the normal pty/terminal* plumbing so it renders with TerminalPane). Closing
// only HIDES it (`visible=false`) — the shell + its scrollback stay alive so reopening
// resumes exactly where you left off; the pty is killed only when this component
// unmounts (the session is switched/closed). Click the backdrop or × to hide.
export function ShellModal({ cwd, theme, visible, onClose }: { cwd: string; theme: ITheme; visible: boolean; onClose: () => void }) {
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
      .catch(() => { /* spawn failed; modal shows the starting state */ })
    return () => {
      cancelled = true
      if (idRef.current) { void window.operator.terminalKill(idRef.current); idRef.current = null }
    }
  }, [cwd])

  // Re-showing the modal flips its container from display:none → flex; nudge a
  // resize so TerminalPane's fit addon recomputes cols/rows for the now-sized box.
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(t)
  }, [visible])

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        // Hide (don't unmount) on close so the shell + scrollback persist.
        display: visible ? 'flex' : 'none',
        alignItems: 'center', justifyContent: 'center', padding: 40,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(1040px, 92%)', height: 'min(660px, 86%)',
          display: 'flex', flexDirection: 'column', minHeight: 0,
          background: 'var(--bg-terminal)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '8px 10px 8px 14px', flexShrink: 0,
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{
            fontSize: 11, color: 'var(--fg-muted)',
            fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {cwd}
          </span>
          <button
            onClick={onClose}
            title="Hide terminal (the shell keeps running)"
            style={{
              flexShrink: 0, border: 'none', background: 'transparent',
              color: 'var(--fg-muted)', cursor: 'pointer',
              fontSize: 16, lineHeight: 1, padding: '2px 6px', borderRadius: 4,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {termId ? (
            <div style={{ position: 'absolute', inset: 8 }}>
              <TerminalPane terminalId={termId} theme={theme} active />
            </div>
          ) : (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--fg-muted)' }}>Starting shell…</div>
          )}
        </div>
      </div>
    </div>
  )
}
