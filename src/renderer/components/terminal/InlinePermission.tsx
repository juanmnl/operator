import { OperatorRequest } from '../../../shared/types'
import { useEffect, useRef } from 'react'

interface InlinePermissionProps {
  request: OperatorRequest
  onRespond: (value: string) => void
}

export function InlinePermission({ request, onRespond }: InlinePermissionProps) {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onRespond('approve')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onRespond('deny')
      }
    }
    const el = barRef.current
    el?.addEventListener('keydown', handler)
    el?.focus()
    return () => el?.removeEventListener('keydown', handler)
  }, [onRespond])

  const target = request.context.target
  const label = target
    ? `${request.action}: ${target}`
    : request.action

  return (
    <div
      ref={barRef}
      tabIndex={0}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--border)',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 12,
        color: 'var(--fg)',
        outline: 'none',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: request.severity === 'high' ? 'var(--red)' : 'var(--yellow)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <button onClick={() => onRespond('approve')} style={btnStyle('var(--green)')}>
        Allow
      </button>
      <button onClick={() => onRespond('deny')} style={btnStyle('var(--red)')}>
        Deny
      </button>
    </div>
  )
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    padding: '2px 10px',
    fontSize: 11,
    fontFamily: 'inherit',
    cursor: 'pointer',
    lineHeight: '18px',
  }
}
