import { OperatorRequest, RequestOption } from '../../shared/types'
import logoUrl from '../../../assets/logo-light-64.png'

const DEFAULT_OPTIONS: RequestOption[] = [
  { label: 'Y', value: 'approve', color: '#ef7b55' },
  { label: 'N', value: 'deny', color: '#ef5252' },
]

const OperatorLogo = () => (
  <img src={logoUrl} width="24" height="24" alt="" style={{ borderRadius: 9999, marginLeft: 1 }} />
)

interface Props {
  request: OperatorRequest
  queueSize: number
  onRespond: (value: string) => void
  onRespondAll: (value: string) => void
}

export function NotificationWidget({ request, queueSize, onRespond, onRespondAll }: Props) {
  const options = request.options || DEFAULT_OPTIONS

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: 500,
        borderRadius: 78,
        background: 'rgba(24, 24, 24, 0.98)',
        paddingLeft: 10,
        paddingRight: 16,
        paddingTop: 10,
        paddingBottom: 10,
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Agent icon */}
      <div
        style={{
          flexShrink: 0,
          width: 42,
          height: 42,
          borderRadius: 9999,
          background: 'rgba(255, 255, 255, 0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <OperatorLogo />
      </div>

      {/* Location and message */}
      <div
        style={{
          flex: '1 1 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minWidth: 0,
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            fontSize: 9,
            lineHeight: 'normal',
            color: '#adadad',
            fontWeight: 400,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            margin: 0,
          }}
        >
          {request.context.workingDirectory || request.agentId}
        </p>
        <p
          style={{
            overflow: 'hidden',
            fontSize: 12,
            lineHeight: '15px',
            color: 'white',
            fontWeight: 400,
            margin: 0,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            textOverflow: 'ellipsis',
            wordBreak: 'break-word',
          }}
        >
          {request.message}
        </p>
        {queueSize > 1 && (
          <p style={{ fontSize: 8, lineHeight: 'normal', color: '#555', margin: 0 }}>
            +{queueSize - 1} more
          </p>
        )}
      </div>

      {/* Actions */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onRespond(opt.value)}
              style={circleBtn(opt.color || '#555')}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {queueSize > 1 && (
          <button
            onClick={() => onRespondAll(options[0]?.value || 'approve')}
            style={{
              background: 'rgba(217, 110, 110, 0.2)',
              color: 'white',
              fontSize: 7,
              fontWeight: 400,
              fontFamily: 'inherit',
              textTransform: 'uppercase' as const,
              padding: '1px 6px',
              height: 12,
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              lineHeight: 1,
            }}
          >
            {options[0]?.label || 'Y'}(all)
          </button>
        )}
      </div>
    </div>
  )
}

function circleBtn(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: 'white',
    fontSize: 11,
    fontWeight: 400,
    fontFamily: 'inherit',
    width: 26,
    height: 26,
    borderRadius: 9999,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    lineHeight: 1,
  }
}
