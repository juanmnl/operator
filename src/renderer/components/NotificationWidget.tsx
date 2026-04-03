import { OperatorRequest, RequestOption } from '../../shared/types'
import logoUrl from '../../../assets/logo-light-64.png'

const DEFAULT_OPTIONS: RequestOption[] = [
  { label: 'Y', value: 'approve', color: '#ef7b55' },
  { label: 'N', value: 'deny', color: '#ef5252' },
]

interface Props {
  request: OperatorRequest
  queueSize: number
  onRespond: (value: string) => void
  onRespondAll: (value: string) => void
}

export function NotificationWidget({ request, queueSize, onRespond, onRespondAll }: Props) {
  const options = request.options || DEFAULT_OPTIONS
  const projectName = request.context.workingDirectory?.split('/').pop() || 'Unknown'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 15,
        width: 556,
        borderRadius: 78,
        background: 'rgba(24, 24, 24, 0.98)',
        paddingLeft: 10,
        paddingRight: 20,
        paddingTop: 10,
        paddingBottom: 10,
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Agent icon */}
      <div
        style={{
          flexShrink: 0,
          width: 48,
          height: 48,
          borderRadius: 45,
          background: 'rgba(217, 119, 87, 0.19)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <img src={logoUrl} width="31" height="31" alt="" />
      </div>

      {/* Location and message */}
      <div
        style={{
          flex: '1 1 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minWidth: 0,
          height: 48,
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            fontSize: 8,
            lineHeight: 'normal',
            color: '#adadad',
            fontWeight: 400,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            margin: 0,
          }}
        >
          {request.context.workingDirectory || projectName}
        </p>
        <p
          style={{
            overflow: 'hidden',
            fontSize: 12,
            lineHeight: 'normal',
            color: 'white',
            fontWeight: 400,
            margin: 0,
            flex: '1 1 0',
            minHeight: 1,
            minWidth: 1,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            textOverflow: 'ellipsis',
            wordBreak: 'break-word',
          }}
        >
          {request.message}
        </p>
      </div>

      {/* Actions */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          gap: 5,
          alignItems: 'center',
        }}
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onRespond(opt.value)}
            style={circleBtn(opt.color || '#555')}
          >
            {opt.label}
          </button>
        ))}
        {queueSize > 1 && (
          <button
            onClick={() => onRespondAll(options[0]?.value || 'approve')}
            style={circleBtn('rgba(239, 82, 82, 0.33)')}
          >
            <span style={{ lineHeight: '9px', fontSize: 10, textAlign: 'center' }}>
              <span style={{ display: 'block' }}>Y</span>
              <span style={{ display: 'block' }}>(all)</span>
            </span>
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
    fontSize: 12,
    fontWeight: 400,
    fontFamily: 'inherit',
    width: 32,
    height: 32,
    borderRadius: 90,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px 0',
    lineHeight: 1,
  }
}
