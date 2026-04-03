import { useState } from 'react'

interface NewSessionPanelProps {
  cwd: string
  onLaunch: (cwd: string, effortLevel: 'high' | 'normal' | 'low') => void
  onCancel: () => void
}

const LEVELS = ['high', 'normal', 'low'] as const
type EffortLevel = (typeof LEVELS)[number]

export function NewSessionPanel({ cwd, onLaunch, onCancel }: NewSessionPanelProps) {
  const [effortLevel, setEffortLevel] = useState<EffortLevel>('high')
  const projectName = cwd.split('/').pop() || cwd

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', system-ui, sans-serif",
        padding: '0 40px',
      }}
    >
      <div style={{
        width: '100%',
        maxWidth: 360,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '28px 24px',
      }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: '0 0 4px' }}>
          New Session
        </h3>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 20px', opacity: 0.6 }}>
          {cwd}
        </p>

        {/* Effort Level */}
        <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', display: 'block', marginBottom: 8 }}>
          Effort Level
        </label>
        <div style={{
          display: 'flex',
          gap: 0,
          borderRadius: 6,
          border: '1px solid var(--border)',
          overflow: 'hidden',
          marginBottom: 24,
        }}>
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => setEffortLevel(level)}
              style={{
                flex: 1,
                padding: '8px 0',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                textTransform: 'capitalize',
                background: effortLevel === level ? 'rgba(255,255,255,0.1)' : 'var(--bg-terminal)',
                color: effortLevel === level ? 'var(--fg)' : 'var(--fg-muted)',
                border: 'none',
                cursor: 'pointer',
                borderRight: level !== 'low' ? '1px solid var(--border)' : 'none',
                transition: 'background 0.1s, color 0.1s',
              }}
            >
              {level}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: '8px 0',
              background: 'var(--bg-terminal)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--fg-muted)',
              fontSize: 12,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onLaunch(cwd, effortLevel)}
            style={{
              flex: 2,
              padding: '8px 0',
              background: '#1C1C24',
              border: '1px solid rgba(0,0,0,0.4)',
              borderRadius: 6,
              color: 'var(--fg)',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Launch {projectName}
          </button>
        </div>
      </div>
    </div>
  )
}
