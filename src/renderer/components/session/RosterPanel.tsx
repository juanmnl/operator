import { useEffect, useRef, useState } from 'react'
import type { Project, ProjectPatch, Role, TokenUsage } from '../../../shared/types'
import { ROSTER_MODELS, DEFAULT_ROLE_PROMPTS, rolePresets, roleIdFrom, isCoordinator, reorderRoles, patchRoleIn, removeRoleFrom } from '../../lib/roster'
import { AccentPicker } from '../AccentPicker'
import { laneTextColor } from '../../lib/lane-color'
import {
  resolveAgentConfig, configOrigins, worktreeStateOf, nextWorktreeState,
  type GlobalRoleDefaults, type ConfigOrigin,
} from '../../lib/model-config'
import { queuedCountsByRole } from '../../lib/task-lifecycle'

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

/** Resting ink for an UNSELECTED choice in a lane's controls (model, effort, worktree).
 *
 *  These are held to the 4.5:1 BODY bar, not the 3:1 meta bar, so they can't just wear
 *  `--fg-muted` (which lands 3.51–4.07:1 at 9.5px on the light palettes). A path or a
 *  timestamp is context — you can ignore it and still operate the UI. "Sonnet" vs "Haiku"
 *  IS the control: you cannot choose a model without reading the options, and an unselected
 *  radio option is still an option. The hover brighten doesn't rescue it either — it's
 *  mouse-only, the same flaw that got group opacity removed from the idle RoleCard.
 *
 *  Stepping the ink (rather than raising --fg-muted globally) keeps every genuinely-meta
 *  label in the app at the quiet weight the light themes are designed around. The "the lit
 *  value IS the answer" hierarchy survives because it's carried by COLOUR — the lane accent
 *  plus a tinted chip — not by making the alternatives hard to read.
 *
 *  72% is the same step-down the gallery card's description uses, deliberately: one
 *  "readable but secondary" ink in the app beats two neighbouring ones. At 68% this
 *  measured 4.45:1 on Mr Pink light — 0.05 under the bar. */
const CONTROL_OFF = 'color-mix(in srgb, var(--fg) 72%, transparent)'

const EFFORTS: Array<{ id: Role['effort']; label: string }> = [
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
]

export function RosterPanel({ project, onUpdateProject, onLaunchRole, liveRoles, laneSessions, onFocusTerminal, onCloseTerminal, roleDefaults }: {
  project?: Project
  /** The GLOBAL per-role defaults. A lane whose field is absent inherits from here, and the card
   *  has to SAY so — a resolved value drawn like a pinned one makes the global look broken. */
  roleDefaults?: GlobalRoleDefaults
  onUpdateProject?: (id: string, patch: ProjectPatch) => void
  onLaunchRole?: (project: Project, role: Role, launchDevServer?: boolean) => void
  /** roleId → live terminalId, for live dots. */
  liveRoles?: Record<string, string>
  /** roleId → live session runtime. The card shows the phase in its live pill (the per-lane token
   *  readout is hidden); kept on the interface so callers don't need rewiring if it returns. */
  laneSessions?: Record<string, LaneSession>
  /** Focus an already-live lane's session (the "View" action). */
  onFocusTerminal?: (terminalId: string) => void
  /** Close a lane's live session (the ■ on a live card). Distinct from deleting the lane. */
  onCloseTerminal?: (terminalId: string) => void
}) {
  const roster = project?.roster

  // Seed a default roster the first time a rosterless project's board is opened; and for
  // rosters created before role charters existed, backfill the default prompt per known lane.
  // Only `undefined` prompts are filled — a prompt the user cleared ('') stays cleared.
  useEffect(() => {
    if (!project || !onUpdateProject) return
    // No seeding. A rosterless project (legacy, or brand new) stays empty until the user
    // adds a lane — `roles` below reads `roster ?? []`, so there is nothing to write.
    if (!project.roster) return
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
  // Which lane's colour picker is open, and where it's anchored.
  const [accentFor, setAccentFor] = useState<{ roleId: string; top: number; left: number } | null>(null)
  // Drag-to-reorder: which lane is being dragged, and the drop line's position.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  // Which idle lane is expanded into its full card for editing (at most one — the row is a
  // launch affordance, so opening an editor shouldn't turn the list back into a wall).
  const [expanded, setExpanded] = useState<string | null>(null)
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
  // The split that drives the whole board. Both keep roster order, so dragging a lane
  // between the two sections still writes one linear roster.
  const liveRolesList = roles.filter((r) => isLive(r.id))
  const idleRolesList = roles.filter((r) => !isLive(r.id))
  // Queued-task count per agent, so each card can show its backlog + a launch that picks it
  // up. QUEUED ONLY (see lib/task-lifecycle): this used to count every task ever filed against
  // a lane — running and done included — and render the total as "N QUEUED", so a lane showing
  // "28 QUEUED" was really 23 running + 7 done, and its Launch button offered to start tasks
  // that had already finished.
  const taskCounts = queuedCountsByRole(project.tasks)
  const setRoles = (next: Role[]) => onUpdateProject?.(project.id, { roster: next })
  // Role edits are applied to the project as it is when the update lands, NOT to the
  // `roles` array this render closed over: recolouring one lane and renaming another
  // before the first render arrived had both start from the same stale roster, so the
  // second write reverted the first (see patchRoleIn).
  const patchRole = (id: string, patch: Partial<Role>) =>
    onUpdateProject?.(project.id, (cur) => ({ roster: patchRoleIn(cur.roster, id, patch) }))
  // A new lane opens EXPANDED. Collapsed, it's a LaneRow — which carries its own Launch —
  // so a lane still called "New role" on stock sonnet/high could be launched before anyone
  // had seen, let alone set, its name/model/effort/prompt. Expanding lands you on the
  // RoleCard, where the config pills sit next to that Launch: same config-before-launch path
  // an existing idle lane already gets by expanding, now applied where it was skipped.
  // Presets not already on the board — the "+ Add agent" menu. Adding Code is one click,
  // with its tuned model/effort/accent/charter intact; there is no form to fill.
  const availablePresets = rolePresets().filter((p) => !roles.some((r) => r.id === p.id))
  const addPreset = (preset: Role) => {
    setRoles([...roles, { ...preset }])
    setExpanded(null) // a preset arrives configured, so it opens as a ROW, not a card
  }
  const addRole = () => {
    const name = 'New role'
    const role: Role = { id: roleIdFrom(name + ' ' + (roles.length + 1), roles), name, model: 'sonnet', effort: 'high' }
    setRoles([...roles, role])
    setExpanded(role.id)
  }
  // Removing a role also unassigns its queued tasks (back to the backlog) — otherwise they'd
  // carry a stale roleId that no group matches and drop out of the queue UI.
  const removeRole = (id: string) => onUpdateProject?.(project.id, (cur) => removeRoleFrom(cur, id))

  return (
    <div style={{ boxSizing: 'border-box', fontFamily: 'var(--font-body)' }}>
      {/* One header row instead of three stacked ones. The old copy explained the board
          ("each pins a model. Launch one to start it…") — the cards already say that, so
          it's down to a title plus a hint of how selection works. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <p style={{ flex: 1, fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5, margin: 0 }}>
          Agents in <strong style={{ color: 'var(--fg)' }}>{project.name}</strong>
          <span>
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
          style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 7px', borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-body)', color: devServer ? 'var(--accent)' : 'var(--fg-muted)' }}
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

      {/* A full card is how the board answers "who's working right now", so only a LIVE lane
          earns one. Every project is seeded with a default roster, so rendering all six as
          cards meant a brand-new project opened on a wall of identical idle boxes — the team
          reading as dormant rather than as ready. Idle lanes drop to one compact row each
          (see LaneRow), which keeps them a click from launching without them being the view. */}
      {liveRolesList.length > 0 && (
        <>
          <SectionLabel>Live · {liveRolesList.length}</SectionLabel>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 10,
            alignItems: 'stretch',
            marginBottom: idleRolesList.length > 0 ? 16 : 0,
          }}>
            {liveRolesList.map((role) => (
          // Wrapper owns the drag/drop; the card keeps its own layout. The drop line renders
          // on the hovered edge so the landing slot is unambiguous. In the grid the roster is
          // still a LINEAR order, so "before/after" is decided by the horizontal midpoint —
          // left/right within a row, wrapping across rows. (Not a true 2D drop; see report.)
          <div
            key={role.id}
            onDragOver={(e) => {
              if (!dragId || dragId === role.id) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              setDropAt({ id: role.id, edge: e.clientX < r.left + r.width / 2 ? 'before' : 'after' })
            }}
            onDragLeave={() => setDropAt((d) => (d?.id === role.id ? null : d))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dropAt) setRoles(reorderRoles(roles, dragId, dropAt.id, dropAt.edge))
              setDragId(null); setDropAt(null)
            }}
            style={{
              display: 'flex',
              // A 2px vertical line on the drop edge — on the wrapper (no border-radius), so
              // no colour-CHANGING border on a rounded element (WKWebView repaint rule); the
              // border is always 2px so the grid never reflows as it toggles colour.
              borderLeft: dropAt?.id === role.id && dropAt.edge === 'before' ? '2px solid var(--accent)' : '2px solid transparent',
              borderRight: dropAt?.id === role.id && dropAt.edge === 'after' ? '2px solid var(--accent)' : '2px solid transparent',
              opacity: dragId === role.id ? 0.45 : 1,
            }}
          >
          <RoleCard
            role={role}
            onDragStart={() => setDragId(role.id)}
            onDragEnd={() => { setDragId(null); setDropAt(null) }}
            coordinator={isCoordinator(role.id)}
            live
            phase={laneSessions?.[role.id]?.phase}
            onPickAccent={(anchor) => setAccentFor({ roleId: role.id, ...anchor })}
            runningTask={(project.tasks ?? []).find((t) => t.status === 'running' && t.roleId === role.id)?.text}
            queued={taskCounts[role.id] ?? 0}
            selected={false}
            onPatch={(patch) => patchRole(role.id, patch)}
            roleDefaults={roleDefaults}
            projectDefaults={project.defaults}
            onRemove={() => removeRole(role.id)}
            onCloseSession={() => { const tid = liveRoles?.[role.id]; if (tid) onCloseTerminal?.(tid) }}
            onLaunch={() => onLaunchRole?.(project, role, devServer)}
            onView={() => { const tid = liveRoles?.[role.id]; if (tid) onFocusTerminal?.(tid) }}
          />
          </div>
            ))}
          </div>
        </>
      )}

      {/* EMPTY ROSTER — now the first thing every new project shows, so it has to teach what a
          lane is and make the first one one click away. Not a shrug: the presets ARE the
          content here, laid out as the primary action rather than hidden behind a menu. */}
      {roles.length === 0 && (
        <div data-roster-empty style={{ padding: '10px 0 4px' }}>
          <p style={{ fontSize: 12.5, color: 'var(--fg)', margin: '0 0 4px', fontWeight: 500 }}>
            No agents yet.
          </p>
          <p style={{ fontSize: 11.5, lineHeight: 1.55, color: 'color-mix(in srgb, var(--fg) 72%, transparent)', margin: '0 0 14px', maxWidth: 520 }}>
            An agent is a lane: a named seat on this project with its own model, reasoning effort
            and standing brief. Launching one starts a Claude Code session on it. Start from a
            template — you can rename, retune or remove any of them afterwards.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(228px, 1fr))', gap: 8 }}>
            {availablePresets.map((preset) => (
              <PresetCard key={preset.id} preset={preset} onClick={() => addPreset(preset)} />
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              onClick={addRole}
              title="Add a lane with no template — you configure it"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, height: ROW_H,
                padding: `0 ${COLUMN_INSET}px`, boxSizing: 'border-box', cursor: 'pointer',
                border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', background: 'transparent',
                color: 'var(--fg-muted)', outline: 'none', fontFamily: 'inherit', fontSize: 11,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-muted)' }}
            >
              + Blank lane
            </button>
          </div>
        </div>
      )}

      {/* READY — the lanes that exist but aren't running. One row each: identity, the pinned
          model/effort (kept VISIBLE, since "what is this lane" is the reason to pick it), and
          its Launch button. Expanding a row swaps in the very same RoleCard, so editing a lane
          has exactly one implementation. The list ends with "+ Add agent" at the same height —
          the low-emphasis family this row style extends. */}
      {idleRolesList.length > 0 && <SectionLabel>Ready · {idleRolesList.length}</SectionLabel>}
      {roles.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {idleRolesList.map((role) => {
          const rowProps = {
            onDragOver: (e: React.DragEvent) => {
              if (!dragId || dragId === role.id) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              setDropAt({ id: role.id, edge: e.clientY < r.top + r.height / 2 ? 'before' as const : 'after' as const })
            },
            onDragLeave: () => setDropAt((d) => (d?.id === role.id ? null : d)),
            onDrop: (e: React.DragEvent) => {
              e.preventDefault()
              if (dragId && dropAt) setRoles(reorderRoles(roles, dragId, dropAt.id, dropAt.edge))
              setDragId(null); setDropAt(null)
            },
            // Horizontal drop rule for a vertical list — constant 2px so the list never
            // reflows as it toggles colour, and on the wrapper so no radiused element ever
            // changes border colour (the WKWebView repaint rule).
            style: {
              borderTop: dropAt?.id === role.id && dropAt.edge === 'before' ? '2px solid var(--accent)' : '2px solid transparent',
              borderBottom: dropAt?.id === role.id && dropAt.edge === 'after' ? '2px solid var(--accent)' : '2px solid transparent',
              opacity: dragId === role.id ? 0.45 : 1,
            } as React.CSSProperties,
          }
          return (
            <div key={role.id} {...rowProps}>
              {expanded === role.id ? (
                <RoleCard
                  role={role}
                  onDragStart={() => setDragId(role.id)}
                  onDragEnd={() => { setDragId(null); setDropAt(null) }}
                  coordinator={isCoordinator(role.id)}
                  live={false}
                  onPickAccent={(anchor) => setAccentFor({ roleId: role.id, ...anchor })}
                  queued={taskCounts[role.id] ?? 0}
                  selected={picked.includes(role.id)}
                  onToggleSelect={() => toggleSelect(role.id)}
                  onCollapse={() => setExpanded(null)}
                  onPatch={(patch) => patchRole(role.id, patch)}
                  roleDefaults={roleDefaults}
                  projectDefaults={project.defaults}
                  onRemove={() => removeRole(role.id)}
                  onLaunch={() => onLaunchRole?.(project, role, devServer)}
                  onView={() => {}}
                />
              ) : (
                <LaneRow
                  role={role}
                  coordinator={isCoordinator(role.id)}
                  queued={taskCounts[role.id] ?? 0}
                  selected={picked.includes(role.id)}
                  onToggleSelect={() => toggleSelect(role.id)}
                  onExpand={() => setExpanded(role.id)}
                  onDragStart={() => setDragId(role.id)}
                  onDragEnd={() => { setDragId(null); setDropAt(null) }}
                  onPickAccent={(anchor) => setAccentFor({ roleId: role.id, ...anchor })}
                  onLaunch={() => onLaunchRole?.(project, role, devServer)}
                />
              )}
            </div>
          )
        })}

        {/* The pattern the idle rows extend: same height, same quiet weight, same hover. */}
        <AddAgentControl presets={availablePresets} onAddPreset={addPreset} onAddBlank={addRole} />
      </div>
      )}

      {/* Lane colour picker. The roster is the source of truth for a lane's colour, so
          writing it here recolours every surface that resolves through the role. */}
      {accentFor && (() => {
        const target = roles.find((r) => r.id === accentFor.roleId)
        if (!target) return null
        return (
          <AccentPicker
            top={accentFor.top}
            left={accentFor.left}
            value={target.accent}
            title={`${target.name} lane`}
            onPick={(accent) => { patchRole(target.id, { accent }); setAccentFor(null) }}
            onClose={() => setAccentFor(null)}
          />
        )
      })()}
    </div>
  )
}

function RoleCard({ role, coordinator, live, phase, runningTask, queued = 0, selected, onToggleSelect, onCollapse, onDragStart, onDragEnd, onPatch, onRemove, onCloseSession, onLaunch, onView, onPickAccent, roleDefaults, projectDefaults }: {
  role: Role
  /** The global per-role layer, so the card can distinguish inherited from pinned. */
  roleDefaults?: GlobalRoleDefaults
  projectDefaults?: Project['defaults']
  /** Present when this card is an EXPANDED idle row — collapses back to its LaneRow. */
  onCollapse?: () => void
  /** Drag-to-reorder, driven from the grip handle so text stays selectable. */
  onDragStart?: () => void
  onDragEnd?: () => void
  /** The coordinator lane (Operator) — the roster's hub, not a worker peer. */
  coordinator?: boolean
  live?: boolean
  /** The live session's phase (running/compacting/waiting/idle) — shown in the pill. */
  phase?: string
  /** Right-click the identity dot → colour picker for this lane. */
  onPickAccent?: (anchor: { top: number; left: number }) => void
  /** The task currently running on this lane (latest), for the "working on" line. */
  runningTask?: string
  queued?: number
  /** Ticked for a batch launch (see the roster header's Launch button). */
  selected?: boolean
  onToggleSelect?: () => void
  onPatch: (patch: Partial<Role>) => void
  onRemove: () => void
  /** Close the lane's live SESSION. A different verb from deleting the lane, so it gets a
   *  different control — this is the one the user reaches for on a running card. */
  onCloseSession?: () => void
  onLaunch: () => void
  onView: () => void
}) {
  // What this lane will ACTUALLY launch with, and where each field came from. The card shows the
  // resolved value — a lane reading "Fable" while it launches Opus is worse than no readout.
  const resolved = resolveAgentConfig(role, roleDefaults, projectDefaults)
  const origins = configOrigins(role, roleDefaults, projectDefaults)
  const wt = worktreeStateOf(role)
  const [editingName, setEditingName] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  // Arms the lane-delete confirm (see the ✕ below); auto-disarms so a stray first click
  // can't leave a live trigger sitting there.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])
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
      data-role-card={role.id}
      onClick={onCardClick}
      style={{
        display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, boxSizing: 'border-box',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: '11px 13px',
        cursor: selectable ? 'pointer' : 'default',
        background: selected
          ? `color-mix(in srgb, ${accent} 10%, var(--overlay-subtle))`
          : live ? `color-mix(in srgb, ${accent} 9%, var(--overlay-subtle))` : 'var(--overlay-subtle)',
        boxShadow: selected ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 55%, transparent)` : 'none',
        // "Who's running now" is the board's main question, and the LIVE cards answer it
        // by colour: an accent-tinted wash + the phase pill. Idle cards deliberately do
        // NOT fade — group opacity composites text and card background toward the page
        // together, so it shrinks the ratio between them: at 0.62 the lane prompt measured
        // 2.05:1 (dark) / 1.7:1 (light) and the model+effort chips 1.4:1 / 1.32:1, i.e.
        // unreadable. It also can't be undone per-child (a subtree can't exceed its group's
        // opacity), so the idle card's primary action — Launch — faded with everything else,
        // and the hover-to-restore escape hatch was mouse-only, unreachable by keyboard.
        transition: 'background 120ms ease',
      }}
      // Hover feedback via the background only — a colour-CHANGING border on a
      // border-radius element re-rasterises in WKWebView.
      onMouseEnter={(e) => { if (!live && !selected) e.currentTarget.style.background = 'var(--overlay-medium)' }}
      onMouseLeave={(e) => { if (!live && !selected) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
    >
      {/* TOP — identity: grip + colour dot + name + remove. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {/* Grip: only this is draggable, so the card's text stays selectable and the inner
            controls stay clickable. Roster order drives the board, the ⌘K launch list, and
            which lane reads as the project's lead. */}
        <span
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.() }}
          onDragEnd={() => onDragEnd?.()}
          title={`Drag to reorder ${role.name}`}
          aria-label={`Reorder ${role.name}`}
          style={{ flexShrink: 0, cursor: 'grab', display: 'grid', placeItems: 'center', width: 10 }}
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
            (tint + inset ring), so there's no checkbox competing with it. */}
        <span
          data-accent-orb={role.id}
          title={onPickAccent ? `${role.name} — right-click to recolour` : undefined}
          onContextMenu={onPickAccent && ((e) => {
            e.preventDefault()
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            onPickAccent({ top: r.bottom + 6, left: r.left })
          })}
          style={{ width: 12, flexShrink: 0, display: 'grid', placeItems: 'center' }}
        >
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
        {onCollapse && (
          <button
            onClick={(e) => { e.stopPropagation(); onCollapse() }}
            title="Done — back to the list"
            aria-label={`Collapse ${role.name}`}
            style={{ flexShrink: 0, width: 20, height: 20, padding: 0, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', outline: 'none', fontSize: 9 }}
          >▴</button>
        )}
        {/* CLOSE THE SESSION — the verb the user actually reached for on a running card, and
            the one that was missing entirely: with delete correctly blocked while live, a live
            card otherwise offers no way to stop its agent at all. Ends the pty; the lane and
            all its configuration stay. Live cards only — there is nothing to close otherwise. */}
        {live && onCloseSession && (
          <button
            onClick={() => {
              if (!confirmingClose) {
                setConfirmingClose(true)
                closeTimerRef.current = setTimeout(() => setConfirmingClose(false), 2500)
                return
              }
              if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
              setConfirmingClose(false)
              onCloseSession()
            }}
            title={confirmingClose
              ? `Click again to close the ${role.name} session — the lane and its config stay`
              : `Close the ${role.name} session (the lane stays)`}
            aria-label={confirmingClose ? `Confirm closing ${role.name} session` : `Close ${role.name} session`}
            data-close-session={confirmingClose ? 'confirm' : 'idle'}
            style={{
              flexShrink: 0, height: 20, padding: confirmingClose ? '0 6px' : 0,
              width: confirmingClose ? undefined : 20,
              display: 'grid', placeItems: 'center', border: 'none', borderRadius: 4,
              background: confirmingClose ? 'var(--overlay-medium)' : 'transparent',
              color: confirmingClose ? 'var(--fg)' : 'var(--fg-muted)',
              cursor: 'pointer', outline: 'none',
              fontFamily: 'var(--font-mono)', fontSize: confirmingClose ? 9 : 12,
              letterSpacing: confirmingClose ? '0.06em' : undefined,
              textTransform: confirmingClose ? 'uppercase' : undefined,
            }}
          >{confirmingClose ? 'stop?' : '■'}</button>
        )}
        {/* The coordinator is the roster's hub — the lane that routes to every other. Removing
            it would leave the roster with no dispatcher, so it's kept (workers stay removable). */}
        {!coordinator && !live && (
          // DELETING A LANE IS DESTRUCTIVE and this ✕ used to do it in one unguarded click:
          // it removes the lane's whole configuration — model, effort, accent, charter — and
          // unassigns every task pointing at it. Reported as "I closed the active agent, it
          // disappeared everywhere, can't add it anymore", because on a LIVE card ✕ reads as
          // "close this session", not "delete this lane".
          //
          // So the two verbs stop sharing a glyph: a LIVE card carries no delete control at
          // all (deleting a running lane would leave its pty with nothing in the roster to
          // represent it — an orphan; stop it first), and on an idle card the click arms a
          // confirm that names what is lost. Same click-again-to-confirm idiom as closing a
          // session, which was already the better guarded of the two despite being the less
          // destructive action.
          <button
            onClick={() => {
              if (!confirmingRemove) {
                setConfirmingRemove(true)
                removeTimerRef.current = setTimeout(() => setConfirmingRemove(false), 2500)
                return
              }
              if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
              setConfirmingRemove(false)
              onRemove()
            }}
            title={confirmingRemove
              ? `Click again to delete the ${role.name} lane: its model, effort, colour and charter go${queued > 0 ? `, and ${queued} queued task${queued > 1 ? 's' : ''} return to the backlog` : ''}`
              : `Delete the ${role.name} lane`}
            aria-label={confirmingRemove ? `Confirm deleting ${role.name}` : `Delete ${role.name}`}
            data-role-remove={confirmingRemove ? 'confirm' : 'idle'}
            style={{
              flexShrink: 0, width: confirmingRemove ? 26 : 20, height: 20, padding: 0,
              display: 'grid', placeItems: 'center', border: 'none', borderRadius: 4,
              // Armed = a TRANSPARENT ERROR TINT plus full-strength ink, not a solid fill.
              // The solid --color-error this first carried broke the no-fills-for-state rule
              // and measured 2.81:1 on 1984-light — unreadable on the one control where
              // misreading it destroys a lane. Same treatment as the chat Stop button, and
              // for the same measured reason. The ink is --fg (the highest-contrast token),
              // and the glyph changes ✕ → ✕?, so the state is carried three ways without a
              // fill. The border stays constant: a colour-CHANGING border on a radiused
              // element is the WKWebView repaint trap.
              background: confirmingRemove ? 'color-mix(in srgb, var(--color-error, #f85149) 18%, transparent)' : 'transparent',
              color: confirmingRemove ? 'var(--fg)' : 'var(--fg-muted)',
              cursor: 'pointer', outline: 'none', fontSize: 12,
            }}
          >{confirmingRemove ? '✕?' : '✕'}</button>
        )}
      </div>

      {/* Status row — the live badge (RUNNING/WAITING/…), the queued-count chip, and the
          coordinator tag. Rendered only when there's something to say, so a plain idle card
          stays quiet. */}
      {(live || queued > 0 || coordinator) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
          {live && (
            <span title="This lane has a live session" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: accent, border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`, borderRadius: 6, padding: '2px 6px' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent }} />
              {/* The phase, not a generic "live" — running/compacting/waiting is the
                  actual answer to "who's doing what right now". */}
              {phase && phase !== 'idle' ? phase : 'live'}
            </span>
          )}
          {queued > 0 && (
            <span title={`${queued} queued task${queued > 1 ? 's' : ''} for this agent`} style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px' }}>
              {queued} queued
            </span>
          )}
          {coordinator && (
            <span title="Operator — runs the roster: routes work to the other lanes, does it itself when none fits" style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: accent, opacity: 0.85 }}>
              operates
            </span>
          )}
        </div>
      )}

      {/* MIDDLE — what the live lane is working on, clamped to two lines. The per-lane token
          readout that used to sit here is HIDDEN for now: it priced attention it didn't earn
          on a board about who's doing what, not spend. (formatTokens + the usage plumbing are
          left in place; the Usage & cost view still reports it.) */}
      {live && runningTask && (
        <div style={{ marginTop: 9 }}>
          <span title={runningTask} style={{
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            fontSize: 11, lineHeight: 1.4, color: 'var(--fg-muted)',
          }}>
            ▸ {runningTask}
          </span>
        </div>
      )}

      {/* BOTTOM — compact controls, pinned to the card's base so actions line up across a row.
          Captions are omitted: with the alternatives dimmed, the lit value IS the answer. */}
      <div style={{ marginTop: 'auto', paddingTop: 12 }}>
        {/* Model + worktree. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Segmented
            options={ROSTER_MODELS.map((m) => ({ id: m.id, label: m.label }))}
            value={resolved.model}
            pinned={origins.model === 'pinned'}
            inheritedFrom={ORIGIN_LABEL[origins.model]}
            onChange={(id) => onPatch({ model: id })}
            onClear={() => onPatch({ model: undefined })}
            accent={accent}
          />
          {/* WORKTREE — genuinely tri-state, because `false` is a choice ("do not isolate this
              lane"), not an absence. It used to be `!role.useWorktree`: an unconditional boolean, so
              the first click pinned the lane forever with no route back to inherit. The cycle is
              inherit → on → off → inherit, and the three states LOOK different — a control that
              reads the same inherited-on as pinned-on is what makes a global setting look broken. */}
          <button
            data-worktree-toggle={wt}
            onClick={() => onPatch({ useWorktree: nextWorktreeState(wt) })}
            title={wt === 'inherit'
              ? `Worktree: inherited (${resolved.useWorktree ? 'on' : 'off'}) from your Agents defaults. Click to pin it on for this lane.`
              : wt === 'on'
                ? 'Worktree: pinned ON for this lane. Click to pin it off.'
                : 'Worktree: pinned OFF for this lane. Click to go back to inheriting your Agents default.'}
            aria-pressed={wt === 'inherit' ? undefined : wt === 'on'}
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 7px', borderRadius: 5,
              border: 'none',
              background: wt === 'on' ? `color-mix(in srgb, ${accent} 12%, transparent)` : 'transparent',
              // Off state recedes by TOKEN only — an opacity on top of --fg-muted is the
              // stacked-fade bug (same rule as Segmented above). An INHERITED lane sits in the
              // muted ink whichever way it resolves: the accent means "you chose this".
              // laneTextColor, NOT the raw accent: measured 1.07–1.22:1 at this size on the three
              // light palettes (a pre-existing collapse this control shared with the segments).
              color: wt === 'on' ? laneTextColor(accent) : CONTROL_OFF,
              cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.03em',
            }}
          >
            {/* Pinned-on = filled. Pinned-off = an empty box with a solid hairline. Inherited = a
                DASHED hairline, filled only if the inherited value is on. */}
            <span data-worktree-state={wt} style={{
              width: 9, height: 9, borderRadius: 2, flexShrink: 0,
              border: wt === 'on'
                ? '1px solid transparent'
                : `1px ${wt === 'inherit' ? 'dashed' : 'solid'} var(--fg-muted)`,
              background: wt === 'on'
                ? accent
                : wt === 'inherit' && resolved.useWorktree ? 'var(--fg-muted)' : 'transparent',
            }} />
            worktree
          </button>
        </div>
        {/* Effort + primary action. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {/* Effort has the SAME weight as the model — it is the other spend dial, and the one
              users forget. Never tucked behind a disclosure. */}
          <Segmented
            options={EFFORTS.map((e) => ({ id: e.id as string, label: e.label }))}
            value={resolved.effort}
            pinned={origins.effort === 'pinned'}
            inheritedFrom={ORIGIN_LABEL[origins.effort]}
            onChange={(id) => onPatch({ effort: id as Role['effort'] })}
            onClear={() => onPatch({ effort: undefined })}
            accent={accent}
          />
          {live ? (
            <button onClick={onView} className="actions-footer-btn" style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 14px' }} title={`View the live ${role.name} session`}>View →</button>
          ) : (
            <button
              onClick={onLaunch}
              className="actions-footer-btn is-primary"
              style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 14px' }}
              // The RESOLVED model, not `role.model` — an inherited lane has none of its own, and
              // "(undefined)" in a tooltip is how a working cascade reads as a bug.
              title={queued > 0 ? `Launch ${role.name} and start its ${queued} queued task${queued > 1 ? 's' : ''}` : `Launch a ${role.name} session (${resolved.model})`}
            >
              {queued > 0 ? `Launch ${queued} →` : 'Launch →'}
            </button>
          )}
        </div>

        {/* The lane's standing charter — appended to its system prompt at launch. Demoted to a
            tiny disclosure so it no longer eats a full line per card: the affordance carries
            the text in its tooltip; clicking expands the editor in place (blur saves, Esc
            cancels). */}
        <div style={{ marginTop: 10 }}>
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
              title={promptPreview ? `${promptPreview}\n\nClick to edit this lane's charter` : 'Add a standing charter for this lane'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none',
                padding: 0, cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 9,
                letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)',
              }}
            >
              <svg width="6" height="8" viewBox="0 0 6 8" fill="none" style={{ display: 'block' }}>
                <path d="M1 1l3 3-3 3" stroke="var(--fg-muted)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {promptPreview ? 'charter' : '+ charter'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Shared height for every row in the READY list, including "+ Add agent" — the whole point
 *  is that they read as one family of quiet, launchable things. */
const ROW_H = 34
/** ONE left edge for the whole column. The section label, a lane row's first ink (its orb)
 *  and "+ Add agent"'s text all start here; before this they started at 2px, 26px and 12px
 *  respectively, which is what read as ragged. */
const COLUMN_INSET = 10
/** The rows draw a 1px border and the section label does not, so aligning their INK means
 *  the label carries that pixel too. Measured, not guessed — the driver asserts ink edges. */
const ROW_BORDER = 1

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 9.5, textTransform: 'uppercase',
      letterSpacing: '0.16em', color: 'var(--fg-muted)', margin: `0 0 8px ${COLUMN_INSET + ROW_BORDER}px`,
    }}>
      {children}
    </div>
  )
}

/** A template, as a one-click card in the empty state. Shows what you'd be adding — the
 *  model and effort it pins, and the first line of its charter — because "Code" alone doesn't
 *  say why you'd pick it. No accent FILL; the lane's colour rides its dot, as everywhere else. */
function PresetCard({ preset, onClick }: { preset: Role; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const accent = preset.accent || 'var(--accent)'
  const model = ROSTER_MODELS.find((m) => m.id === preset.model)?.label ?? preset.model
  const effort = EFFORTS.find((e) => e.id === (preset.effort ?? 'high'))?.label ?? 'High'
  const gist = (preset.prompt ?? '').split(/(?<=[.!?])\s/)[0] ?? ''
  return (
    <button
      data-preset={preset.id}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Add a ${preset.name} lane — ${model}, ${effort} effort`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'stretch',
        padding: '10px 12px', textAlign: 'left', cursor: 'pointer', outline: 'none',
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
        background: hover ? 'var(--overlay-medium)' : 'var(--overlay-subtle)',
        fontFamily: 'inherit', transition: 'background 120ms ease',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preset.name}
        </span>
        <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)' }}>
          {model} · {effort}
        </span>
      </span>
      {gist && (
        <span style={{
          fontSize: 11, lineHeight: 1.45, color: 'color-mix(in srgb, var(--fg) 72%, transparent)',
          display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden',
        }}>
          {gist}
        </span>
      )}
    </button>
  )
}

/** "+ Add agent" once the board is populated. Same height and quiet weight as the rows it
 *  sits among; clicking opens the same templates the empty state offers, so there is one way
 *  to add a lane, not two. Falls back to a plain blank-lane button when every preset is
 *  already on the board. */
function AddAgentControl({ presets, onAddPreset, onAddBlank }: {
  presets: Role[]
  onAddPreset: (p: Role) => void
  onAddBlank: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        data-add-agent
        onClick={() => (presets.length ? setOpen((v) => !v) : onAddBlank())}
        title="Add an agent lane"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          height: ROW_H, padding: `0 ${COLUMN_INSET}px`, boxSizing: 'border-box', cursor: 'pointer',
          border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', background: open ? 'var(--overlay-subtle)' : 'transparent',
          color: open ? 'var(--fg)' : 'var(--fg-muted)', outline: 'none', fontFamily: 'inherit', fontSize: 11,
          transition: 'background 120ms ease, color 120ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)'; e.currentTarget.style.color = 'var(--fg)' }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-muted)' } }}
      >
        + Add agent
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: ROW_H + 4, left: 0, zIndex: 40, minWidth: 240, maxHeight: 300, overflowY: 'auto',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg-surface)',
          boxShadow: '0 10px 32px rgba(0,0,0,0.35)', padding: '3px 0',
        }}>
          {presets.map((p) => {
            const model = ROSTER_MODELS.find((m) => m.id === p.model)?.label ?? p.model
            return (
              <button
                key={p.id}
                data-preset={p.id}
                onClick={() => { onAddPreset(p); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '6px 11px', background: 'transparent', border: 'none', outline: 'none',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.accent || 'var(--accent)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg)' }}>{p.name}</span>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)' }}>{model}</span>
              </button>
            )
          })}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 3, paddingTop: 3 }}>
            <button
              onClick={() => { onAddBlank(); setOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                padding: '6px 11px', background: 'transparent', border: 'none', outline: 'none',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, color: 'var(--fg-muted)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              Blank lane…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** An idle lane, at one row. It has to answer "what is this lane" (name + pinned model and
 *  effort, so you can pick one without opening it) and "start it" — nothing else. Everything
 *  editable lives behind the ⌄, which swaps in the full RoleCard. */
function LaneRow({
  role, coordinator, queued = 0, selected, onToggleSelect, onExpand,
  onDragStart, onDragEnd, onPickAccent, onLaunch,
}: {
  role: Role
  coordinator?: boolean
  queued?: number
  selected?: boolean
  onToggleSelect?: () => void
  onExpand: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onPickAccent?: (anchor: { top: number; left: number }) => void
  onLaunch: () => void
}) {
  const [hover, setHover] = useState(false)
  const accent = role.accent || 'var(--accent)'
  const effort = EFFORTS.find((e) => e.id === (role.effort ?? 'high'))?.label ?? 'High'
  const model = ROSTER_MODELS.find((m) => m.id === role.model)?.label ?? role.model

  return (
    <div
      data-roster-row={role.id}
      // THE ROW IS THE DRAG HANDLE. A grip that is invisible at rest must not reserve space
      // at rest — the old one cost 10px + the row's 8px gap permanently, which is what pushed
      // every lane name off the column's left edge for an affordance you couldn't see. The
      // sidebar's lane rows already work this way (their wrapper owns the drag, no grip), so
      // this makes the two surfaces agree rather than adding a third pattern. It also needs no
      // gutter, which the 6px-inset sidebar doesn't have. Grips stay on RoleCard, where a box
      // full of inputs and selectable text genuinely needs its drag surface carved out — and
      // where the grip is always visible, so its 10px buys something.
      draggable={!!onDragStart}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.() }}
      onDragEnd={() => onDragEnd?.()}
      onClick={(e) => {
        // Buttons only. Testing for [draggable] here would now match the ROW itself, so every
        // click would bail out and selection would silently stop working.
        if ((e.target as HTMLElement).closest('button')) return
        onToggleSelect?.()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${role.name} — ${model}, ${effort} effort`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        // One column edge: this padding puts the orb at COLUMN_INSET, where the section label
        // and "+ Add agent" also start.
        height: ROW_H, padding: `0 ${COLUMN_INSET}px`, boxSizing: 'border-box',
        borderRadius: 'var(--radius-md)', cursor: 'pointer',
        // Same quiet weight as "+ Add agent": a 1px border that never changes colour, with
        // state carried by the background. Selection adds the card's faint tint + inset ring.
        border: '1px solid var(--border)',
        background: selected
          ? `color-mix(in srgb, ${accent} 10%, var(--overlay-subtle))`
          : hover ? 'var(--overlay-subtle)' : 'transparent',
        boxShadow: selected ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 55%, transparent)` : 'none',
        transition: 'background 120ms ease',
      }}
    >
      <span
        data-accent-orb={role.id}
        title={onPickAccent ? `${role.name} — right-click to recolour` : undefined}
        onContextMenu={onPickAccent && ((e) => {
          e.preventDefault(); e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          onPickAccent({ top: r.bottom + 6, left: r.left })
        })}
        style={{ width: 10, flexShrink: 0, display: 'grid', placeItems: 'center' }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent }} />
      </span>

      <span data-lane-name style={{
        flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: 'var(--fg)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {role.name}
      </span>

      {/* The pinned config, still readable without opening anything — it's how you tell one
          lane from another when they're all just rows. */}
      <span data-lane-config style={{
        flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-muted)',
      }}>
        {model} · {effort}{role.useWorktree ? ' · worktree' : ''}
      </span>

      {queued > 0 && (
        <span title={`${queued} queued task${queued > 1 ? 's' : ''} for this agent`} style={{
          flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--fg-muted)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px',
        }}>
          {queued} queued
        </span>
      )}
      {coordinator && (
        <span title="Operator — runs the roster: routes work to the other lanes, does it itself when none fits" style={{
          flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: accent,
        }}>
          operates
        </span>
      )}

      <button
        onClick={(e) => { e.stopPropagation(); onExpand() }}
        title={`Configure ${role.name}`}
        aria-label={`Configure ${role.name}`}
        style={{
          flexShrink: 0, width: 18, height: 18, padding: 0, display: 'grid', placeItems: 'center',
          border: 'none', background: 'transparent', color: 'var(--fg-muted)',
          cursor: 'pointer', outline: 'none', fontSize: 9,
          opacity: hover ? 1 : 0, transition: 'opacity 120ms ease',
        }}
      >▾</button>
      <button
        onClick={(e) => { e.stopPropagation(); onLaunch() }}
        className="actions-footer-btn is-primary"
        style={{ flexShrink: 0, fontSize: 10, padding: '3px 11px' }}
        title={queued > 0
          ? `Launch ${role.name} and start its ${queued} queued task${queued > 1 ? 's' : ''}`
          : `Launch a ${role.name} session (${model})`}
      >
        {queued > 0 ? `Launch ${queued} →` : 'Launch →'}
      </button>
    </div>
  )
}

// A compact segmented control (transparent tint, accent for the active segment — no fills).
/** A row of choices that reads as a VALUE, not as four equal options.
 *
 *  Six cards × (4 models + 3 efforts) put 42 equally-weighted words on this board, which
 *  is why it read as noise. The alternatives are still one click away, but they recede;
 *  the chosen one carries the LANE's colour, so scanning the column tells you each lane's
 *  model without reading a label. The container border is gone — a box inside a card
 *  inside a list was one nesting level too many.
 *
 *  The recede is the TOKEN, never a stacked opacity: `--fg-muted × 0.4` measured 1.8–2.9:1
 *  across the six palettes (invisible on the light three), and because the brighten was a
 *  per-button opacity, only the one pill under the cursor ever came back — the other three
 *  sat there reading as disabled. Unselected pills now rest at CONTROL_OFF (see its note: a
 *  control's label is body text, not meta) and hover swaps the token to `--fg`. See the
 *  muted-opacity rule; this is its third recurrence. */
/** Where a resolved value came from, in words the card can print. */
const ORIGIN_LABEL: Record<ConfigOrigin, string> = {
  pinned: 'pinned on this lane',
  global: 'your Agents defaults',
  project: "this project's defaults",
  preset: 'the built-in preset',
  fallback: 'the fallback',
}

/** The lit value is the answer, and its INK says whether you chose it.
 *
 *  accent  = pinned on this lane. Click it again to clear back to inherit — that is the route home,
 *            and it needs no extra chrome on an already-dense card.
 *  muted   = inherited (global default, project default, or the built-in preset). The title names
 *            which. Clicking the lit segment does nothing: there is nothing to clear. */
function Segmented({ options, value, onChange, accent, pinned = true, inheritedFrom, onClear }: {
  options: Array<{ id: string; label: string }>
  value: string
  onChange: (id: string) => void
  accent?: string
  /** False = this value is inherited, so it is drawn in muted ink rather than the lane accent. */
  pinned?: boolean
  /** Human-readable source, for the title. */
  inheritedFrom?: string
  /** Clear the pin back to inherit. Absent = no route home (a control with no inherit state). */
  onClear?: () => void
}) {
  // Same reason as the worktree toggle: a raw lane accent as 9.5px text collapses on the light
  // palettes; laneTextColor folds in each theme's --lane-ink-blend.
  const tint = accent ? laneTextColor(accent) : 'var(--accent)'
  return (
    <div style={{ display: 'inline-flex', gap: 1, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o.id === value
        // THREE distinct appearances, and they have to be three: the lit value must still read as
        // lit when it is inherited, or nobody can tell which option is selected.
        //   off      → CONTROL_OFF, no wash
        //   inherited → full --fg, no wash (selected, but you didn't choose it)
        //   pinned   → lane accent + a faint wash (you chose this)
        const lit = active && pinned ? tint : active ? 'var(--fg)' : CONTROL_OFF
        return (
          <button
            key={o.id}
            data-segment={o.id}
            data-segment-state={active ? (pinned ? 'pinned' : 'inherited') : 'off'}
            onClick={() => { if (!active) onChange(o.id); else if (pinned) onClear?.() }}
            title={!active
              ? `Switch to ${o.label}`
              : pinned
                ? `${o.label} — pinned on this lane. Click to clear it and inherit instead.`
                : `${o.label} — inherited from ${inheritedFrom ?? 'the default'}. Change it for every project on the Agents → Defaults tab.`}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.03em',
              padding: '2px 7px', borderRadius: 5, cursor: 'pointer', outline: 'none', border: 'none',
              color: lit,
              // An inherited value gets no accent WASH either: the tint is the "you chose this"
              // signal, and washing an inherited one makes the two indistinguishable at a glance.
              background: active && pinned ? `color-mix(in srgb, ${tint} 12%, transparent)` : 'transparent',
              transition: 'color 120ms ease',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = 'var(--fg)' }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = CONTROL_OFF }}
          >{o.label}</button>
        )
      })}
    </div>
  )
}
