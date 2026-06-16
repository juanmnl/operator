import { useEffect, useState } from 'react'
import { themes, type OperatorTheme } from '../../themes'

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'error' }

export function PrefsView({ currentTheme, onSelectTheme }: {
  currentTheme: OperatorTheme
  onSelectTheme: (key: string) => void
}) {
  const [version, setVersion] = useState<string | null>(null)
  const [state, setState] = useState<CheckState>({ kind: 'idle' })
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    window.operator.getVersion?.().then(setVersion).catch(() => { /* */ })
  }, [])

  const check = () => {
    setState({ kind: 'checking' })
    window.operator.checkUpdate?.().then((u) => {
      setState(u ? { kind: 'available', version: u.version } : { kind: 'uptodate' })
    }).catch(() => setState({ kind: 'error' }))
  }

  const install = () => {
    setInstalling(true)
    void window.operator.installUpdate?.() // downloads, installs, relaunches
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
        <section style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', margin: '0 0 2px' }}>
            Theme
          </h3>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 12px', opacity: 0.7 }}>
            Also switchable from the command palette (⌘K → “Theme: …”).
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(themes).map(([key, theme]) => {
              const active = theme === currentTheme
              return (
                <button
                  key={key}
                  onClick={() => onSelectTheme(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 12px', borderRadius: 6, cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 11, fontWeight: 500,
                    color: 'var(--fg)',
                    background: active ? 'var(--bg-surface)' : 'transparent',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  {/* swatch: the theme's own surface + accent */}
                  <span style={{
                    width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                    background: theme.vars['--bg-terminal'],
                    border: `1px solid ${theme.vars['--border']}`,
                    boxShadow: `inset 0 0 0 3px ${theme.vars['--accent']}`,
                  }} />
                  {theme.name}
                  {active && <span style={{ color: 'var(--accent)', fontSize: 10 }}>✓</span>}
                </button>
              )
            })}
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', margin: '0 0 2px' }}>
            Updates
          </h3>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 12px', opacity: 0.7 }}>
            Operator checks for updates on launch and every few hours.{' '}
            {version ? <>You're on <strong style={{ color: 'var(--fg)' }}>v{version}</strong>.</> : null}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {state.kind === 'available' ? (
              <button
                onClick={install}
                disabled={installing}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 600,
                  background: 'var(--accent)', border: '1px solid var(--accent)',
                  borderRadius: 5, color: 'var(--fg-on-accent)', fontFamily: 'inherit',
                  cursor: installing ? 'default' : 'pointer', opacity: installing ? 0.6 : 1,
                }}
              >
                {installing ? 'Installing…' : `Install v${state.version} & Restart`}
              </button>
            ) : (
              <button
                onClick={check}
                disabled={state.kind === 'checking'}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 500,
                  background: 'var(--btn-bg)', border: '1px solid var(--border)',
                  borderRadius: 5, color: 'var(--fg)', fontFamily: 'inherit',
                  cursor: state.kind === 'checking' ? 'default' : 'pointer',
                  opacity: state.kind === 'checking' ? 0.6 : 1,
                }}
              >
                {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            )}

            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {state.kind === 'uptodate' && 'You’re up to date.'}
              {state.kind === 'available' && `Update ${state.version} available.`}
              {state.kind === 'error' && 'Couldn’t reach the releases feed.'}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}
