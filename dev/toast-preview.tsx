import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Toasts, ToastMessage } from '../src/renderer/components/Toast'
import { applyTheme, themes, identities, themeKey, ThemeMode } from '../src/renderer/themes'
import '../src/renderer/styles.css'

// DEV-ONLY toast harness. Mounts the REAL <Toasts> component (not a copy) so what
// you see here is exactly what ships. Three things QA wanted kept permanently:
//   1. theme switcher — every identity × light/dark, applied via the real applyTheme.
//   2. realistic samples — the actual toast shapes Operator emits (dispatch, error,
//      update-with-action, agent-done-with-onClick, long mono detail line).
//   3. toolbar-offset check — a faithful 36px SessionToolbar strip so you can verify
//      the top:52 toasts clear it with the intended 16px gap.

let seq = 0
const nextId = () => `t${seq++}`

// The realistic sample set. Each returns a fresh message (fresh id) on click so
// you can stack them and watch enter/leave + auto-dismiss behaviour.
const SAMPLES: { label: string; make: () => ToastMessage }[] = [
  {
    label: 'info',
    make: () => ({ id: nextId(), kind: 'info', text: 'Dispatched to Research' }),
  },
  {
    label: 'success + detail',
    make: () => ({
      id: nextId(), kind: 'success',
      text: 'Worktree created',
      detail: '~/Developer/operator/.worktrees/feat-toast-preview',
    }),
  },
  {
    label: 'error + detail',
    make: () => ({
      id: nextId(), kind: 'error',
      text: 'Session failed to spawn',
      detail: 'zsh: command not found: claude',
    }),
  },
  {
    label: 'action (sticky)',
    make: () => ({
      id: nextId(), kind: 'info',
      text: 'Update available — v0.9.1',
      detail: 'Restart to install the downloaded update.',
      action: { label: 'Restart', run: () => console.log('restart clicked') },
    }),
  },
  {
    label: 'clickable',
    make: () => ({
      id: nextId(), kind: 'success',
      text: 'Code finished its turn',
      detail: 'Opus · feat-toast-preview',
      onClick: () => console.log('focus session clicked'),
    }),
  },
  {
    label: 'long text',
    make: () => ({
      id: nextId(), kind: 'error',
      text: 'The agent orphaned a child process and Operator had to reap it to keep the lane responsive',
      detail: 'pid 73126 · SIGTERM',
    }),
  },
]

// The pile-up that motivated coalescing + Dismiss all: an undelivered-dispatch
// burst is N BYTE-IDENTICAL sentences whose Show buttons each target a different
// terminal. Spawned as a set so the stack reproduces in one click.
const BURSTS: { label: string; make: () => ToastMessage[] }[] = [
  {
    label: 'burst: 4× identical + 1',
    make: () => [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: nextId(), kind: 'error' as const,
        text: 'Operator never started the task it was sent',
        detail: 'It may still be sitting in its composer.',
        action: { label: 'Show', run: () => console.log('show operator', i) },
      })),
      {
        id: nextId(), kind: 'error' as const,
        text: 'Code never started the task it was sent',
        detail: 'It may still be sitting in its composer.',
        action: { label: 'Show', run: () => console.log('show code') },
      },
    ],
  },
  {
    label: 'burst: 7 distinct (overflow cap)',
    make: () => Array.from({ length: 7 }, (_, i) => ({
      id: nextId(), kind: (['info', 'success', 'error'] as const)[i % 3],
      text: `Lane ${i + 1} never started the task it was sent`,
      detail: 'It may still be sitting in its composer.',
      action: { label: 'Show', run: () => console.log('show', i) },
    })),
  },
]

function Harness() {
  const [messages, setMessages] = useState<ToastMessage[]>([])
  const [identity, setIdentity] = useState('mission-control')
  const [mode, setMode] = useState<ThemeMode>('dark')

  const apply = (id: string, m: ThemeMode) => {
    setIdentity(id); setMode(m)
    applyTheme(themes[themeKey(id, m)])
  }

  const spawn = (make: () => ToastMessage) => setMessages((prev) => [...prev, make()])
  const dismiss = (id: string) => setMessages((prev) => prev.filter((m) => m.id !== id))

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '5px 11px', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
    borderRadius: 'var(--radius-sm)', outline: 'none',
    background: active ? 'var(--overlay-medium)' : 'var(--btn-bg)',
    color: active ? 'var(--fg)' : 'var(--fg-muted)',
    border: '1px solid var(--border)',
  })

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg-terminal)', color: 'var(--fg)',
      fontFamily: 'var(--font-body)',
    }}>
      {/* Faithful SessionToolbar strip — same 36px height + bottom border as the
          real one (SessionToolbar.tsx). The toasts render at top:52, so the visible
          gap below this strip is the offset clearance QA wants to confirm. */}
      <div style={{
        height: 36, boxSizing: 'border-box', padding: '0 12px',
        display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-body)',
      }}>
        <span style={{ fontSize: 12.5, fontWeight: 550, color: 'var(--fg)' }}>Operator</span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>— toolbar strip (36px) · toasts must clear it</span>
      </div>

      {/* Controls, pushed well below the toast landing zone so they don't collide. */}
      <div style={{ padding: '110px 20px 20px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 620 }}>
        <div>
          <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--fg-muted)', marginBottom: 8 }}>Theme</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {identities.map((idn) => (
              <button key={idn.id} style={chip(identity === idn.id)} onClick={() => apply(idn.id, mode)}>{idn.name}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['dark', 'light'] as ThemeMode[]).map((m) => (
              <button key={m} style={chip(mode === m)} onClick={() => apply(identity, m)}>{m}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--fg-muted)', marginBottom: 8 }}>Samples</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SAMPLES.map((s) => (
              <button key={s.label} style={chip(false)} onClick={() => spawn(s.make)}>{s.label}</button>
            ))}
            {BURSTS.map((b) => (
              <button key={b.label} style={chip(false)} onClick={() => setMessages((prev) => [...prev, ...b.make()])}>{b.label}</button>
            ))}
            <button style={chip(false)} onClick={() => setMessages([])}>clear</button>
          </div>
        </div>
      </div>

      <Toasts
        messages={messages}
        onDismiss={dismiss}
        onDismissAll={(ids) => setMessages((prev) => prev.filter((m) => !ids.includes(m.id)))}
      />
    </div>
  )
}

applyTheme(themes['mission-control-dark'])
createRoot(document.getElementById('root')!).render(<Harness />)
