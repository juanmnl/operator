import { useState } from 'react'

export interface SessionConfig {
  effortLevel: 'high' | 'normal' | 'low'
  permissionMode: 'default' | 'auto' | 'bypassPermissions'
  model: string
  allowedTools: string
}

interface NewSessionPanelProps {
  cwd: string
  onLaunch: (cwd: string, config: SessionConfig) => void
  onCancel: () => void
}

const EFFORT_LEVELS = ['high', 'normal', 'low'] as const
const PERMISSION_MODES = [
  { value: 'default', label: 'Default', desc: 'Ask for write operations' },
  { value: 'auto', label: 'Auto', desc: 'Auto-approve most operations' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Skip all permission checks' },
] as const

export function NewSessionPanel({ cwd, onLaunch, onCancel }: NewSessionPanelProps) {
  const [effortLevel, setEffortLevel] = useState<SessionConfig['effortLevel']>('high')
  const [permissionMode, setPermissionMode] = useState<SessionConfig['permissionMode']>('default')
  const [model, setModel] = useState('')
  const [allowedTools, setAllowedTools] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const projectName = cwd.split('/').pop() || cwd

  const handleLaunch = () => {
    onLaunch(cwd, { effortLevel, permissionMode, model, allowedTools })
  }

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
        overflow: 'auto',
        minHeight: 0,
      }}
    >
      <div style={{
        width: '100%',
        maxWidth: 380,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '24px',
      }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: '0 0 4px' }}>
          New Session
        </h3>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 20px', opacity: 0.6 }}>
          {cwd}
        </p>

        {/* Effort Level */}
        <SegmentedControl
          label="Effort"
          options={EFFORT_LEVELS.map((l) => ({ value: l, label: l }))}
          value={effortLevel}
          onChange={(v) => setEffortLevel(v as SessionConfig['effortLevel'])}
        />

        {/* Permission Mode */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Permissions</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {PERMISSION_MODES.map((mode) => (
              <button
                key={mode.value}
                onClick={() => setPermissionMode(mode.value as SessionConfig['permissionMode'])}
                style={{
                  flex: 1,
                  padding: '6px 0',
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: permissionMode === mode.value ? 'rgba(255,255,255,0.1)' : 'var(--bg-terminal)',
                  color: permissionMode === mode.value ? 'var(--fg)' : 'var(--fg-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  cursor: 'pointer',
                  transition: 'background 0.1s, color 0.1s',
                }}
                title={mode.desc}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.5, margin: '4px 0 0' }}>
            {PERMISSION_MODES.find((m) => m.value === permissionMode)?.desc}
          </p>
        </div>

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            background: 'none', border: 'none', color: 'var(--fg-muted)',
            fontSize: 10, fontFamily: 'inherit', cursor: 'pointer',
            opacity: 0.5, padding: 0, marginBottom: showAdvanced ? 12 : 20,
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <span style={{
            display: 'inline-block', fontSize: 8,
            transform: showAdvanced ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
          }}>&#9654;</span>
          Advanced
        </button>

        {showAdvanced && (
          <div style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Model */}
            <div>
              <label style={labelStyle}>Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="default (opus, sonnet, haiku)"
                style={inputStyle}
              />
            </div>

            {/* Allowed Tools */}
            <div>
              <label style={labelStyle}>Allowed Tools</label>
              <input
                type="text"
                value={allowedTools}
                onChange={(e) => setAllowedTools(e.target.value)}
                placeholder='e.g. Bash(git:*) Edit Read'
                style={inputStyle}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={cancelBtnStyle}>
            Cancel
          </button>
          <button onClick={handleLaunch} style={launchBtnStyle}>
            Launch {projectName}
          </button>
        </div>
      </div>
    </div>
  )
}

function SegmentedControl({ label, options, value, onChange }: {
  label: string
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={labelStyle}>{label}</label>
      <div style={{
        display: 'flex', gap: 0, borderRadius: 6,
        border: '1px solid var(--border)', overflow: 'hidden',
      }}>
        {options.map((opt, i) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1, padding: '7px 0', fontSize: 11, fontWeight: 500,
              fontFamily: 'inherit', textTransform: 'capitalize',
              background: value === opt.value ? 'rgba(255,255,255,0.1)' : 'var(--bg-terminal)',
              color: value === opt.value ? 'var(--fg)' : 'var(--fg-muted)',
              border: 'none', cursor: 'pointer',
              borderRight: i < options.length - 1 ? '1px solid var(--border)' : 'none',
              transition: 'background 0.1s, color 0.1s',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 500, color: 'var(--fg-muted)',
  display: 'block', marginBottom: 6, textTransform: 'uppercase',
  letterSpacing: 0.3,
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 11,
  fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
  background: 'var(--bg-terminal)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 5,
  outline: 'none', boxSizing: 'border-box',
}

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: '8px 0', background: 'var(--bg-terminal)',
  border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--fg-muted)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
}

const launchBtnStyle: React.CSSProperties = {
  flex: 2, padding: '8px 0', background: 'var(--btn-bg)',
  border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--fg)', fontSize: 12, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
}
