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
  const toolLabel = session.lastToolName
    ? ` — ${session.lastToolName}`
    : session.phase === 'running' ? ' — processing' : ''

  const status = sessionWaveStatus(session)

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
        padding: '0 12px 0 10px',
        background: active ? 'var(--bg-surface)' : 'transparent',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        color: 'var(--fg)',
        fontSize: 12,
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
            {/* Working states tint the name the same hue as their status dot, so
                the actively-busy sessions stand out; quiet states stay default. */}
            <span style={
              status === 'running' ? { color: 'var(--status-running)' }
                : status === 'compacting' ? { color: 'var(--status-compacting)' }
                : undefined
            }>
              {label}
            </span>
            {toolLabel && (
              <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>{toolLabel}</span>
            )}
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
          style={{
            fontSize: 9,
            color: 'var(--fg-muted)',
            background: 'transparent',
            borderRadius: 8,
            padding: '1px 5px',
          }}
        >
          {session.activeSubagents}
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
