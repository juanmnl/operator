import { useEffect, useState, type ReactNode } from 'react'
import type { AgentSession, Role } from '../../../shared/types'
import { DragRegion } from '../DragRegion'
import { PlanPanel } from './PlanPanel'
import { CanvasDiffPanel } from './CanvasDiffPanel'
import { CanvasConversation } from './CanvasConversation'
import { submitQueue } from '../../lib/submit-queue'
import { TOOLBAR_BAND_H } from '../../lib/chrome'

// The right-side panel — the per-session "working" surfaces beside the main area. Its tab set
// is CONTEXTUAL to the main view (passed in as `tabs`): Plan + Diff always, plus Chat when the
// main view is Console or Preview (so you can watch the terminal/preview AND read the
// conversation). Project-level surfaces (Agents roster, Moodboard) live in the ProjectView, not
// here. The active tab is owned per session by DashboardView.
type PanelTab = 'plan' | 'diff' | 'chat' | 'files' | 'inbox'

const LABELS: Record<PanelTab, string> = { plan: 'Plan', diff: 'Diff', chat: 'Chat', files: 'Files', inbox: 'Inbox' }

// The user's Plan-tab tasks live here (not in PlanPanel) so the "Send to agent"
// action can sit in the shared actions footer below. Persisted per session.
const todosKey = (id?: string) => `operator.plan.userTodos.${id ?? 'none'}`
function loadUserTodos(id?: string): string[] {
  try { const r = localStorage.getItem(todosKey(id)); return r ? JSON.parse(r) : [] } catch { return [] }
}

export function CanvasPanel({ session, role, customName, accent, tabs, mode, onSelectMode, onHumanSend, onModelChange, onEffortChange, filesTab, inboxTab }: {
  session?: AgentSession
  /** Lane identity for the Chat tab — the same name and colour the sidebar gives it. */
  role?: Role
  customName?: string
  accent?: string
  tabs: PanelTab[]
  mode: PanelTab
  onSelectMode: (m: PanelTab) => void
  /** A human addressed this lane — resets its delivery hop budget. See ChatComposer. */
  onHumanSend?: (roleId?: string) => void
  onModelChange?: (model: string) => void
  onEffortChange?: (effort: 'high' | 'normal' | 'low') => void
  /** PLACEMENT B of the code navigator. Rendered by the caller so the nav state — which is per
   *  SESSION and shared with the main-view placement — lives in one place rather than being
   *  duplicated on both sides of the layout. */
  filesTab?: ReactNode
  /** The lane's Inbox/Outbox. Rendered by the caller because it reads the PROJECT's dispatch log
   *  as well as the report store, and this component knows about neither. */
  inboxTab?: ReactNode
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
    // the agent instead of a cramped single line. Goes through the submit queue so it
    // can't merge with a dispatch landing on the same lane (see lib/submit-queue).
    const body = userTodos.map((t, i) => `${i + 1}. ${t}`).join('\n')
    const prompt = `Please work through these tasks:\n${body}`
    void submitQueue.submit(session.terminalId, prompt)
    persistTodos([]) // handed off to the agent
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      {/* Mode switcher — text tabs, accent colour for the active one, no fills. */}
      {/* `TOOLBAR_BAND_H`, from lib/chrome — so this rule and the main panel's land on ONE y
          when the right panel is open. It used to be a literal 36 under a comment claiming it was
          "the same 36px height as the main panel's SessionToolbar"; the toolbar had become 44 and
          the comment was never updated, so the file asserted an agreement that had stopped
          holding — which is why nobody caught two rules 8px apart by reading. */}
      <DragRegion data-toolbar-header="panel" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, height: TOOLBAR_BAND_H, padding: '0 10px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)' }}>
        {tabs.map((id) => (
          <button
            key={id}
            onClick={() => select(id)}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
              textTransform: 'uppercase', letterSpacing: '0.14em', cursor: 'pointer', outline: 'none',
              padding: '2px 9px', borderRadius: 6, border: 'none', background: 'transparent',
              color: mode === id ? 'var(--accent)' : 'var(--fg-muted)',
            }}
          >
            {LABELS[id]}
            {id === 'plan' && (session?.todos?.length ?? 0) > 0
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
        {mode === 'chat' && <CanvasConversation session={session} role={role} customName={customName} accent={accent} onHumanSend={onHumanSend} onModelChange={onModelChange} onEffortChange={onEffortChange} />}
        {mode === 'files' && filesTab}
        {mode === 'inbox' && inboxTab}
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
