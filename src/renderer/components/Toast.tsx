import { useEffect, useState } from 'react'
import { StatusWave, WaveStatus } from './sidebar/StatusWave'

export interface ToastMessage {
  id: string
  text: string
  kind?: 'info' | 'success' | 'error'
  /** Optional small detail line under the main text. */
  detail?: string
}

interface ToastsProps {
  messages: ToastMessage[]
  onDismiss: (id: string) => void
}

const STATUS_BY_KIND: Record<NonNullable<ToastMessage['kind']>, WaveStatus> = {
  info: 'running',
  success: 'idle',
  error: 'error',
}

export function Toasts({ messages, onDismiss }: ToastsProps) {
  return (
    <div style={{
      position: 'fixed', bottom: 16, right: 16, zIndex: 900,
      display: 'flex', flexDirection: 'column', gap: 6,
      pointerEvents: 'none',
    }}>
      {messages.map((m) => (
        <Toast key={m.id} message={m} onDismiss={() => onDismiss(m.id)} />
      ))}
    </div>
  )
}

function Toast({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  const [entered, setEntered] = useState(false)
  const status = STATUS_BY_KIND[message.kind || 'info']

  useEffect(() => {
    const enter = requestAnimationFrame(() => setEntered(true))
    const exit = setTimeout(onDismiss, 3500)
    return () => { cancelAnimationFrame(enter); clearTimeout(exit) }
  }, [onDismiss])

  return (
    <div
      onClick={onDismiss}
      style={{
        pointerEvents: 'auto',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px',
        background: 'var(--bg-sidebar)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        fontFamily: "'Inter', system-ui, sans-serif",
        cursor: 'pointer',
        maxWidth: 340,
        transform: entered ? 'translateY(0)' : 'translateY(10px)',
        opacity: entered ? 1 : 0,
        transition: 'transform 0.18s, opacity 0.18s',
      }}
    >
      <span style={{ flexShrink: 0, alignSelf: 'flex-start', marginTop: 1 }}>
        <StatusWave status={status} size={13} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--fg)', fontWeight: 500 }}>
          {message.text}
        </div>
        {message.detail && (
          <div style={{
            fontSize: 10, color: 'var(--fg-muted)', opacity: 0.6, marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
          }}>
            {message.detail}
          </div>
        )}
      </div>
    </div>
  )
}
