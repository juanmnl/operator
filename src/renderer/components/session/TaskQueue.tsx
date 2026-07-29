import { useLayoutEffect, useRef, useState } from 'react'
import type { Project, Role, ProjectTask } from '../../../shared/types'
import { taskHasDiffSource } from '../../lib/task-diff'
import { TaskDiffCard } from './TaskDiffCard'

// The project's task backlog. Add tasks (the input grows vertically as you type), optionally
// assign each to an agent lane, then dispatch them: individually (Send →), all at once
// (Start all →), or leave them queued for an agent to pick up when it launches. Assignment +
// queue live in the Project (projects.json) via the callbacks from DashboardView.

const MAX_H = 160

export function TaskQueue({ project, roles, liveRoles, onAddTask, onAssignTask, onRemoveTask, onSendTask, onStartAll, onSetTaskStatus }: {
  project: Project
  roles: Role[]
  liveRoles?: Record<string, string>
  onAddTask: (text: string, roleId?: string) => void
  onAssignTask: (taskId: string, roleId?: string) => void
  onRemoveTask: (taskId: string) => void
  onSendTask: (task: ProjectTask) => void
  onStartAll: () => void
  onSetTaskStatus: (taskId: string, status: ProjectTask['status']) => void
}) {
  const [draft, setDraft] = useState('')
  const [assignee, setAssignee] = useState('') // '' = unassigned
  const [showDone, setShowDone] = useState(false)
  // Tasks whose diff card is expanded inline (running + done rows).
  const [openDiff, setOpenDiff] = useState<Set<string>>(new Set())
  const taRef = useRef<HTMLTextAreaElement>(null)
  const allTasks = project.tasks ?? []
  // Split by lifecycle. The add/assign/group machinery below operates on QUEUED only.
  const running = allTasks.filter((t) => t.status === 'running')
  const done = allTasks.filter((t) => t.status === 'done')
  const tasks = allTasks.filter((t) => (t.status ?? 'queued') === 'queued')
  // Only tasks assigned to a LIVE role count as dispatchable (Start all skips stale roleIds).
  const assignedQueued = tasks.filter((t) => t.roleId && roles.some((r) => r.id === t.roleId)).length

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
  const toggleDiff = (id: string) =>
    setOpenDiff((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const laneLive = (t: ProjectTask) => !!(t.roleId && liveRoles?.[t.roleId])

  // Verification-gate chip: the project's check command run in the lane's dir at
  // completion. Colored text only (no fills) per the UI rules.
  const checkChip = (task: ProjectTask) => task.check && (
    <span
      title={task.check.status === 'running' ? 'Check running…' : (task.check.output || 'no output')}
      style={{
        flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5,
        color: task.check.status === 'pass' ? 'var(--add-fg)' : task.check.status === 'fail' ? 'var(--del-fg)' : 'var(--fg-muted)',
      }}
    >
      {task.check.status === 'running' ? '⋯ check' : task.check.status === 'pass' ? '✓ check' : '✗ check'}
    </span>
  )

  // The "Diff ▸" toggle + inline card shared by running and done rows.
  const diffToggle = (task: ProjectTask) => taskHasDiffSource(task) && (
    <button
      onClick={() => toggleDiff(task.id)}
      title="View this task's code change"
      style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: openDiff.has(task.id) ? 'var(--accent)' : 'var(--fg-muted)', cursor: 'pointer', outline: 'none', flexShrink: 0 }}
    >
      {task.diffStat ? `+${task.diffStat.added} −${task.diffStat.removed}` : 'Diff'} {openDiff.has(task.id) ? '▾' : '▸'}
    </button>
  )

  const renderRow = (task: ProjectTask) => {
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
              color: role ? 'var(--accent)' : 'var(--fg-muted)',  outline: 'none',
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
  }

  // Group the queue by assigned agent (roster order), unassigned last — but only once
  // something is assigned; an all-unassigned backlog stays a flat list (no noisy headers).
  // A task whose roleId no longer matches a live role (the role was deleted) is treated as
  // unassigned here, so it can never fall between groups and vanish from the UI.
  const hasLiveRole = (t: ProjectTask) => !!t.roleId && roles.some((r) => r.id === t.roleId)
  const anyAssigned = tasks.some(hasLiveRole)
  const groups = anyAssigned
    ? [
        ...roles
          .map((r) => ({ key: r.id, label: r.name, accent: r.accent, items: tasks.filter((t) => t.roleId === r.id) }))
          .filter((g) => g.items.length > 0),
        ...(tasks.some((t) => !hasLiveRole(t))
          ? [{ key: '__unassigned', label: 'Unassigned', accent: undefined as string | undefined, items: tasks.filter((t) => !hasLiveRole(t)) }]
          : []),
      ]
    : null

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 16, fontFamily: 'var(--font-body)' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          Tasks{tasks.length ? ` · ${tasks.length}` : ''}{running.length ? ` · ${running.length} running` : ''}
        </span>
        {assignedQueued > 0 && (
          <button
            onClick={onStartAll}
            className="actions-footer-btn is-primary"
            style={{ marginLeft: 'auto', fontSize: 10.5, padding: '3px 10px' }}
            title="Dispatch every queued task to its agent (launching lanes as needed)"
          >
            Start all →
          </button>
        )}
      </div>

      {/* In-flight: tasks handed to a lane, running until the agent's session ends (or you
          mark them done). */}
      {running.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>Running · {running.length}</span>
          </div>
          {running.map((task) => {
            const role = roleOf(task.roleId)
            return (
              <div key={task.id}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))', borderRadius: 'var(--radius-md)', padding: '8px 9px', background: 'color-mix(in srgb, var(--accent) 5%, var(--overlay-subtle))' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.4, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{task.text}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {role && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: role.accent || 'var(--fg-muted)' }}>{role.name}</span>}
                    {checkChip(task)}
                    {diffToggle(task)}
                    <button onClick={() => onSetTaskStatus(task.id, 'done')} title="Mark done" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none' }}>Done ✓</button>
                  </div>
                </div>
                {openDiff.has(task.id) && <TaskDiffCard task={task} laneLive={laneLive(task)} />}
              </div>
            )
          })}
        </div>
      )}

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

      {/* Queue — flat while all-unassigned, grouped per agent once anything is assigned. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
        {allTasks.length === 0 && (
          <p style={{ fontSize: 10.5, color: 'var(--fg-muted)', textAlign: 'center', padding: '4px 0', }}>
            No tasks yet. Add one above and assign it to an agent — or leave it for an agent to pick up.
          </p>
        )}
        {tasks.length > 0 && !groups && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{tasks.map(renderRow)}</div>
        )}
        {groups?.map((g) => (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px' }}>
              {g.accent && <span style={{ width: 6, height: 6, borderRadius: '50%', background: g.accent, flexShrink: 0 }} />}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: g.accent ? 'var(--fg)' : 'var(--fg-muted)' }}>
                {g.label} · {g.items.length}
              </span>
            </div>
            {g.items.map(renderRow)}
          </div>
        ))}
      </div>

      {/* Done — collapsed by default; expand to review or clear. */}
      {done.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setShowDone((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', padding: 0, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
              <span style={{ display: 'inline-block', transform: showDone ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>▸</span>
              Done · {done.length}
            </button>
            <button onClick={() => done.forEach((t) => onRemoveTask(t.id))} title="Clear all done tasks" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--fg-muted)' }}>Clear</button>
          </div>
          {showDone && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              {done.map((task) => {
                const role = roleOf(task.roleId)
                return (
                  <div key={task.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
                      {/* A reconciled task was closed because its RUN ended, not because it was
                          seen to finish — so it doesn't get the completion tick. Marking ~200
                          stranded tasks with a plain ✓ would have claimed work was verified
                          that nobody verified. Re-queue (↩) is right there if it wasn't done. */}
                      <span
                        style={{ color: task.reconciledAt ? 'var(--fg-muted)' : 'var(--accent)', fontSize: 11, flexShrink: 0 }}
                        title={task.reconciledAt ? 'Closed automatically: the session running it ended before it reported back' : undefined}
                      >{task.reconciledAt ? '⋯' : '✓'}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--fg-muted)', textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={task.text}>{task.text}</span>
                      {task.reconciledAt && (
                        <span data-task-reconciled style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)', flexShrink: 0 }}>
                          unconfirmed
                        </span>
                      )}
                      {role && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-muted)', flexShrink: 0 }}>{role.name}</span>}
                      {checkChip(task)}
                      {diffToggle(task)}
                      <button onClick={() => onSetTaskStatus(task.id, 'queued')} title="Re-queue" style={{ background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', color: 'var(--fg-muted)', fontSize: 11, flexShrink: 0 }}>↩</button>
                      <button onClick={() => onRemoveTask(task.id)} title="Delete" style={{ background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', color: 'var(--fg-muted)', fontSize: 11, flexShrink: 0 }}>✕</button>
                    </div>
                    {openDiff.has(task.id) && <TaskDiffCard task={task} laneLive={laneLive(task)} />}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
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
