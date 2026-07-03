import { useLayoutEffect, useRef, useState } from 'react'
import type { Project, Role, ProjectTask } from '../../../shared/types'

// The project's task backlog. Add tasks (the input grows vertically as you type), optionally
// assign each to an agent lane, then dispatch them: individually (Send →), all at once
// (Start all →), or leave them queued for an agent to pick up when it launches. Assignment +
// queue live in the Project (projects.json) via the callbacks from DashboardView.

const MAX_H = 160

export function TaskQueue({ project, roles, liveRoles, onAddTask, onAssignTask, onRemoveTask, onSendTask, onStartAll }: {
  project: Project
  roles: Role[]
  liveRoles?: Record<string, string>
  onAddTask: (text: string, roleId?: string) => void
  onAssignTask: (taskId: string, roleId?: string) => void
  onRemoveTask: (taskId: string) => void
  onSendTask: (task: ProjectTask) => void
  onStartAll: () => void
}) {
  const [draft, setDraft] = useState('')
  const [assignee, setAssignee] = useState('') // '' = unassigned
  const taRef = useRef<HTMLTextAreaElement>(null)
  const tasks = project.tasks ?? []
  const assignedQueued = tasks.filter((t) => t.roleId).length

  // Grow the input vertically with its content, up to a cap (then scroll).
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden'
  }, [draft])

  const add = () => { if (draft.trim()) { onAddTask(draft, assignee || undefined); setDraft('') } }
  const roleOf = (id?: string) => roles.find((r) => r.id === id)

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 16, fontFamily: 'var(--font-body)' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          Tasks{tasks.length ? ` · ${tasks.length}` : ''}
        </span>
        {assignedQueued > 0 && (
          <button
            onClick={onStartAll}
            className="actions-footer-btn is-primary"
            style={{ marginLeft: 'auto', fontSize: 10.5, padding: '3px 10px' }}
            title="Dispatch every assigned task to its agent (launching lanes as needed)"
          >
            Start all →
          </button>
        )}
      </div>

      {/* Add-task input: grows vertically; Enter adds, Shift+Enter for a newline. */}
      <div style={{ borderRadius: 12, background: 'var(--overlay-subtle)', border: '1px solid var(--border)', padding: '2px 2px 6px' }}>
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() } }}
          placeholder="Add a task…"
          rows={1}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'none', overflowY: 'hidden',
            fontFamily: 'var(--font-body)', fontSize: 12.5, lineHeight: 1.45,
            background: 'transparent', color: 'var(--fg)', border: 'none', outline: 'none',
            padding: '8px 10px 2px', margin: 0,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px' }}>
          <AssigneeSelect roles={roles} value={assignee} onChange={setAssignee} liveRoles={liveRoles} placeholder="Unassigned" />
          <button
            onClick={add}
            disabled={!draft.trim()}
            className="actions-footer-btn"
            style={{ marginLeft: 'auto', fontSize: 10.5, padding: '3px 12px', opacity: draft.trim() ? 1 : 0.4 }}
          >
            Add
          </button>
        </div>
      </div>

      {/* Queue. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {tasks.map((task) => {
          const role = roleOf(task.roleId)
          return (
            <div key={task.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 9px', background: 'var(--overlay-subtle)' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.4, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {task.text}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <AssigneeSelect
                  roles={roles}
                  value={task.roleId ?? ''}
                  onChange={(id) => onAssignTask(task.id, id || undefined)}
                  liveRoles={liveRoles}
                  placeholder="Assign…"
                  compact
                />
                <button
                  onClick={() => onSendTask(task)}
                  disabled={!role}
                  title={role ? `Send to ${role.name}` : 'Assign an agent first'}
                  style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 8px', borderRadius: 6,
                    border: '1px solid var(--border)', background: 'transparent', cursor: role ? 'pointer' : 'default',
                    color: role ? 'var(--accent)' : 'var(--fg-muted)', opacity: role ? 1 : 0.5, outline: 'none',
                  }}
                >
                  Send →
                </button>
                <button
                  onClick={() => onRemoveTask(task.id)}
                  title="Delete task"
                  style={{ width: 20, height: 20, padding: 0, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none', fontSize: 12 }}
                >✕</button>
              </div>
            </div>
          )
        })}
        {tasks.length === 0 && (
          <p style={{ fontSize: 10.5, color: 'var(--fg-muted)', textAlign: 'center', padding: '4px 0', opacity: 0.7 }}>
            No tasks yet. Add one above and assign it to an agent — or leave it for an agent to pick up.
          </p>
        )}
      </div>
    </div>
  )
}

// A small lane picker: a coloured dot + the role name, backed by a native select (reliable,
// keyboard-accessible). A live lane's dot is filled; an idle one is hollow (border only).
function AssigneeSelect({ roles, value, onChange, liveRoles, placeholder, compact }: {
  roles: Role[]
  value: string
  onChange: (roleId: string) => void
  liveRoles?: Record<string, string>
  placeholder: string
  compact?: boolean
}) {
  const role = roles.find((r) => r.id === value)
  const live = value ? !!liveRoles?.[value] : false
  const accent = role?.accent || 'var(--accent)'
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 5, padding: compact ? '2px 6px' : '3px 8px', borderRadius: 7, border: '1px solid var(--border)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: value ? (live ? accent : 'transparent') : 'transparent', border: `1px solid ${value ? accent : 'var(--fg-muted)'}` }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: compact ? 9.5 : 10, color: role ? 'var(--fg)' : 'var(--fg-muted)', maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {role ? role.name : placeholder}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
      >
        <option value="">Unassigned</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>{r.name}{liveRoles?.[r.id] ? ' · live' : ''}</option>
        ))}
      </select>
    </span>
  )
}
