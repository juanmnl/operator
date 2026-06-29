import type { AgentSession, TodoItem } from '../../../shared/types'

// The agent's plan: its latest TodoWrite snapshot rendered as a live checklist
// (transcript-driven, updates ~1s) so you can watch progress tick off. Status
// shown with colour-for-meaning only (no fills) — in_progress accent, completed
// muted+struck, pending plain.
export function PlanPanel({ session }: { session?: AgentSession }) {
  const todos = session?.todos ?? []
  const done = todos.filter((t) => t.status === 'completed').length

  if (todos.length === 0) {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 6, padding: 24, textAlign: 'center', fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        <span style={{ fontSize: 12, color: 'var(--fg)' }}>No plan yet</span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.7, maxWidth: 280, lineHeight: 1.5 }}>
          When the agent writes a todo list, it’ll appear here and update as it works.
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px', borderBottom: '1px solid var(--border)',
        fontSize: 11, color: 'var(--fg-muted)',
      }}>
        <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>{done}/{todos.length} done</span>
        {/* Slim progress bar — border-bounded, accent fill is a meaning indicator. */}
        <span style={{ marginLeft: 'auto', width: 90, height: 4, borderRadius: 2, background: 'var(--overlay-subtle)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${todos.length ? (done / todos.length) * 100 : 0}%`, background: 'var(--accent)', transition: 'width 0.2s' }} />
        </span>
      </div>
      <div className="scroll-hidden" style={{ flex: 1, overflow: 'auto', padding: '10px 12px 20px' }}>
        {todos.map((t, i) => <TodoRow key={i} todo={t} />)}
      </div>
    </div>
  )
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const done = todo.status === 'completed'
  const active = todo.status === 'in_progress'
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '5px 4px', lineHeight: 1.45 }}>
      <span style={{
        flexShrink: 0, marginTop: 1, width: 14, textAlign: 'center', fontSize: 12,
        color: done ? 'var(--color-success, var(--fg-muted))' : active ? 'var(--accent)' : 'var(--fg-muted)',
      }}>
        {done ? '✓' : active ? '▸' : '○'}
      </span>
      <span style={{
        fontSize: 12.5, flex: 1,
        color: done ? 'var(--fg-muted)' : 'var(--fg)',
        opacity: done ? 0.6 : 1,
        textDecoration: done ? 'line-through' : 'none',
        fontWeight: active ? 600 : 400,
      }}>
        {todo.content}
      </span>
    </div>
  )
}
