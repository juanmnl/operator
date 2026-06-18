import { useEffect, useState } from 'react'
import { themes, themeKey, identities, type OperatorTheme } from '../../themes'
import { LogoMark } from '../LogoMark'

const MONO = "'SF Mono', 'Fira Code', Menlo, monospace"

type DockVariant = 'light' | 'dark'

/** Previews a dock-icon variant by rendering the actual dot mark over the same
 *  background as the generated PNG (cream for light, a dark depth-gradient for
 *  dark). `--fg` is overridden locally so LogoMark fills with the dot color. */
function IconCard({ variant, active, onSelect }: {
  variant: DockVariant
  active: boolean
  onSelect: () => void
}) {
  const light = variant === 'light'
  const bg = light
    ? '#f4f1ec'
    : 'radial-gradient(115% 115% at 38% 30%, #2a2d37 0%, #1b1d24 55%, #101216 100%)'
  const dot = light ? '#24292F' : '#f4f1ec'
  return (
    <button
      onClick={onSelect}
      title={`${light ? 'Light' : 'Dark'} dock icon`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 0, padding: 0, cursor: 'pointer',
        borderRadius: 9, overflow: 'hidden', textAlign: 'left', background: 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        boxShadow: active ? '0 0 0 1px var(--accent)' : 'none',
      }}
    >
      <div style={{ background: bg, padding: '18px 0', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        {/* macOS squircle-ish tile so the swatch reads as an app icon */}
        <span style={{
          ['--fg' as string]: dot, display: 'inline-flex', padding: 10, borderRadius: 14,
          background: bg, boxShadow: light ? 'inset 0 0 0 1px rgba(0,0,0,0.06)' : 'inset 0 0 0 1px rgba(255,255,255,0.05)',
        }}>
          <LogoMark size={48} animated={false} />
        </span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        padding: '6px 9px', background: 'var(--bg-sidebar)', borderTop: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg)' }}>{light ? 'Light' : 'Dark'}</span>
        <span
          aria-hidden
          style={{
            width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 8, color: 'var(--bg-terminal)',
            background: active ? 'var(--accent)' : 'transparent',
            border: active ? 'none' : '1px solid var(--border)',
          }}
        >{active ? '✓' : ''}</span>
      </div>
    </button>
  )
}

/** A theme tile that previews the palette as a miniature terminal, so the choice
 *  reads like what you'll actually see rather than a single swatch. Styled with
 *  the variant's OWN colors (not the live CSS vars) so every tile shows its theme
 *  regardless of which one is currently applied. */
function ThemeCard({ name, variant, active, onSelect }: {
  name: string
  variant: OperatorTheme
  active: boolean
  onSelect: () => void
}) {
  const v = variant.vars
  const x = variant.xterm
  const line: React.CSSProperties = { display: 'flex', gap: 5, fontFamily: MONO, fontSize: 8.5, lineHeight: '12px', whiteSpace: 'nowrap' }
  return (
    <button
      onClick={onSelect}
      title={`${name} · ${variant.mode}`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 0, padding: 0, cursor: 'pointer',
        borderRadius: 9, overflow: 'hidden', textAlign: 'left',
        background: 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        boxShadow: active ? '0 0 0 1px var(--accent)' : 'none',
      }}
    >
      {/* miniature terminal */}
      <div style={{ background: v['--bg-terminal'], padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: 3, minHeight: 64 }}>
        <div style={line}>
          <span style={{ color: x.green }}>❯</span>
          <span style={{ color: x.foreground }}>npm run dev</span>
        </div>
        <div style={line}>
          <span style={{ color: x.cyan }}>Local:</span>
          <span style={{ color: x.brightBlack || v['--fg-muted'] }}>localhost:5173</span>
        </div>
        <div style={{ ...line, color: x.yellow }}>
          <span>✓ ready in 312 ms</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
          <span style={{ width: 22, height: 7, borderRadius: 3, background: v['--accent'] }} />
          <span style={{ width: 10, height: 7, borderRadius: 3, background: x.magenta, opacity: 0.85 }} />
          <span style={{ width: 10, height: 7, borderRadius: 3, background: x.blue, opacity: 0.85 }} />
        </div>
      </div>
      {/* label strip — uses the variant's sidebar tone so the whole tile is themed */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        padding: '6px 9px', background: v['--bg-sidebar'] || v['--bg-terminal'],
        borderTop: `1px solid ${v['--border']}`,
      }}>
        <span style={{ fontFamily: 'inherit', fontSize: 11, fontWeight: 600, color: v['--fg'] }}>{name}</span>
        <span
          aria-hidden
          style={{
            width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 8, color: v['--bg-terminal'],
            background: active ? v['--accent'] : 'transparent',
            border: active ? 'none' : `1px solid ${v['--border']}`,
          }}
        >{active ? '✓' : ''}</span>
      </div>
    </button>
  )
}

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'error' }

export function PrefsView({ currentTheme, onSelectTheme, onToggleTheme }: {
  currentTheme: OperatorTheme
  onSelectTheme: (key: string) => void
  onToggleTheme: () => void
}) {
  const mode: 'light' | 'dark' = currentTheme.isDark ? 'dark' : 'light'
  const [version, setVersion] = useState<string | null>(null)
  const [state, setState] = useState<CheckState>({ kind: 'idle' })
  const [installing, setInstalling] = useState(false)
  const [dockIcon, setDockIcon] = useState<DockVariant>(
    () => (localStorage.getItem('operator.dockIcon') === 'dark' ? 'dark' : 'light'),
  )

  const selectDockIcon = (v: DockVariant) => {
    setDockIcon(v)
    localStorage.setItem('operator.dockIcon', v)
    window.operator.setDockIcon?.(v)
  }

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

        <section style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 2 }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
              Theme
            </h3>
            {/* Light/Dark applies within whichever identity is selected. */}
            <div style={{ display: 'flex', padding: 2, gap: 2, borderRadius: 7, background: 'var(--overlay-subtle)', border: '1px solid var(--border)' }}>
              {(['light', 'dark'] as const).map((m) => {
                const on = mode === m
                return (
                  <button
                    key={m}
                    onClick={() => { if (!on) onToggleTheme() }}
                    style={{
                      padding: '3px 11px', borderRadius: 5, cursor: on ? 'default' : 'pointer',
                      fontFamily: 'inherit', fontSize: 10, fontWeight: 600, textTransform: 'capitalize',
                      border: 'none', color: on ? 'var(--fg)' : 'var(--fg-muted)',
                      background: on ? 'var(--bg-surface)' : 'transparent',
                    }}
                  >
                    {m}
                  </button>
                )
              })}
            </div>
          </div>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 12px', opacity: 0.7 }}>
            Also switchable from the command palette (⌘K → “Theme: …”).
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
            {identities.map(({ id, name }) => (
              <ThemeCard
                key={id}
                name={name}
                variant={themes[themeKey(id, mode)]}
                active={currentTheme.identity === id}
                onSelect={() => onSelectTheme(id)}
              />
            ))}
          </div>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', margin: '0 0 2px' }}>
            Dock icon
          </h3>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 12px', opacity: 0.7 }}>
            Pick the app icon that suits your dock. Applies instantly; restored on every launch.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 150px))', gap: 10 }}>
            {(['light', 'dark'] as const).map((v) => (
              <IconCard key={v} variant={v} active={dockIcon === v} onSelect={() => selectDockIcon(v)} />
            ))}
          </div>
        </section>

      </div>
    </div>
  )
}
