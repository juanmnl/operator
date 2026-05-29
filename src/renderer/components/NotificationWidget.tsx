import { OperatorRequest, RequestOption } from '../../shared/types'

const DEFAULT_OPTIONS: RequestOption[] = [
  { label: 'Y', value: 'approve' },
  { label: 'N', value: 'deny' },
]

interface Props {
  request: OperatorRequest
  queueSize: number
  onRespond: (value: string) => void
  onRespondAll: (value: string) => void
  onRespondAndRemember?: (action: 'approve' | 'deny') => void
}

export function NotificationWidget({ request, queueSize, onRespond, onRespondAll, onRespondAndRemember }: Props) {
  const options = request.options || DEFAULT_OPTIONS
  const severity = request.severity
  const severityColor = severity === 'high' ? '#ef5252' : severity === 'medium' ? '#f59e0b' : '#6b6b6b'

  // Extract a short action label
  const toolName = request.action || 'Tool'
  const target = request.context.target || ''
  const shortTarget = target.split('/').pop() || ''

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: 540,
        borderRadius: 12,
        background: 'rgba(20, 20, 22, 0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        padding: '10px 14px',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Severity dot */}
      <div style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: severityColor,
        flexShrink: 0,
      }} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#f0f0f0' }}>
            {toolName}
          </span>
          {shortTarget && (
            <span style={{ fontSize: 10, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortTarget}
            </span>
          )}
        </div>
        <p style={{
          fontSize: 10,
          color: '#777',
          margin: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}>
          {request.context.workingDirectory?.split('/').pop() || ''}
          {queueSize > 1 && (
            <span style={{ marginLeft: 8, opacity: 0.5 }}>+{queueSize - 1} more</span>
          )}
        </p>
      </div>

      {/* Actions */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 4, alignItems: 'center' }}>
        <button
          onClick={() => onRespond(options[0]?.value || 'approve')}
          style={{
            padding: '4px 12px',
            fontSize: 11,
            fontWeight: 500,
            fontFamily: 'inherit',
            background: 'rgba(74, 222, 128, 0.15)',
            color: '#4ade80',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Allow
        </button>
        {onRespondAndRemember && (
          <button
            onClick={() => onRespondAndRemember('approve')}
            title="Always allow this tool / pattern"
            style={{
              padding: '4px 8px',
              fontSize: 10,
              fontWeight: 500,
              fontFamily: 'inherit',
              background: 'transparent',
              color: '#4ade80',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              opacity: 0.7,
              textDecoration: 'underline dotted',
              textUnderlineOffset: 2,
            }}
          >
            Always
          </button>
        )}
        <button
          onClick={() => onRespond(options[1]?.value || 'deny')}
          style={{
            padding: '4px 12px',
            fontSize: 11,
            fontWeight: 500,
            fontFamily: 'inherit',
            background: 'rgba(239, 82, 82, 0.15)',
            color: '#ef5252',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Deny
        </button>
        {queueSize > 1 && (
          <button
            onClick={() => onRespondAll(options[0]?.value || 'approve')}
            style={{
              padding: '4px 8px',
              fontSize: 10,
              fontWeight: 500,
              fontFamily: 'inherit',
              background: 'rgba(255,255,255,0.04)',
              color: '#666',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            All
          </button>
        )}
      </div>
    </div>
  )
}
