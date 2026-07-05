import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Project, Role } from '../../../shared/types'
import { ROSTER_MODELS, defaultRoster, roleIdFrom } from '../../lib/roster'

// The orchestration Roster — a project's agent lanes. Each role pins a model + reasoning
// effort; launching a role spawns a session on that lane (project root, role's config,
// tagged with roleId). Edits persist into the project (projects.json) via onUpdateProject.
// A project with no roster yet (created before orchestration) is seeded on first open.

const EFFORTS: Array<{ id: Role['effort']; label: string }> = [
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
]

export function RosterPanel({ project, onUpdateProject, onLaunchRole, liveRoles, onFocusTerminal }: {
  project?: Project
  onUpdateProject?: (id: string, patch: Partial<Project>) => void
  onLaunchRole?: (project: Project, role: Role, launchDevServer?: boolean) => void
  /** roleId → live terminalId, for live dots. */
  liveRoles?: Record<string, string>
  /** Focus an already-live lane's session (the "View" action). */
  onFocusTerminal?: (terminalId: string) => void
}) {
  const roster = project?.roster

  // Seed a default roster the first time a rosterless project's board is opened.
  useEffect(() => {
    if (project && !project.roster && onUpdateProject) onUpdateProject(project.id, { roster: defaultRoster() })
  }, [project, onUpdateProject])

  if (!project) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', lineHeight: 1.5 }}>
          The roster belongs to a project.<br />This session isn’t linked to one yet.
        </p>
      </div>
    )
  }

  const roles = roster ?? []
  // Whether launching an agent also has it start the project's dev server (so Preview works).
  const [devServer, setDevServer] = useState(true)
  // Queued-task count per agent, so each card can show its backlog + a launch that picks it up.
  const taskCounts: Record<string, number> = {}
  for (const t of project.tasks ?? []) if (t.roleId) taskCounts[t.roleId] = (taskCounts[t.roleId] ?? 0) + 1
  const setRoles = (next: Role[]) => onUpdateProject?.(project.id, { roster: next })
  const patchRole = (id: string, patch: Partial<Role>) => setRoles(roles.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addRole = () => {
    const name = 'New role'
    setRoles([...roles, { id: roleIdFrom(name + ' ' + (roles.length + 1), roles), name, model: 'sonnet', effort: 'high' }])
  }
  // Removing a role also unassigns its queued tasks (back to the backlog) — otherwise they'd
  // carry a stale roleId that no group matches and drop out of the queue UI.
  const removeRole = (id: string) => onUpdateProject?.(project.id, {
    roster: roles.filter((r) => r.id !== id),
    tasks: (project.tasks ?? []).map((t) => (t.roleId === id ? { ...t, roleId: undefined } : t)),
  })

  return (
    <div style={{ boxSizing: 'border-box', fontFamily: 'var(--font-body)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <p style={{ flex: 1, fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5, margin: 0 }}>
          Agents in <strong style={{ color: 'var(--fg)' }}>{project.name}</strong> — each pins a model. Launch one to
          start it, or view a live one.
        </p>
        {roles.length > 1 && onLaunchRole && (
          <button
            onClick={() => roles.forEach((r) => onLaunchRole(project, r, devServer))}
            title="Spawn a session for every lane at once"
            style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--fg-muted)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 8px', cursor: 'pointer', outline: 'none' }}
          >
            Launch all →
          </button>
        )}
      </div>

      {/* Whether a launched agent also brings up the project's dev server (so Preview works). */}
      <button
        onClick={() => setDevServer((v) => !v)}
        title="When launching an agent, have it start your dev server in the background"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 14, padding: '4px 2px', background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-body)' }}
      >
        <span style={{
          width: 14, height: 14, borderRadius: 3, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: devServer ? 'var(--accent)' : 'transparent', border: devServer ? 'none' : '1px solid var(--border)',
        }}>
          {devServer && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="var(--fg-on-accent)" strokeWidth="1.6" /></svg>}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>Launch dev server with agents</span>
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {roles.map((role) => (
          <RoleCard
            key={role.id}
            role={role}
            live={!!liveRoles?.[role.id]}
            queued={taskCounts[role.id] ?? 0}
            onPatch={(patch) => patchRole(role.id, patch)}
            onRemove={() => removeRole(role.id)}
            onLaunch={() => onLaunchRole?.(project, role, devServer)}
            onView={() => { const tid = liveRoles?.[role.id]; if (tid) onFocusTerminal?.(tid) }}
          />
        ))}
      </div>

      <button
        onClick={addRole}
        style={{
          marginTop: 10, width: '100%', padding: '8px 0', cursor: 'pointer',
          border: '1.5px dashed var(--border)', borderRadius: 'var(--radius-md)', background: 'transparent',
          color: 'var(--fg-muted)', outline: 'none', fontFamily: 'inherit', fontSize: 11,
        }}
      >
        + Add agent
      </button>
    </div>
  )
}

function RoleCard({ role, live, queued = 0, onPatch, onRemove, onLaunch, onView }: {
  role: Role
  live?: boolean
  queued?: number
  onPatch: (patch: Partial<Role>) => void
  onRemove: () => void
  onLaunch: () => void
  onView: () => void
}) {
  const [editingName, setEditingName] = useState(false)
  const accent = role.accent || 'var(--accent)'

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: '11px 13px',
      background: live ? `color-mix(in srgb, ${accent} 6%, var(--overlay-subtle))` : 'var(--overlay-subtle)',
    }}>
      {/* Identity row: colour dot + name + live pill + remove. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent, flexShrink: 0 }} />
        {editingName ? (
          <input
            autoFocus
            defaultValue={role.name}
            onBlur={(e) => { onPatch({ name: e.target.value.trim() || role.name }); setEditingName(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            style={{ flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: 13, fontWeight: 600, background: 'transparent', color: 'var(--fg)', border: 'none', outline: 'none', borderBottom: '1px solid var(--border)' }}
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            title="Rename"
            style={{ flex: 1, minWidth: 0, textAlign: 'left', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--fg)', background: 'transparent', border: 'none', outline: 'none', cursor: 'text', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >{role.name}</button>
        )}
        {queued > 0 && (
          <span title={`${queued} queued task${queued > 1 ? 's' : ''} for this agent`} style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px' }}>
            {queued} queued
          </span>
        )}
        {live && (
          <span title="This lane has a live session" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: accent, border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`, borderRadius: 6, padding: '2px 6px' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent }} />live
          </span>
        )}
        <button onClick={onRemove} title="Remove agent" style={{ flexShrink: 0, width: 20, height: 20, padding: 0, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none', fontSize: 12 }}>✕</button>
      </div>

      {/* Config + action, one horizontal row (uses the width; action pinned right). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
        <Field label="Model">
          <Segmented options={ROSTER_MODELS.map((m) => ({ id: m.id, label: m.label }))} value={role.model} onChange={(id) => onPatch({ model: id })} small />
        </Field>
        <Field label="Effort">
          <Segmented options={EFFORTS.map((e) => ({ id: e.id as string, label: e.label }))} value={role.effort ?? 'high'} onChange={(id) => onPatch({ effort: id as Role['effort'] })} small />
        </Field>
        {live ? (
          <button onClick={onView} className="actions-footer-btn" style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 14px' }} title={`View the live ${role.name} session`}>View →</button>
        ) : (
          <button
            onClick={onLaunch}
            className="actions-footer-btn is-primary"
            style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 14px' }}
            title={queued > 0 ? `Launch ${role.name} and start its ${queued} queued task${queued > 1 ? 's' : ''}` : `Launch a ${role.name} session (${role.model})`}
          >
            {queued > 0 ? `Launch ${queued} →` : 'Launch →'}
          </button>
        )}
      </div>
    </div>
  )
}

// Inline "LABEL  <control>" pairing used inside a role card.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{label}</span>
      {children}
    </div>
  )
}

// A compact segmented control (transparent tint, accent for the active segment — no fills).
function Segmented({ options, value, onChange, small }: {
  options: Array<{ id: string; label: string }>
  value: string
  onChange: (id: string) => void
  small?: boolean
}) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, border: '1px solid var(--border)', borderRadius: 7, padding: 2, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: small ? 9.5 : 10, letterSpacing: '0.03em',
              padding: small ? '2px 7px' : '3px 9px', borderRadius: 5, cursor: 'pointer', outline: 'none', border: 'none',
              color: active ? 'var(--accent)' : 'var(--fg-muted)',
              background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
            }}
          >{o.label}</button>
        )
      })}
    </div>
  )
}
