import { useEffect, useState } from 'react'
import type { Project, Role, TokenUsage } from '../../../shared/types'
import { ROSTER_MODELS, DEFAULT_ROLE_PROMPTS, defaultRoster, roleIdFrom, isCoordinator, reorderRoles } from '../../lib/roster'

/** Live runtime for a lane's session (from the transcript observer). */
export interface LaneSession {
  phase: string // idle | running | compacting | waiting
  usage?: TokenUsage
  lastActivityAt?: string
}

/** Compact token count for the lane cards: 950 → "950", 12_400 → "12.4k", 3_400_000 → "3.4M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

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
  /** roleId → live session runtime. Currently unused by the card (the per-lane token
   *  readout is hidden); kept on the interface so callers don't need rewiring if it returns. */
  laneSessions?: Record<string, LaneSession>
  /** Focus an already-live lane's session (the "View" action). */
  onFocusTerminal?: (terminalId: string) => void
}) {
  const roster = project?.roster

  // Seed a default roster the first time a rosterless project's board is opened; and for
  // rosters created before role charters existed, backfill the default prompt per known lane.
  // Only `undefined` prompts are filled — a prompt the user cleared ('') stays cleared.
  useEffect(() => {
    if (!project || !onUpdateProject) return
    if (!project.roster) { onUpdateProject(project.id, { roster: defaultRoster() }); return }
    if (project.roster.some((r) => r.prompt === undefined && DEFAULT_ROLE_PROMPTS[r.id])) {
      onUpdateProject(project.id, {
        roster: project.roster.map((r) => (r.prompt === undefined && DEFAULT_ROLE_PROMPTS[r.id] ? { ...r, prompt: DEFAULT_ROLE_PROMPTS[r.id] } : r)),
      })
    }
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
  // Lanes ticked for a batch launch. Held as ids (not Role objects) so an edit to a
  // role while it's selected doesn't strand a stale copy.
  const [selected, setSelected] = useState<string[]>([])
  // Drag-to-reorder: which lane is being dragged, and the drop line's position.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  const isLive = (id: string) => !!liveRoles?.[id]
  // A lane that's been removed or has since gone live isn't launchable, so it can't
  // stay in the selection — derived rather than synced, so there's no stale state to
  // clean up when the roster or the live set changes underneath us.
  const picked = selected.filter((id) => roles.some((r) => r.id === id) && !isLive(id))
  const toggleSelect = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  // Nothing ticked keeps the original "launch the whole roster" behaviour; a partial
  // selection launches exactly what's ticked. Either way live lanes are skipped —
  // launching one again would spawn a duplicate session on the same lane.
  const launchTargets = picked.length
    ? roles.filter((r) => picked.includes(r.id))
    : roles.filter((r) => !isLive(r.id))
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
      {/* One header row instead of three stacked ones. The old copy explained the board
          ("each pins a model. Launch one to start it…") — the cards already say that, so
          it's down to a title plus a hint of how selection works. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <p style={{ flex: 1, fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5, margin: 0 }}>
          Agents in <strong style={{ color: 'var(--fg)' }}>{project.name}</strong>
          <span style={{ opacity: 0.6 }}>
            {picked.length ? ` — ${picked.length} selected` : ' — click to select, drag to reorder'}
          </span>
        </p>
        {roles.length > 1 && onLaunchRole && launchTargets.length > 0 && (
          <button
            onClick={() => { launchTargets.forEach((r) => onLaunchRole(project, r, devServer)); setSelected([]) }}
            title={picked.length
              ? `Spawn a session for the ${picked.length} selected lane${picked.length > 1 ? 's' : ''}`
              : 'Spawn a session for every lane that isn’t already live'}
            style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.04em', color: picked.length ? 'var(--accent)' : 'var(--fg-muted)', background: 'transparent', border: `1px solid ${picked.length ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'var(--border)'}`, borderRadius: 7, padding: '3px 8px', cursor: 'pointer', outline: 'none' }}
          >
            {picked.length ? `Launch ${picked.length} →` : 'Launch all →'}
          </button>
        )}
      </div>

      {/* Project-level settings on ONE quiet row: whether a launch also brings up the dev
          server, and the verification command run when a lane's task completes. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button
          onClick={() => setDevServer((v) => !v)}
          title="When launching an agent, have it start your dev server in the background"
          aria-pressed={devServer}
          style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 7px', borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-body)', color: devServer ? 'var(--accent)' : 'var(--fg-muted)', opacity: devServer ? 1 : 0.55 }}
        >
          <span style={{
            width: 11, height: 11, borderRadius: 2, flexShrink: 0, display: 'grid', placeItems: 'center',
            background: devServer ? 'var(--accent)' : 'transparent', border: devServer ? 'none' : '1px solid var(--fg-muted)',
          }}>
            {devServer && <svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="var(--fg-on-accent)" strokeWidth="2" /></svg>}
          </span>
          <span style={{ fontSize: 10 }}>dev server</span>
        </button>
        <span style={{ width: 1, height: 12, background: 'var(--border)', flexShrink: 0 }} />
        {/* Verification gate: shell command run in a lane's dir when its task completes
            ("done" → "done and green"). Saved on blur; empty = gates off. */}
        <input
          key={project.id}
          defaultValue={project.checkCommand ?? ''}
          placeholder="e.g. npm test  — runs when a task completes; ✓/✗ shows on the task"
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (project.checkCommand ?? '')) onUpdateProject?.(project.id, { checkCommand: v }) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg)',
            background: 'var(--overlay-subtle)', border: '1px solid var(--border)', borderRadius: 7,
            padding: '5px 9px', outline: 'none',
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {roles.map((role) => (
          // Wrapper owns the drag/drop; the card keeps its own layout. The drop line
          // renders on the hovered edge so the landing slot is unambiguous.
          <div
            key={role.id}
            onDragOver={(e) => {
              if (!dragId || dragId === role.id) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              setDropAt({ id: role.id, edge: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
            }}
            onDragLeave={() => setDropAt((d) => (d?.id === role.id ? null : d))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dropAt) setRoles(reorderRoles(roles, dragId, dropAt.id, dropAt.edge))
              setDragId(null); setDropAt(null)
            }}
            style={{
              // A 2px line, not a colour-changing border on a rounded element (WKWebView
              // repaint rule) — and never a persistent left stripe.
              borderTop: dropAt?.id === role.id && dropAt.edge === 'before' ? '2px solid var(--accent)' : '2px solid transparent',
              borderBottom: dropAt?.id === role.id && dropAt.edge === 'after' ? '2px solid var(--accent)' : '2px solid transparent',
              opacity: dragId === role.id ? 0.45 : 1,
            }}
          >
          <RoleCard
            role={role}
            onDragStart={() => setDragId(role.id)}
            onDragEnd={() => { setDragId(null); setDropAt(null) }}
            coordinator={isCoordinator(role.id)}
            live={!!liveRoles?.[role.id]}
            runningTask={(project.tasks ?? []).find((t) => t.status === 'running' && t.roleId === role.id)?.text}
            queued={taskCounts[role.id] ?? 0}
            selected={picked.includes(role.id)}
            onToggleSelect={() => toggleSelect(role.id)}
            onPatch={(patch) => patchRole(role.id, patch)}
            onRemove={() => removeRole(role.id)}
            onLaunch={() => onLaunchRole?.(project, role, devServer)}
            onView={() => { const tid = liveRoles?.[role.id]; if (tid) onFocusTerminal?.(tid) }}
          />
          </div>
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

function RoleCard({ role, coordinator, live, runningTask, queued = 0, selected, onToggleSelect, onDragStart, onDragEnd, onPatch, onRemove, onLaunch, onView }: {
  role: Role
  /** Drag-to-reorder, driven from the grip handle so text stays selectable. */
  onDragStart?: () => void
  onDragEnd?: () => void
  /** The coordinator lane (Operator) — the roster's hub, not a worker peer. */
  coordinator?: boolean
  live?: boolean
  /** The task currently running on this lane (latest), for the "working on" line. */
  runningTask?: string
  queued?: number
  /** Ticked for a batch launch (see the roster header's Launch button). */
  selected?: boolean
  onToggleSelect?: () => void
  onPatch: (patch: Partial<Role>) => void
  onRemove: () => void
  onLaunch: () => void
  onView: () => void
}) {
  const [editingName, setEditingName] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const accent = role.accent || 'var(--accent)'
  const promptPreview = (role.prompt ?? '').trim()

  // Selecting a lane for a batch launch is a property of the CARD, not a checkbox —
  // click anywhere that isn't itself a control. A live lane can't be launched again, so
  // it isn't selectable. The border stays a constant colour (a colour-CHANGING border on
  // a rounded element re-rasterises in WKWebView); selection reads as a faint tint plus
  // an inset ring, per the no-solid-accent-fill rule.
  const selectable = !live && !!onToggleSelect
  const onCardClick = (e: React.MouseEvent) => {
    if (!selectable) return
    if ((e.target as HTMLElement).closest('button,input,textarea,select,a,[draggable="true"]')) return
    onToggleSelect?.()
  }

  return (
    <div
      onClick={onCardClick}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: '11px 13px',
        cursor: selectable ? 'pointer' : 'default',
        background: selected
          ? `color-mix(in srgb, ${accent} 10%, var(--overlay-subtle))`
          : live ? `color-mix(in srgb, ${accent} 6%, var(--overlay-subtle))` : 'var(--overlay-subtle)',
        boxShadow: selected ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 55%, transparent)` : 'none',
        transition: 'background 120ms ease',
      }}
    >
      {/* Identity row: grip + colour dot/tick + name + live pill + remove. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Grip: only this is draggable, so the card's text stays selectable and the
            tick box stays clickable. Roster order drives the board, the ⌘K launch
            list, and which lane reads as the project's lead. */}
        <span
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.() }}
          onDragEnd={() => onDragEnd?.()}
          title={`Drag to reorder ${role.name}`}
          aria-label={`Reorder ${role.name}`}
          style={{ flexShrink: 0, cursor: 'grab', display: 'grid', placeItems: 'center', width: 10, opacity: 0.45 }}
        >
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none" style={{ display: 'block' }}>
            {[2, 6, 10].map((cy) => (
              <g key={cy}>
                <circle cx="3" cy={cy} r="1" fill="var(--fg-muted)" />
                <circle cx="7" cy={cy} r="1" fill="var(--fg-muted)" />
              </g>
            ))}
          </svg>
        </span>
        {/* The lane's colour — identity only. Selection is carried by the card itself
            (tint + inset ring), so there's no checkbox competing with it. Fixed 14px slot
            keeps every card's name on one vertical rule. */}
        <span style={{ width: 14, flexShrink: 0, display: 'grid', placeItems: 'center' }}>
          <span style={{
            width: selected ? 9 : 7, height: selected ? 9 : 7, borderRadius: '50%',
            background: accent, transition: 'width 120ms ease, height 120ms ease',
          }} />
        </span>
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
        {coordinator && (
          <span title="The coordinator — routes work to the other lanes, and does it itself when none fits" style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: accent, opacity: 0.85 }}>
            coordinator
          </span>
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
        {/* The coordinator is the roster's hub — the lane that routes to every other. Removing
            it would leave the roster with no dispatcher, so it's kept (workers stay removable). */}
        {!coordinator && (
          <button onClick={onRemove} title="Remove agent" style={{ flexShrink: 0, width: 20, height: 20, padding: 0, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none', fontSize: 12 }}>✕</button>
        )}
      </div>

      {/* Mission line — what the live lane is working on. The per-lane token readout that
          used to sit here is HIDDEN for now: it priced attention it didn't earn on a board
          that's about who's doing what, not spend. (formatTokens + the usage plumbing are
          left in place; the Usage & cost view still reports it.) */}
      {live && runningTask && (
        <div style={{ marginTop: 8, paddingLeft: 22 }}>
          <span title={runningTask} style={{ display: 'block', fontSize: 11, lineHeight: 1.4, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ▸ {runningTask}
          </span>
        </div>
      )}

      {/* Config + action on one row. The MODEL/EFFORT/WORKTREE captions are gone: with the
          alternatives dimmed, the lit value IS the answer, and four captions per card ×
          six cards was most of the visual weight on this board. A thin divider separates
          the two groups; worktree carries its own word so it needs no caption either. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap', paddingLeft: 22 }}>
        <Segmented options={ROSTER_MODELS.map((m) => ({ id: m.id, label: m.label }))} value={role.model} onChange={(id) => onPatch({ model: id })} accent={accent} />
        <span style={{ width: 1, height: 12, background: 'var(--border)', flexShrink: 0 }} />
        <Segmented options={EFFORTS.map((e) => ({ id: e.id as string, label: e.label }))} value={role.effort ?? 'high'} onChange={(id) => onPatch({ effort: id as Role['effort'] })} accent={accent} />
        <span style={{ width: 1, height: 12, background: 'var(--border)', flexShrink: 0 }} />
        <button
          onClick={() => onPatch({ useWorktree: !role.useWorktree })}
          title="Run this lane in an isolated git worktree — its tasks get their own diff, mergeable back when done"
          aria-pressed={!!role.useWorktree}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 7px', borderRadius: 5,
            border: 'none', background: role.useWorktree ? `color-mix(in srgb, ${accent} 12%, transparent)` : 'transparent',
            color: role.useWorktree ? accent : 'var(--fg-muted)', opacity: role.useWorktree ? 1 : 0.4,
            cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.03em',
          }}
        >
          <span style={{
            width: 9, height: 9, borderRadius: 2, flexShrink: 0,
            border: `1px solid ${role.useWorktree ? 'transparent' : 'var(--fg-muted)'}`,
            background: role.useWorktree ? accent : 'transparent',
          }} />
          worktree
        </button>
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

      {/* The lane's standing charter — appended to its system prompt at launch. Collapsed
          to a one-line preview; click to edit in place (blur saves, Esc cancels). */}
      <div style={{ marginTop: 8, paddingLeft: 22 }}>
        {editingPrompt ? (
          <textarea
            autoFocus
            defaultValue={role.prompt ?? ''}
            onBlur={(e) => { onPatch({ prompt: e.target.value.trim() }); setEditingPrompt(false) }}
            onKeyDown={(e) => { if (e.key === 'Escape') { (e.target as HTMLTextAreaElement).value = role.prompt ?? ''; (e.target as HTMLTextAreaElement).blur() } }}
            rows={4}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'var(--font-body)',
              fontSize: 11, lineHeight: 1.5, color: 'var(--fg)', background: 'var(--overlay-subtle)',
              border: '1px solid var(--border)', borderRadius: 8, padding: '7px 9px', outline: 'none',
            }}
          />
        ) : (
          <button
            onClick={() => setEditingPrompt(true)}
            title={promptPreview ? `${promptPreview}\n\nClick to edit this lane's prompt` : 'Add a standing prompt for this lane'}
            style={{
              display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
              padding: 0, cursor: 'text', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 10.5,
              lineHeight: 1.45, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              opacity: 0.72, fontStyle: promptPreview ? 'italic' : 'normal',
            }}
          >
            {promptPreview || <em style={{ opacity: 0.6 }}>no charter — click to add</em>}
          </button>
        )}
      </div>
    </div>
  )
}

// A compact segmented control (transparent tint, accent for the active segment — no fills).
/** A row of choices that reads as a VALUE, not as four equal options.
 *
 *  Six cards × (4 models + 3 efforts) put 42 equally-weighted words on this board, which
 *  is why it read as noise. The alternatives are still one click away, but they recede
 *  hard until hover; the chosen one carries the LANE's colour, so scanning the column
 *  tells you each lane's model without reading a label. The container border is gone —
 *  a box inside a card inside a list was one nesting level too many. */
function Segmented({ options, value, onChange, accent }: {
  options: Array<{ id: string; label: string }>
  value: string
  onChange: (id: string) => void
  accent?: string
}) {
  const tint = accent || 'var(--accent)'
  return (
    <div style={{ display: 'inline-flex', gap: 1, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            title={active ? undefined : `Switch to ${o.label}`}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.03em',
              padding: '2px 7px', borderRadius: 5, cursor: 'pointer', outline: 'none', border: 'none',
              color: active ? tint : 'var(--fg-muted)',
              background: active ? `color-mix(in srgb, ${tint} 12%, transparent)` : 'transparent',
              opacity: active ? 1 : 0.4,
              transition: 'opacity 120ms ease',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.opacity = '0.9' }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.opacity = '0.4' }}
          >{o.label}</button>
        )
      })}
    </div>
  )
}
