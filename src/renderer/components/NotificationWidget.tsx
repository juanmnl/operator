import { OperatorRequest, RequestOption } from '../../shared/types'

const DEFAULT_OPTIONS: RequestOption[] = [
  { label: 'Y', value: 'approve', color: '#ef7b55' },
  { label: 'N', value: 'deny', color: '#ef5252' },
]

const OperatorLogo = () => (
  <svg width="28" height="28" viewBox="40 45 120 115" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M153.502 48.6665C155.779 48.6667 157.226 51.104 156.136 53.103L142.544 78.0317H132.329C131.777 78.032 131.329 78.4796 131.329 79.0317V91.2866C131.329 91.8388 131.777 92.2864 132.329 92.2866H134.772L114.45 129.561H105.5C104.948 129.561 104.5 130.009 104.5 130.561V138.61C104.5 139.162 104.948 139.61 105.5 139.61H108.972L103.381 149.865C102.244 151.95 99.2492 151.95 98.1123 149.865L79.707 116.106H92.7881C93.3403 116.106 93.7881 115.658 93.7881 115.106V112.292C93.7881 111.74 93.3403 111.293 92.7881 111.292H77.083L75.6016 108.575H90.3477C90.8998 108.575 91.3474 108.127 91.3477 107.575V103.614C91.3477 103.061 90.8999 102.614 90.3477 102.614H72.3516L45.3574 53.103C44.2677 51.1039 45.7153 48.6665 47.9922 48.6665H153.502Z" fill="rgba(255,255,255,0.3)"/>
    <path d="M134.507 62C136.784 62.0001 138.231 64.4375 137.141 66.4365L128.812 81.7119H122.283C121.731 81.712 121.283 82.1597 121.283 82.7119V90.2803C121.283 90.8325 121.731 91.2802 122.283 91.2803H123.596L109.954 116.301H104.274C103.722 116.301 103.274 116.749 103.274 117.301V122.047C103.275 122.599 103.722 123.047 104.274 123.047H106.276L103.39 128.342C102.253 130.427 99.258 130.427 98.1211 128.342L83.876 102.214H93.4463C93.9984 102.214 94.4461 101.766 94.4463 101.214V99.2129C94.4463 98.6606 93.9985 98.213 93.4463 98.2129H81.8672C81.8109 98.2129 81.7559 98.2176 81.7021 98.2266L64.3701 66.4365C63.2803 64.4375 64.7272 62.0003 67.0039 62H134.507Z" fill="rgba(255,255,255,0.7)"/>
  </svg>
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
          background: 'rgba(217, 119, 87, 0.15)',
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
