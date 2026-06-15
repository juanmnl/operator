import type { OperatorPrefs } from '../../../shared/types'

interface PrefsViewProps {
  prefs: OperatorPrefs
  onChange: (next: OperatorPrefs) => void
}

export function PrefsView({ prefs, onChange }: PrefsViewProps) {
  const set = <K extends keyof OperatorPrefs>(key: K, value: OperatorPrefs[K]) => {
    onChange({ ...prefs, [key]: value })
  }

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden',
    }}>
      <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
          Operator preferences
        </h2>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '4px 0 0', opacity: 0.7 }}>
          App-level behavior. Per-project Claude Code settings live in the project's gear menu.
        </p>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', maxWidth: 560 }}>
        <ToggleRow
          label="Native notifications"
          description="Ping with a macOS notification when an agent needs approval, only while Operator is unfocused. Click it to jump to that session."
          checked={prefs.nativeNotifications}
          onChange={(v) => set('nativeNotifications', v)}
        />
      </div>
    </div>
  )
}

function ToggleRow({ label, description, checked, onChange }: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 14,
      padding: '14px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 3, opacity: 0.7, lineHeight: 1.5 }}>
          {description}
        </div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        style={{
          width: 36, height: 20, borderRadius: 10,
          border: 'none',
          background: checked ? 'var(--accent)' : 'var(--overlay-medium)',
          cursor: 'pointer', position: 'relative',
          transition: 'background 0.15s', flexShrink: 0, marginTop: 2,
        }}
      >
        <div style={{
          width: 14, height: 14, borderRadius: '50%',
          background: 'var(--fg-on-accent)',
          position: 'absolute', top: 3,
          left: checked ? 19 : 3,
          transition: 'left 0.15s',
        }} />
      </button>
    </div>
  )
}
