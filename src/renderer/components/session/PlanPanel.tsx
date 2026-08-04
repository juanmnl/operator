import { useState } from 'react'
import type { AgentSession, TodoItem } from '../../../shared/types'
import { PANEL_SUBHEAD_H } from '../../lib/chrome'

// The Plan tab. Top (read-only): the agent's latest TodoWrite snapshot as a live
// checklist. Below it (writable): YOUR tasks — jot them down here; the "Send to agent"
// action lives in the Canvas actions footer (owned by CanvasPanel), which injects them
// into the session's terminal as a prompt for the agent to pick up. Operator's first
// structured-INPUT surface, riding the existing terminal-as-stdin channel.
export function PlanPanel({ session, userTodos, onAdd, onRemove }: {
  session?: AgentSession
  userTodos: string[]
  onAdd: (text: string) => void
  onRemove: (index: number) => void
}) {
  const agentTodos = session?.todos ?? []
  const done = agentTodos.filter((t) => t.status === 'completed').length

  const [draft, setDraft] = useState('')
  const add = () => {
    const t = draft.trim()
    if (!t) return
    onAdd(t)
    setDraft('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontFamily: "var(--font-body)" }}>
      {/* Agent plan header — only when the agent has written one. */}
      {agentTodos.length > 0 && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
          height: PANEL_SUBHEAD_H, padding: '0 14px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)',
        }}>
          <span style={{ textTransform: 'uppercase', letterSpacing: '0.14em' }}>plan · <b style={{ color: 'var(--accent)', fontWeight: 700 }}>{done}</b>/{agentTodos.length}</span>
          {/* One vertical pill per task: filled = done, mid = in progress, faint = pending. */}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 3, maxWidth: 190, overflow: 'hidden' }}>
            {agentTodos.map((t, i) => (
              <span
                key={i}
                title={`${t.content} — ${t.status.replace('_', ' ')}`}
                style={{
                  width: 5, height: 12, borderRadius: 3, flexShrink: 0, transition: 'background 0.2s',
                  background: t.status === 'completed'
                    ? 'var(--accent)'
                    : t.status === 'in_progress'
                      ? 'color-mix(in srgb, var(--accent) 55%, var(--overlay-subtle))'
                      : 'var(--overlay-subtle)',
                }}
              />
            ))}
          </span>
        </div>
      )}

      <div className="scroll-hidden" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '12px 12px 16px' }}>
        {agentTodos.map((t, i) => <TodoRow key={`a${i}`} todo={t} />)}

        <div style={{
          marginTop: agentTodos.length ? 16 : 0,
          paddingTop: agentTodos.length ? 12 : 0,
          borderTop: agentTodos.length ? '1px solid var(--border)' : 'none',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.3, color: 'var(--fg-muted)', padding: '0 2px 8px' }}>
            YOUR TASKS
          </div>

          {/* Add-a-task input, right under the heading. */}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            placeholder="Add a task, press ↵"
            style={{
              fontFamily: 'inherit', fontSize: 12.5, width: '100%', boxSizing: 'border-box', marginBottom: 8,
              background: 'var(--overlay-subtle)', color: 'var(--fg)', outline: 'none',
              border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px',
            }}
          />

          {userTodos.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', padding: '2px 2px', lineHeight: 1.5 }}>
              List what you want done — then “Send to agent” hands them to the session.
            </div>
          ) : (
            userTodos.map((t, i) => (
              <div key={`u${i}`} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '5px 2px', lineHeight: 1.45 }}>
                <span style={{ flexShrink: 0, marginTop: 1, width: 14, textAlign: 'center', fontSize: 12, color: 'var(--fg-muted)' }}>◦</span>
                <span style={{ fontSize: 12.5, flex: 1, color: 'var(--fg)' }}>{t}</span>
                <button
                  onClick={() => onRemove(i)}
                  title="Remove"
                  style={{ flexShrink: 0, background: 'none', border: 'none', outline: 'none', cursor: 'pointer', color: 'var(--fg-muted)', fontSize: 12, padding: 0, lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
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
        color: done ? 'var(--add-fg)' : active ? 'var(--accent)' : 'var(--fg-muted)',
      }}>
        {done ? '✓' : active ? '▸' : '○'}
      </span>
      <span style={{
        fontSize: 12.5, flex: 1,
        color: done ? 'var(--fg-muted)' : 'var(--fg)',
        
        textDecoration: done ? 'line-through' : 'none',
        fontWeight: active ? 600 : 400,
      }}>
        {todo.content}
      </span>
    </div>
  )
}
