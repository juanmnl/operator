import { OperatorRequest } from '../../shared/types'

const ClaudeIcon = () => (
  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M4.709 15.955l4.72-10.478a.857.857 0 0 1 1.575.014l4.7 10.79a.5.5 0 0 1-.46.696h-2.1a.5.5 0 0 1-.457-.297l-2.573-5.845a.1.1 0 0 0-.184.002L7.27 16.65a.5.5 0 0 1-.456.294H4.709a.1.1 0 0 1-.091-.14l.091-.849Zm6.291-.023h4.2a.5.5 0 0 1 .457.703l-.7 1.597a.5.5 0 0 1-.457.297H9.7a.5.5 0 0 1-.46-.696l1.3-1.597a.5.5 0 0 1 .46-.304Z"
      fill="#D97757"
    />
    <path
      d="M16.8 7.2a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z"
      fill="#D97757"
    />
  </svg>
)

interface Props {
  request: OperatorRequest
  queueSize: number
  onAccept: () => void
  onDeny: () => void
  onAcceptAll: () => void
}

export function NotificationWidget({ request, queueSize, onAccept, onDeny, onAcceptAll }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: 390,
        borderRadius: 18,
        background: '#000000',
        paddingLeft: 10,
        paddingRight: 12,
        paddingTop: 10,
        paddingBottom: 10,
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Agent icon */}
      <div
        style={{
          flexShrink: 0,
          width: 64,
          height: 64,
          borderRadius: 10,
          background: 'rgba(217, 119, 87, 0.19)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ClaudeIcon />
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
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical' as const,
            textOverflow: 'ellipsis',
            wordBreak: 'break-word',
          }}
        >
          {request.message}
        </p>
        {queueSize > 1 && (
          <p
            style={{
              fontSize: 8,
              lineHeight: 'normal',
              color: '#666',
              margin: 0,
            }}
          >
            +{queueSize - 1} more pending
          </p>
        )}
      </div>

      {/* Actions */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          alignItems: 'stretch',
        }}
      >
        <button
          onClick={onAccept}
          style={{
            background: '#d97757',
            color: 'white',
            fontSize: 12,
            fontWeight: 400,
            fontFamily: 'inherit',
            paddingLeft: 10,
            paddingRight: 10,
            paddingTop: 2,
            paddingBottom: 2,
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            lineHeight: 'normal',
          }}
        >
          Accept
        </button>
        <button
          onClick={onDeny}
          style={{
            background: '#d95757',
            color: 'white',
            fontSize: 12,
            fontWeight: 400,
            fontFamily: 'inherit',
            paddingLeft: 10,
            paddingRight: 10,
            paddingTop: 2,
            paddingBottom: 2,
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            lineHeight: 'normal',
          }}
        >
          Deny
        </button>
        <button
          onClick={onAcceptAll}
          style={{
            background: 'rgba(217, 110, 110, 0.2)',
            color: 'white',
            fontSize: 8,
            fontWeight: 400,
            fontFamily: 'inherit',
            textTransform: 'uppercase' as const,
            paddingLeft: 4,
            paddingRight: 4,
            paddingTop: 1,
            paddingBottom: 1,
            borderRadius: 10,
            border: 'none',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            lineHeight: 'normal',
          }}
        >
          Accept all
        </button>
      </div>
    </div>
  )
}
