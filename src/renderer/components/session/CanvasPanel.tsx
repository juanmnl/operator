import { useState } from 'react'
import type { AgentSession } from '../../../shared/types'
import { ConversationPanel } from './ConversationPanel'
import { AppPreviewPanel } from './AppPreviewPanel'
import { PlanPanel } from './PlanPanel'
import { CanvasDiffPanel } from './CanvasDiffPanel'

// The right-side Canvas: one switchable surface beside the terminal. Hosts the
// agent's answers (Chat), its live plan (Plan), the working-tree diff (Diff),
// and a preview of the running app (Preview).
type CanvasMode = 'chat' | 'plan' | 'diff' | 'preview'
const MODE_KEY = 'operator.canvasMode'
const MODE_IDS: CanvasMode[] = ['chat', 'plan', 'diff', 'preview']

const MODES: { id: CanvasMode; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'plan', label: 'Plan' },
  { id: 'diff', label: 'Diff' },
  { id: 'preview', label: 'Preview' },
]

export function CanvasPanel({ session, devUrl, devUrlReserved }: { session?: AgentSession; devUrl: string | null; devUrlReserved?: boolean }) {
  const [mode, setMode] = useState<CanvasMode>(() => {
    try {
      const m = localStorage.getItem(MODE_KEY) as CanvasMode
      return MODE_IDS.includes(m) ? m : 'chat'
    } catch { return 'chat' }
  })
  const select = (m: CanvasMode) => {
    setMode(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* ignore */ }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      {/* Mode switcher — text tabs, accent colour for the active one, no fills. */}
      {/* Same 36px height + centered content as the main panel's SessionToolbar,
          so the tabs sit on exactly the same line as the toolbar title/icons. */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, height: 36, padding: '0 10px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)' }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => select(m.id)}
            style={{
              fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, fontWeight: 600,
              letterSpacing: 0.2, cursor: 'pointer', outline: 'none',
              padding: '2px 9px', borderRadius: 6, border: 'none', background: 'transparent',
              color: mode === m.id ? 'var(--accent)' : 'var(--fg-muted)',
            }}
          >
            {m.label}
            {/* Live dot ONLY when a dev server is actually detected/serving — not for
                the merely-reserved port (devUrlReserved), which serves nothing yet. */}
            {m.id === 'preview' && devUrl && !devUrlReserved ? ' ●' : ''}
            {m.id === 'plan' && (session?.todos?.length ?? 0) > 0
              ? ` ${session!.todos!.filter((t) => t.status === 'completed').length}/${session!.todos!.length}`
              : ''}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {mode === 'chat' && <ConversationPanel session={session} />}
        {mode === 'plan' && <PlanPanel session={session} />}
        {mode === 'diff' && <CanvasDiffPanel path={session?.workingDirectory} />}
        {mode === 'preview' && <AppPreviewPanel url={devUrl} reserved={devUrlReserved} />}
      </div>
    </div>
  )
}
