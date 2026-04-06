import { useState, useRef, useEffect } from 'react'
import { AgentSession } from '../../../shared/types'

type DotStatus = 'running' | 'waiting' | 'compacting' | 'error' | 'idle' | 'ended'

interface SessionItemProps {
  session: AgentSession
  label: string
  active: boolean
  hasPending: boolean
  isExternal?: boolean
  effortLevel?: string | null
  onClick: () => void
  onRename: (newName: string) => void
}

const dotConfig: Record<DotStatus, { color: string; opacity?: number; animation?: string }> = {
  running:    { color: 'var(--green)',  animation: 'pulse 1.5s ease-in-out infinite' },
  waiting:    { color: 'var(--yellow)', animation: 'pulse 1s ease-in-out infinite' },
  compacting: { color: 'var(--cyan)' },
  error:      { color: 'var(--red)' },
  idle:       { color: 'var(--fg-muted)', opacity: 0.4 },
  ended:      { color: 'var(--fg-muted)', opacity: 0.15 },
}

function getDotStatus(session: AgentSession, hasPending: boolean): DotStatus {
  if (hasPending) return 'waiting'
  if (session.status === 'ended') return 'ended'

  switch (session.phase) {
    case 'running': return 'running'
    case 'compacting': return 'compacting'
    default: return 'idle'
  }
}

export function SessionItem({ session, label, active, hasPending, isExternal, effortLevel, onClick, onRename }: SessionItemProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)
  const toolLabel = session.lastToolName
    ? ` — ${session.lastToolName}`
    : session.phase === 'running' ? ' — processing' : ''

  const status = getDotStatus(session, hasPending)
  const dot = dotConfig[status]

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== label) {
      onRename(trimmed)
    } else {
      setEditValue(label)
    }
    setEditing(false)
  }

  return (
    <button
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditValue(label)
        setEditing(true)
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 12px 6px 20px',
        background: active ? 'var(--bg-surface)' : 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        color: 'var(--fg)',
        fontSize: 12,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: isExternal ? 'transparent' : dot.color,
          border: isExternal ? `1.5px solid ${dot.color}` : 'none',
          boxSizing: 'border-box',
          flexShrink: 0,
          opacity: dot.opacity ?? 1,
          animation: dot.animation,
          transition: 'background 0.3s, opacity 0.3s',
        }}
      />
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
            {label}
            {toolLabel && (
              <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>{toolLabel}</span>
            )}
          </>
        )}
      </span>
      {!editing && isExternal && (
        <span style={{
          fontSize: 8,
          fontWeight: 500,
          color: 'var(--fg-muted)',
          opacity: 0.4,
          flexShrink: 0,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        }}>
          ext
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
      {!editing && effortLevel && (
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
    </button>
  )
}
