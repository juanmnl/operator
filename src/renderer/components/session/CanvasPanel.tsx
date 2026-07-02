import { useEffect, useState } from 'react'
import type { AgentSession } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { PlanPanel } from './PlanPanel'
import { CanvasDiffPanel } from './CanvasDiffPanel'

// The right-side panel: the "working" surfaces beside the main area — the agent's live plan
// (Plan) and the working-tree diff (Diff). Chat and Preview live in the MAIN view now
// (Console ⇄ Chat ⇄ Preview toggle), not here. The active tab is owned per session by
// DashboardView.
type PanelTab = 'plan' | 'diff'

const MODES: { id: PanelTab; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'diff', label: 'Diff' },
]

// The user's Plan-tab tasks live here (not in PlanPanel) so the "Send to agent"
// action can sit in the shared actions footer below. Persisted per session.
const todosKey = (id?: string) => `operator.plan.userTodos.${id ?? 'none'}`
function loadUserTodos(id?: string): string[] {
  try { const r = localStorage.getItem(todosKey(id)); return r ? JSON.parse(r) : [] } catch { return [] }
}

export function CanvasPanel({ session, mode, onSelectMode }: {
  session?: AgentSession
  mode: PanelTab
  onSelectMode: (m: PanelTab) => void
}) {
  const select = onSelectMode

  const [userTodos, setUserTodos] = useState<string[]>(() => loadUserTodos(session?.id))
  useEffect(() => { setUserTodos(loadUserTodos(session?.id)) }, [session?.id])
  const persistTodos = (next: string[]) => {
    setUserTodos(next)
    try { localStorage.setItem(todosKey(session?.id), JSON.stringify(next)) } catch { /* quota */ }
  }
  const canSend = userTodos.length > 0 && !!session?.terminalId
  const sendTodos = () => {
    if (!canSend || !session?.terminalId) return
    // Bracketed paste keeps the multi-line list from submitting line-by-line; the
    // trailing CR (outside the paste) submits it as one message. Reads cleanly for
    // the agent instead of a cramped single line.
    const body = userTodos.map((t, i) => `${i + 1}. ${t}`).join('\n')
    const prompt = `Please work through these tasks:\n${body}`
    window.operator.terminalWrite(session.terminalId, `\x1b[200~${prompt}\x1b[201~\r`)
    persistTodos([]) // handed off to the agent
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      {/* Mode switcher — text tabs, accent colour for the active one, no fills. */}
      {/* Same 36px height + centered content as the main panel's SessionToolbar,
          so the tabs sit on exactly the same line as the toolbar title/icons. */}
      <DragRegion style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, height: 36, padding: '0 10px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)' }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => select(m.id)}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
              textTransform: 'uppercase', letterSpacing: '0.14em', cursor: 'pointer', outline: 'none',
              padding: '2px 9px', borderRadius: 6, border: 'none', background: 'transparent',
              color: mode === m.id ? 'var(--accent)' : 'var(--fg-muted)',
            }}
          >
            {m.label}
            {m.id === 'plan' && (session?.todos?.length ?? 0) > 0
              ? ` ${session!.todos!.filter((t) => t.status === 'completed').length}/${session!.todos!.length}`
              : ''}
          </button>
        ))}
      </DragRegion>
      <div style={{ flex: 1, minHeight: 0 }}>
        {mode === 'plan' && (
          <PlanPanel
            session={session}
            userTodos={userTodos}
            onAdd={(t) => persistTodos([...userTodos, t])}
            onRemove={(i) => persistTodos(userTodos.filter((_, j) => j !== i))}
          />
        )}
        {mode === 'diff' && <CanvasDiffPanel path={session?.workingDirectory} />}
      </div>

      {/* Canvas actions footer — primary action on the left; contextual info + the
          surface label on the right. */}
      <div className="actions-footer">
        {mode === 'plan' && userTodos.length > 0 && (
          <button
            className="actions-footer-btn is-primary"
            onClick={sendTodos}
            disabled={!session?.terminalId}
            title={session?.terminalId ? 'Send your tasks to the agent’s terminal' : 'No live session to send to'}
          >
            Send {userTodos.length} to agent →
          </button>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {mode === 'plan' && (session?.todos?.length ?? 0) > 0 && (
            <span className="actions-footer-label">
              {session!.todos!.filter((t) => t.status === 'completed').length}/{session!.todos!.length} done
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
