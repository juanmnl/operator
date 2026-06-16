export function PrefsView() {
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
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6, lineHeight: 1.6 }}>
          No app preferences yet.
        </p>
      </div>
    </div>
  )
}
