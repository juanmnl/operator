import { useEffect, useState } from 'react'
import { PageShell, sectionHeader, sectionDesc, SECTION_GAP } from '../settings/PageShell'
import { themes, themeKey, identities, type OperatorTheme } from '../../themes'
import { LogoMark } from '../LogoMark'
import { soundsEnabled, setSoundsEnabled, playYourTurnChime } from '../../lib/sounds'
import {
  IDLE, installPressed, installProgressed, installFailed,
  installBusy, installLabel, installStatus, type InstallState,
} from '../../lib/update-install'
import { getMacOptionIsMeta, setMacOptionIsMeta, getTuiMode, setTuiMode } from '../../lib/terminal-options'
import { resumeOnLaunchEnabled, RESUME_ON_LAUNCH_KEY } from '../../lib/workspace'
import { askBeforeQuitEnabled, ASK_BEFORE_QUIT_KEY } from '../../lib/quit-guard'
import { getKeepWarmMinutes, setKeepWarmMinutes, DEFAULT_KEEP_WARM_MINUTES } from '../../lib/lane-lifecycle'

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
        outline: 'none',
        // Selection = accent border only (colour for meaning); no box-shadow ring
        // and no solid-accent fill anywhere, per the global UI style rule.
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
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
            fontSize: 10, fontWeight: 700, lineHeight: 1,
            // Accent check (colour for meaning, no fill) when selected; hollow ring otherwise.
            color: active ? 'var(--accent)' : 'transparent',
            background: 'transparent',
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
        background: 'transparent', outline: 'none',
        // Accent border for selection — no ring, no solid fill (global UI rule).
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
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
            fontSize: 10, fontWeight: 700, lineHeight: 1,
            // Accent check (no fill) when selected; hollow ring otherwise.
            color: active ? v['--accent'] : 'transparent',
            background: 'transparent',
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
  // The install, as a state rather than the boolean it was. `installing` went true on the press
  // and never came back, so a running download, a finished one and one that died in its first
  // second were the same pixel — see lib/update-install.ts.
  const [installState, setInstall] = useState<InstallState>(IDLE)
  const [dockIcon, setDockIcon] = useState<DockVariant>(
    () => (localStorage.getItem('operator.dockIcon') === 'dark' ? 'dark' : 'light'),
  )
  const [sounds, setSounds] = useState(() => soundsEnabled())
  const [optionIsMeta, setOptionIsMeta] = useState(() => getMacOptionIsMeta())
  const [fullscreenTui, setFullscreenTui] = useState(() => getTuiMode() === 'fullscreen')
  const [resumeOnLaunch, setResumeOnLaunch] = useState(() => resumeOnLaunchEnabled())
  const [askBeforeQuit, setAskBeforeQuit] = useState(() => askBeforeQuitEnabled())
  const [keepWarm, setKeepWarm] = useState(() => getKeepWarmMinutes())

  const toggleSounds = () => {
    const next = !sounds
    setSounds(next)
    setSoundsEnabled(next)
    if (next) playYourTurnChime() // preview the cue when turning it on
  }

  const toggleOptionIsMeta = () => {
    const next = !optionIsMeta
    setOptionIsMeta(next)
    setMacOptionIsMeta(next) // TerminalPane re-reads this when a pane reactivates
  }

  const toggleFullscreenTui = () => {
    const next = !fullscreenTui
    setFullscreenTui(next)
    setTuiMode(next ? 'fullscreen' : 'default') // read at spawn — applies to NEW sessions
  }


  const toggleResumeOnLaunch = () => {
    const next = !resumeOnLaunch
    setResumeOnLaunch(next)
    try { localStorage.setItem(RESUME_ON_LAUNCH_KEY, next ? '1' : '0') } catch { /* quota */ }
  }

  const toggleAskBeforeQuit = () => {
    const next = !askBeforeQuit
    setAskBeforeQuit(next)
    try { localStorage.setItem(ASK_BEFORE_QUIT_KEY, next ? '1' : '0') } catch { /* quota */ }
    // Rust owns the veto and cannot read localStorage — mirror it, or the switch is decorative.
    window.operator.quitSetAsk?.(next)
  }

  const selectKeepWarm = (minutes: number) => {
    setKeepWarm(minutes)
    setKeepWarmMinutes(minutes) // read per tick by the lane-close effect — applies immediately
  }

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

  // The main process has reported both of these since 0.18.1 (electron/src/main/updater.ts);
  // this surface was simply not listening. Subscribed on mount rather than on the press,
  // because an install started from the SIDEBAR's arrow has to show up here too — the two
  // controls drive one install, and a preferences page claiming "Install & Restart" over a
  // download already in flight is the same lie in a new place.
  useEffect(() => {
    const offProgress = window.operator.onUpdateProgress?.((percent, transferred, total) => {
      setInstall((prev) => installProgressed(prev, percent, transferred, total))
    })
    const offError = window.operator.onUpdateError?.((message) => { setInstall(installFailed(message)) })
    return () => { offProgress?.(); offError?.() }
  }, [])

  const install = () => {
    setInstall(installPressed())
    void window.operator.installUpdate?.() // downloads, installs, relaunches
  }

  return (
    <PageShell
      title="Operator preferences"
      subtitle="App-level behavior. Per-project Claude Code settings live in the project's gear menu."
      measure="form"
    >
        <section style={{ marginBottom: SECTION_GAP }}>
          <h3 data-section-header style={sectionHeader}>
            Updates
          </h3>
          <p data-section-desc style={sectionDesc}>
            Operator checks for updates on launch and every few hours.{' '}
            {version ? <>You're on <strong style={{ color: 'var(--fg)' }}>v{version}</strong>.</> : null}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {state.kind === 'available' ? (
              <button
                onClick={install}
                disabled={installBusy(installState)}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 600,
                  border: '1px solid var(--accent)',
                  // The fill IS the progress bar. A separate track under the button would be a
                  // second thing to look at for one fact, and the button is already the accent
                  // across its whole width — so the download simply un-fills it from the right.
                  background: installState.kind === 'downloading'
                    ? `linear-gradient(to right, var(--accent) ${installState.percent}%, color-mix(in srgb, var(--accent) 20%, transparent) ${installState.percent}%)`
                    : 'var(--accent)',
                  borderRadius: 5, color: 'var(--fg-on-accent)', fontFamily: 'inherit',
                  cursor: installBusy(installState) ? 'default' : 'pointer',
                  // `installing` is now only ever the real handover, so the dimming means what
                  // it always claimed to: the app is about to go away.
                  opacity: installState.kind === 'installing' ? 0.6 : 1,
                  fontVariantNumeric: 'tabular-nums',
                  // A percent that changes width would nudge the label on every tick.
                  minWidth: 168, textAlign: 'center',
                  transition: 'background 120ms linear',
                }}
              >
                {installLabel(installState, state.version)}
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

            {/* THE INSTALL'S LINE WINS WHEN IT HAS ONE. Everything else here is a status; the
                failure text is the one line that tells someone what to do next, so it replaces
                them rather than queueing behind them. `installStatus` returns null at rest,
                which is when the check's own words show through unchanged. */}
            <span style={{ fontSize: 11, color: installStatus(installState)?.isError ? 'var(--color-error)' : 'var(--fg-muted)' }}>
              {installStatus(installState)?.text ?? (
                <>
                  {state.kind === 'uptodate' && 'You’re up to date.'}
                  {state.kind === 'available' && `Update ${state.version} available.`}
                  {state.kind === 'error' && 'Couldn’t reach the releases feed.'}
                </>
              )}
            </span>
          </div>
        </section>

        <section style={{ marginBottom: SECTION_GAP }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 2 }}>
            <h3 data-section-header style={sectionHeader}>
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
          <p data-section-desc style={sectionDesc}>
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

        <section style={{ marginBottom: SECTION_GAP }}>
          <h3 data-section-header style={sectionHeader}>
            Dock icon
          </h3>
          <p data-section-desc style={sectionDesc}>
            Pick the app icon that suits your dock. Applies instantly; restored on every launch.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 150px))', gap: 10 }}>
            {(['light', 'dark'] as const).map((v) => (
              <IconCard key={v} variant={v} active={dockIcon === v} onSelect={() => selectDockIcon(v)} />
            ))}
          </div>
        </section>

        <section style={{ marginBottom: SECTION_GAP }}>
          <h3 data-section-header style={sectionHeader}>
            On launch
          </h3>
          {/* The default is OFF and that is the decision, not an oversight: reopening the app
              should not silently start six Claude processes, six worktrees and six dev ports.
              Operator always restores WHERE you were; this is only about whether it also
              restarts the agents, which costs real resources and is one press away regardless. */}
          <p data-section-desc style={sectionDesc}>
            Operator always reopens the project, view and tab you left. This also restarts that
            project’s agents — six lanes means six processes, six worktrees and six dev ports, so
            it is off by default. With it off, they wait for one press.
          </p>
          <button
            onClick={toggleResumeOnLaunch}
            data-resume-on-launch={resumeOnLaunch ? 'on' : 'off'}
            role="switch"
            aria-checked={resumeOnLaunch}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              width: '100%', maxWidth: 320, padding: '10px 12px', cursor: 'pointer',
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>Resume agents on launch</span>
            <span style={{
              position: 'relative', width: 32, height: 18, borderRadius: 999, flexShrink: 0,
              background: resumeOnLaunch ? 'var(--accent)' : 'var(--overlay-medium)',
              transition: 'background 0.15s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: resumeOnLaunch ? 16 : 2, width: 14, height: 14,
                borderRadius: '50%', background: resumeOnLaunch ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
                transition: 'left 0.15s, background 0.15s',
              }} />
            </span>
          </button>
        </section>

        <section style={{ marginBottom: SECTION_GAP }}>
          <h3 data-section-header style={sectionHeader}>
            On quit
          </h3>
          {/* The honest home for "I never want this". The dialog deliberately has NO
              "don't ask again" checkbox: that decision would be made at the moment of maximum
              haste, by the exact person who isn't reading, and it would disarm the guard
              permanently. Same decision, made away from the moment and findable again. */}
          <p data-section-desc style={sectionDesc}>
            Operator asks before quitting while agents are still working, and names the ones it’s
            about to end. It never asks when nothing is running — a question with nothing behind
            it is a question you learn to click through. ⌥⌘Q always skips it.
          </p>
          <button
            onClick={toggleAskBeforeQuit}
            data-ask-before-quit={askBeforeQuit ? 'on' : 'off'}
            role="switch"
            aria-checked={askBeforeQuit}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              width: '100%', maxWidth: 320, padding: '10px 12px', cursor: 'pointer',
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>Ask before quitting with agents running</span>
            <span style={{
              position: 'relative', width: 32, height: 18, borderRadius: 999, flexShrink: 0,
              background: askBeforeQuit ? 'var(--accent)' : 'var(--overlay-medium)',
              transition: 'background 0.15s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: askBeforeQuit ? 16 : 2, width: 14, height: 14,
                borderRadius: '50%', background: askBeforeQuit ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
                transition: 'left 0.15s, background 0.15s',
              }} />
            </span>
          </button>
        </section>

        <section style={{ marginBottom: SECTION_GAP }}>
          <h3 data-section-header style={sectionHeader}>
            Close finished lanes
          </h3>
          {/* Only an explicit `operator__task_status(id,'done')` starts this clock — a lane that
              is merely idle, or waiting on a permission prompt, is never closed by it. Closing
              suspends: the thread and its branch survive, and the next dispatch resumes them. */}
          <p data-section-desc style={sectionDesc}>
            A lane that reports its task done closes after this much quiet, freeing its process and
            its worktree. It is suspended, not forgotten — the next dispatch resumes the same
            conversation on the same branch. A lane waiting on you is never closed.
          </p>
          <div role="radiogroup" aria-label="Keep-warm window" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[0, 5, DEFAULT_KEEP_WARM_MINUTES, 30, 60].map((m) => (
              <button
                key={m}
                onClick={() => selectKeepWarm(m)}
                role="radio"
                aria-checked={keepWarm === m}
                style={{
                  padding: '7px 12px', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 11, fontWeight: 500,
                  color: keepWarm === m ? 'var(--accent)' : 'var(--fg-muted)',
                  background: 'var(--bg-surface)',
                  border: `1px solid ${keepWarm === m ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8,
                }}
              >{m === 0 ? 'Never' : `${m} min`}</button>
            ))}
          </div>
        </section>

        <section style={{ marginBottom: SECTION_GAP }}>
          <h3 data-section-header style={sectionHeader}>
            Sounds
          </h3>
          <p data-section-desc style={sectionDesc}>
            A soft chime when a session finishes its turn and is waiting on you, so you can look away.
          </p>
          <button
            onClick={toggleSounds}
            role="switch"
            aria-checked={sounds}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              width: '100%', maxWidth: 320, padding: '10px 12px', cursor: 'pointer',
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>Your-turn chime</span>
            {/* Pill switch — accent track when on, neutral when off. */}
            <span style={{
              position: 'relative', width: 32, height: 18, borderRadius: 999, flexShrink: 0,
              background: sounds ? 'var(--accent)' : 'var(--overlay-medium)',
              transition: 'background 0.15s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: sounds ? 16 : 2, width: 14, height: 14,
                borderRadius: '50%', background: sounds ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
                transition: 'left 0.15s, background 0.15s',
              }} />
            </span>
          </button>
        </section>

        <section style={{ marginBottom: SECTION_GAP }}>
          <h3 data-section-header style={sectionHeader}>
            Terminal
          </h3>
          <p data-section-desc style={sectionDesc}>
            With the Option key as Meta, ⌥-combos send Esc sequences for shells and editors
            (readline/emacs). Off (default), ⌥ composes characters — ⌥e→é, ⌥3→#, and non-US layouts.
          </p>
          <button
            onClick={toggleOptionIsMeta}
            role="switch"
            aria-checked={optionIsMeta}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              width: '100%', maxWidth: 320, padding: '10px 12px', cursor: 'pointer',
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>Use ⌥ Option as Meta</span>
            <span style={{
              position: 'relative', width: 32, height: 18, borderRadius: 999, flexShrink: 0,
              background: optionIsMeta ? 'var(--accent)' : 'var(--overlay-medium)',
              transition: 'background 0.15s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: optionIsMeta ? 16 : 2, width: 14, height: 14,
                borderRadius: '50%', background: optionIsMeta ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
                transition: 'left 0.15s, background 0.15s',
              }} />
            </span>
          </button>

          {/* Claude Code's TUI renderer. Classic draws each word at an absolute column
              (ESC[<n>G) on rows found by RELATIVE moves, and almost never clears a line —
              so one row of cursor drift leaves the previous row's glyphs showing through
              the gaps between words (the struck-through / colour-spilled rows). Alt-screen
              repaints the whole viewport, so drift can't accumulate — at the cost of the
              native scrollback, which Claude's own scrolling replaces. */}
          <p data-section-desc style={{ ...sectionDesc, margin: '18px 0 12px' }}>
            Fullscreen runs Claude in an alt-screen viewport that repaints whole frames, which
            avoids the overprinting that can garble classic-mode output. The trade-off: no native
            terminal scrollback — you scroll inside Claude instead. Applies to newly-started sessions.
          </p>
          <button
            onClick={toggleFullscreenTui}
            role="switch"
            aria-checked={fullscreenTui}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              width: '100%', maxWidth: 320, padding: '10px 12px', cursor: 'pointer',
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>Fullscreen TUI renderer</span>
            <span style={{
              position: 'relative', width: 32, height: 18, borderRadius: 999, flexShrink: 0,
              background: fullscreenTui ? 'var(--accent)' : 'var(--overlay-medium)',
              transition: 'background 0.15s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: fullscreenTui ? 16 : 2, width: 14, height: 14,
                borderRadius: '50%', background: fullscreenTui ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
                transition: 'left 0.15s, background 0.15s',
              }} />
            </span>
          </button>

        </section>

    </PageShell>
  )
}
