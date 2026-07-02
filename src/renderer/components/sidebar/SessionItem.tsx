import { useState, useRef, useEffect } from 'react'
import { AgentSession } from '../../../shared/types'
import { StatusWave } from './StatusWave'
import { sessionWaveStatus } from '../../lib/session-status'

interface SessionItemProps {
  session: AgentSession
  label: string
  active: boolean
  effortLevel?: string | null
  /** Fan-out membership: this agent's position within a parallel launch. */
  fanInfo?: { index: number; total: number }
  closable: boolean
  /** 1-based Cmd+N hint for the first nine local sessions. */
  shortcutIndex?: number | null
  onClick: () => void
  onRename: (newName: string) => void
  onClose: () => void
}

export function SessionItem({ session, label, active, effortLevel, fanInfo, closable, shortcutIndex, onClick, onRename, onClose }: SessionItemProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(label)
  const [hovered, setHovered] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const status = sessionWaveStatus(session)

  // Landing-style uppercase phase word shown on the right of each row (rendered
  // uppercase via CSS). Mirrors the `.sess-phase` label in ../Operator-landing.
  const PHASE_LABEL: Record<string, string> = {
    running: 'running', compacting: 'compacting', waiting: 'your turn',
    idle: 'idle', ended: 'ended', error: 'error',
  }
  const phaseLabel = PHASE_LABEL[status] ?? status
  // The running session gets an accent left-border + faint accent wash (the
  // landing's `.sess.running`); waiting tints the phase word accent as a
  // quiet "your turn" cue. No pulsing dot (a banned generic AI tell).
  const isRunning = status === 'running'
  const phaseAccent = status === 'running' || status === 'waiting'

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
  }, [])

  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== label) {
      onRename(trimmed)
    } else {
      setEditValue(label)
    }
    setEditing(false)
  }

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirmingClose) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirmingClose(false)
      onClose()
      return
    }
    setConfirmingClose(true)
    confirmTimerRef.current = setTimeout(() => setConfirmingClose(false), 2500)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditValue(label)
        setEditing(true)
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirmingClose(false) }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        // Fixed height (not padding-driven) so every row is identical regardless of
        // its content — tool suffix, badges, shortcut hint all sit within the same box.
        height: 32,
        // 2px left-accent for the running session; a constant 2px transparent
        // border otherwise keeps text from shifting when the state flips.
        // NB: NO border-radius here — a rounded corner + a DYNAMIC (colour-changing)
        // border re-rasterizes the rounded border layer in WKWebView on every state
        // flip, which pegs the compositor and freezes the app. Flush rows also match
        // the landing's `.sess` rows exactly. Keep radius OFF wherever a border colour
        // is dynamic. (Selection is shown by the full-width wash, not a rounded card.)
        padding: '0 12px 0 8px',
        borderLeft: `2px solid ${isRunning ? 'var(--accent)' : 'transparent'}`,
        background: active
          ? 'var(--bg-surface)'
          : isRunning ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent',
        borderTop: 'none', borderRight: 'none', borderBottom: 'none',
        borderRadius: 0,
        cursor: 'pointer',
        textAlign: 'left',
        // Mono, matching the landing's session panel rows.
        fontFamily: 'var(--font-mono)',
        color: 'var(--fg)',
        fontSize: 11.5,
        boxSizing: 'border-box',
        outline: 'none',
      }}
    >
      <StatusWave status={status} seed={session.id} />
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { setEditValue(label); setEditing(false) }
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'transparent',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              fontSize: 12,
              fontFamily: 'inherit',
              padding: '0 4px',
              width: '100%',
              outline: 'none',
            }}
          />
        ) : (
          <>
            {/* The running session's name reads full-strength (landing
                `.sess.running .sess-name`); quiet rows sit a touch dimmer. */}
            <span style={{ color: isRunning ? 'var(--fg)' : 'color-mix(in srgb, var(--fg) 80%, transparent)' }}>
              {label}
            </span>
          </>
        )}
      </span>
      {!editing && fanInfo && (
        <span
          title={`Agent ${fanInfo.index} of ${fanInfo.total} in a parallel fan-out`}
          style={{
            fontSize: 8,
            fontWeight: 600,
            color: 'var(--accent)',
            background: 'var(--overlay-subtle)',
            borderRadius: 8,
            padding: '1px 5px',
            flexShrink: 0,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: 0.2,
          }}
        >
          ⑂{fanInfo.index}/{fanInfo.total}
        </span>
      )}
      {!editing && session.activeSubagents > 0 && (
        <span
          title={`${session.activeSubagents} active subagent${session.activeSubagents > 1 ? 's' : ''}`}
          style={{
            fontSize: 10,
            color: 'var(--accent)',
            flexShrink: 0,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          ⤷{session.activeSubagents}
        </span>
      )}
      {/* Uppercase phase word — the landing's signature right-aligned `.sess-phase`.
          Accent for running/your-turn, muted otherwise. Hidden on hover so the
          close affordance can take its place (same gate as effort/shortcut). */}
      {!editing && !(hovered && closable) && (
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: phaseAccent ? 'var(--accent)' : 'var(--fg-muted)',
          }}
        >
          {phaseLabel}
        </span>
      )}
      {!editing && effortLevel && !(hovered && closable) && (
        <span
          style={{
            fontSize: 8,
            fontWeight: 600,
            color: 'var(--fg-muted)',
            opacity: 0.5,
            flexShrink: 0,
            textTransform: 'uppercase',
          }}
        >
          {effortLevel[0]}
        </span>
      )}
      {!editing && shortcutIndex != null && !(hovered && closable) && (
        <span
          style={{
            fontSize: 9, color: 'var(--fg-muted)',
            opacity: 0.4, flexShrink: 0,
            fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
          }}
          title={`Switch with ⌘${shortcutIndex}`}
        >
          ⌘{shortcutIndex}
        </span>
      )}
      {!editing && closable && (hovered || confirmingClose) && (
        <button
          onClick={handleCloseClick}
          title={confirmingClose ? 'Click again to confirm' : 'Close session'}
          style={{
            background: confirmingClose ? 'var(--color-error)' : 'transparent',
            color: confirmingClose ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
            border: 'none',
            borderRadius: 3,
            padding: '0 5px',
            fontSize: 10,
            fontFamily: 'inherit',
            lineHeight: '14px',
            cursor: 'pointer',
            flexShrink: 0,
            opacity: confirmingClose ? 1 : 0.5,
          }}
        >
          {confirmingClose ? '×?' : '×'}
        </button>
      )}
    </div>
  )
}
