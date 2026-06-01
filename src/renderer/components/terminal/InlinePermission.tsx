import { OperatorRequest } from '../../../shared/types'
import { useEffect, useRef } from 'react'

interface InlinePermissionProps {
  request: OperatorRequest
  onRespond: (value: string) => void
  onRespondAndRemember?: (value: 'approve' | 'deny') => void
}

export function InlinePermission({ request, onRespond, onRespondAndRemember }: InlinePermissionProps) {
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
  const preview = request.context.preview
  const severityColor = request.severity === 'high' ? 'var(--red)' : request.severity === 'medium' ? 'var(--yellow)' : 'var(--fg-muted)'

  return (
    <div
      ref={barRef}
      tabIndex={0}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--border)',
        fontFamily: "'Inter', system-ui, sans-serif",
        outline: 'none',
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: severityColor, flexShrink: 0,
      }} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>
            {request.action}
          </span>
          {target && (
            <span style={{
              fontSize: 11, color: 'var(--fg-muted)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
              minWidth: 0,
            }}>
              {target}
            </span>
          )}
        </div>
        {preview && preview !== target && (
          <span style={{
            fontSize: 10, color: 'var(--fg-muted)', opacity: 0.6,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {preview}
          </span>
        )}
      </div>

      <button onClick={() => onRespond('approve')} style={btnStyle('var(--color-success)')}>
        Allow
      </button>
      {onRespondAndRemember && (
        <button
          onClick={() => onRespondAndRemember('approve')}
          style={ghostBtnStyle('var(--color-success)')}
          title={`Always allow ${request.toolName || request.action}${request.context.target ? ` matching ${request.context.target}` : ''}${request.context.workingDirectory ? ` in this project` : ''}`}
        >
          Always
        </button>
      )}
      <button onClick={() => onRespond('deny')} style={btnStyle('var(--color-error)')}>
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
    flexShrink: 0,
  }
}

function ghostBtnStyle(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    color,
    border: 'none',
    padding: '2px 6px',
    fontSize: 10,
    fontFamily: 'inherit',
    fontWeight: 500,
    cursor: 'pointer',
    lineHeight: '18px',
    flexShrink: 0,
    opacity: 0.7,
    textDecoration: 'underline dotted',
    textUnderlineOffset: 2,
  }
}
