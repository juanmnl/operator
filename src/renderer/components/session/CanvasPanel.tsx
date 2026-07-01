import { useEffect, useState } from 'react'
import type { AgentSession } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { ConversationPanel } from './ConversationPanel'
import { AppPreviewPanel } from './AppPreviewPanel'
import { PlanPanel } from './PlanPanel'
import { CanvasDiffPanel } from './CanvasDiffPanel'

// The right-side Canvas: one switchable surface beside the terminal. Hosts the
// agent's answers (Chat), its live plan (Plan), the working-tree diff (Diff),
// and a preview of the running app (Preview). The active surface is owned per
// session by DashboardView (so each session keeps its own tab).
type CanvasMode = 'chat' | 'plan' | 'diff' | 'preview'

const MODES: { id: CanvasMode; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'plan', label: 'Plan' },
  { id: 'diff', label: 'Diff' },
  { id: 'preview', label: 'Preview' },
]

// The user's Plan-tab tasks live here (not in PlanPanel) so the "Send to agent"
// action can sit in the shared actions footer below. Persisted per session.
const todosKey = (id?: string) => `operator.plan.userTodos.${id ?? 'none'}`
function loadUserTodos(id?: string): string[] {
  try { const r = localStorage.getItem(todosKey(id)); return r ? JSON.parse(r) : [] } catch { return [] }
}

export function CanvasPanel({ session, devUrl, devUrlReserved, mode, onSelectMode }: {
  session?: AgentSession
  devUrl: string | null
  devUrlReserved?: boolean
  mode: CanvasMode
  onSelectMode: (m: CanvasMode) => void
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
      </DragRegion>
      <div style={{ flex: 1, minHeight: 0 }}>
        {mode === 'chat' && <ConversationPanel session={session} />}
        {mode === 'plan' && (
          <PlanPanel
            session={session}
            userTodos={userTodos}
            onAdd={(t) => persistTodos([...userTodos, t])}
            onRemove={(i) => persistTodos(userTodos.filter((_, j) => j !== i))}
          />
        )}
        {mode === 'diff' && <CanvasDiffPanel path={session?.workingDirectory} />}
        {mode === 'preview' && <AppPreviewPanel url={devUrl} storageKey={session?.id} />}
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
          {mode === 'preview' && devUrl && !devUrlReserved && (
            <button className="actions-footer-btn" onClick={() => window.operator.openExternal?.(devUrl)} title="Open in browser">
              Open ↗
            </button>
          )}
          {mode === 'chat' && (session?.messages?.some((m) => m.kind === 'text')) && (
            <span className="actions-footer-label">
              {session!.messages!.filter((m) => m.kind === 'text').length} answers
            </span>
          )}
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
