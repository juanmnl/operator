import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DiffBody } from '../src/renderer/components/session/DiffBody'
import type { WorktreeDiff } from '../src/shared/types'
import { applyTheme, themes, identities, themeKey, ThemeMode } from '../src/renderer/themes'
import '../src/renderer/styles.css'
import REAL from '../src/renderer/components/session/__fixtures__/real-git.diff?raw'

// DEV-ONLY diff harness. Mounts the REAL <DiffBody> — which after move 04 is the only diff
// renderer in the app (DiffPanel, CanvasDiffPanel and TaskDiffCard all go through it) — against
// the same real `git diff` fixture the parser test uses. Never bundled into the shipped app.
//
// It exists to measure `--add-fg` / `--del-fg` / `--add-bg` / `--del-bg` as PAINTED PIXELS in
// every palette, in all four places a diff ink appears: the summary bar's totals, a file
// header's per-file counts, an added row, and a removed row.
//
// The two backdrops matter and are both offered: `--bg-terminal` is what TaskDiffCard and the
// Review panel put behind the diff; `--bg-surface` is the file header's own background.

// The fixture's `files` list, matching the real diff above — same paths, and the same porcelain
// status codes git actually reported for them (`R ` for the renames, `A ` for the new file).
const DIFF: WorktreeDiff = {
  branch: 'operator/ded278',
  diff: REAL,
  files: [
    { path: 'bin.dat', status: 'M ', added: 1, removed: 1 },
    { path: 'mode.sh', status: 'M ', added: 0, removed: 0 },
    { path: 'my file.ts', status: 'M ', added: 1, removed: 1 },
    { path: 'nonewline.txt', status: 'M ', added: 1, removed: 1 },
    { path: 'plain.ts', status: 'M ', added: 2, removed: 1 },
    { path: 'renamed with space 2.ts', status: 'R ', added: 0, removed: 0 },
    { path: 'renamed.ts', status: 'R ', added: 0, removed: 0 },
    { path: 'untracked.ts', status: 'A ', added: 1, removed: 0 },
    { path: 'edge.md', status: 'M ', added: 1, removed: 1 },
  ],
}

const EMPTY: WorktreeDiff = { branch: 'operator/ded278', diff: '', files: [] }

function Harness() {
  const [identity, setIdentity] = useState('mission-control')
  const [mode, setMode] = useState<ThemeMode>('dark')
  const [surface, setSurface] = useState<'terminal' | 'surface'>('terminal')
  const [empty, setEmpty] = useState(false)
  // Re-apply the palette, then optionally stamp the PRE-move-04 shared pair back on top, so the
  // driver can measure before and after with the identical painted-pixel method instead of
  // comparing a measurement against an analytic estimate.
  const [legacy, setLegacy] = useState(false)

  const apply = (id: string, m: ThemeMode, lgc = legacy) => {
    setIdentity(id); setMode(m); setLegacy(lgc)
    applyTheme(themes[themeKey(id, m)])
    if (lgc) {
      // The one hardcoded pair every palette shared before move 04 (styles.css :root).
      const r = document.documentElement.style
      r.setProperty('--add-fg', '#4ec9a0')
      r.setProperty('--del-fg', '#e2686b')
      r.setProperty('--add-bg', 'color-mix(in srgb, #4ec9a0 15%, transparent)')
      r.setProperty('--del-bg', 'color-mix(in srgb, #e2686b 14%, transparent)')
    }
  }

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 10.5, cursor: 'pointer',
    borderRadius: 'var(--radius-sm)', outline: 'none',
    background: active ? 'var(--overlay-medium)' : 'var(--btn-bg)',
    color: active ? 'var(--fg)' : 'var(--fg-muted)',
    border: '1px solid var(--border)',
  })

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-terminal)', color: 'var(--fg)', fontFamily: 'var(--font-body)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {identities.map((idn) => (
          <button key={idn.id} data-theme-btn={idn.id} style={chip(identity === idn.id)} onClick={() => apply(idn.id, mode)}>{idn.name}</button>
        ))}
        <span style={{ width: 10 }} />
        {(['dark', 'light'] as ThemeMode[]).map((m) => (
          <button key={m} data-mode-btn={m} style={chip(mode === m)} onClick={() => apply(identity, m)}>{m}</button>
        ))}
        <span style={{ width: 10 }} />
        {(['terminal', 'surface'] as const).map((s) => (
          <button key={s} data-surface-btn={s} style={chip(surface === s)} onClick={() => setSurface(s)}>bg-{s}</button>
        ))}
        <span style={{ width: 10 }} />
        <button data-empty-btn style={chip(empty)} onClick={() => setEmpty((v) => !v)}>empty</button>
        <button data-legacy-btn style={chip(legacy)} onClick={() => apply(identity, mode, !legacy)}>pre-04 tokens</button>
      </div>
      <div
        data-diff-host
        style={{
          flex: 1, minHeight: 0,
          background: surface === 'terminal' ? 'var(--bg-terminal)' : 'var(--bg-surface)',
        }}
      >
        <DiffBody diff={empty ? EMPTY : DIFF} />
      </div>
    </div>
  )
}

applyTheme(themes['mission-control-dark'])
createRoot(document.getElementById('root')!).render(<Harness />)
