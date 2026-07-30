import { useMemo, useState } from 'react'
import type { AgentSession, Project, Role } from '../../../shared/types'
import { StatusWave } from '../sidebar/StatusWave'
import { sessionWaveStatus } from '../../lib/session-status'
import { sessionLabel } from '../../lib/session-label'
import { modelFamilyLabel } from '../../lib/roster'
import { resolveAgentConfig } from '../../lib/model-config'
import { queuedCountsByRole } from '../../lib/task-lifecycle'
import { laneTextColor } from '../../lib/lane-color'
import { AgentLibraryView } from './AgentLibraryView'
import { AgentDefaultsView } from './AgentDefaultsView'
import type { GlobalRoleDefaults } from '../../lib/model-config'
import { PageShell } from '../settings/PageShell'

interface AgentsHubProps {
  projects: Project[]
  /** The live, per-terminal sessions (= DashboardView's allSidebarSessions). */
  sessions: AgentSession[]
  accentOf: (s: AgentSession) => string | undefined
  customNames: Record<string, string>
  onFocusSession: (s: AgentSession) => void
  onLaunchRole: (project: Project, role: Role) => void
  onOpenProject: (projectId: string) => void
  /** The GLOBAL per-role launch defaults, and the two verbs that change them. Absent = the
   *  Defaults tab isn't offered (nothing can be edited, so nothing pretends to be). */
  roleDefaults?: GlobalRoleDefaults
  onPatchRoleDefault?: (roleId: string, patch: GlobalRoleDefaults[string]) => void
  onResetPinnedRoleFields?: () => void
}

// The phase word shown on an active card — the same quiet vocabulary as the sidebar.
const PHASE_LABEL: Record<string, string> = {
  running: 'running', compacting: 'compacting', waiting: 'your turn', idle: 'idle', ended: 'ended', error: 'error',
}

type Group = { project: Project; active: AgentSession[]; passive: Role[]; queued: Record<string, number> }

export function AgentsHubView({ projects, sessions, accentOf, customNames, onFocusSession, onLaunchRole, onOpenProject, roleDefaults, onPatchRoleDefault, onResetPinnedRoleFields }: AgentsHubProps) {
  const [tab, setTab] = useState<'fleet' | 'library' | 'defaults'>('fleet')
  // The Defaults tab answers "how are they configured" beside "what is running" — one place called
  // Agents, reachable from the rail before any project is scoped. That reachability is the reason
  // it lives here and not in Preferences.
  const canEditDefaults = !!onPatchRoleDefault

  const { groups, liveCount, queuedTotal, queuedLanes } = useMemo(() => {
    // A launched session counts as "active"; an ended one falls back to its lane being idle.
    const live = sessions.filter((s) => s.status !== 'ended')
    const liveKeys = new Set(live.filter((s) => s.roleId && s.projectId).map((s) => `${s.projectId}:${s.roleId}`))

    const activeByProject = new Map<string, AgentSession[]>()
    for (const s of live) {
      const key = s.projectId ?? `name:${s.projectName}`
      const arr = activeByProject.get(key) ?? []
      arr.push(s)
      activeByProject.set(key, arr)
    }

    const groups: Group[] = []
    let queuedTotal = 0
    let queuedLanes = 0
    for (const p of projects) {
      const active = activeByProject.get(p.id) ?? []
      const passive = (p.roster ?? []).filter((r) => !liveKeys.has(`${p.id}:${r.id}`))
      const counts = queuedCountsByRole(p.tasks)
      for (const r of p.roster ?? []) {
        const n = counts[r.id] ?? 0
        if (n > 0) { queuedTotal += n; queuedLanes += 1 }
      }
      if (active.length || passive.length) groups.push({ project: p, active, passive, queued: counts })
    }
    // Live sessions whose project isn't in the roster list (scratch folders, legacy) —
    // still surface them so the hub is a TRUE global view, just with no idle lanes.
    for (const [key, active] of activeByProject) {
      if (projects.some((p) => p.id === key)) continue
      const name = active[0]?.projectName || 'Other'
      groups.push({ project: { id: key, path: '', name, createdAt: '', lastActiveAt: '' }, active, passive: [], queued: {} })
    }
    // Busiest projects first, then alphabetical.
    groups.sort((a, b) => b.active.length - a.active.length || a.project.name.localeCompare(b.project.name))
    return { groups, liveCount: live.length, queuedTotal, queuedLanes }
  }, [projects, sessions])

  return (
    <PageShell
      title="Agents"
      subtitle="Your teams, across every project. Who is on each one, what they are built for, and who is in play."
      measure="grid"
      tabs={[
        { id: 'fleet', label: 'Fleet' },
        ...(canEditDefaults ? [{ id: 'defaults', label: 'Defaults' }] : []),
        { id: 'library', label: 'Subagent library' },
      ]}
      active={tab}
      onSelectTab={(id) => setTab(id as 'fleet' | 'library' | 'defaults')}
      // The library is a split pane that scrolls its own two columns; the fleet is a card
      // grid that wants the page scroller. See PageShell's `scroll` prop.
      scroll={tab === 'library' ? 'child' : 'page'}
    >
      {tab === 'defaults' ? (
        <AgentDefaultsView
          defaults={roleDefaults ?? {}}
          onPatch={(roleId, patch) => onPatchRoleDefault?.(roleId, patch)}
          projects={projects}
          onResetPinned={() => onResetPinnedRoleFields?.()}
        />
      ) : tab === 'fleet' ? (
        // PageShell owns the scroller and the measure (grid = 1100), so this is content only.
        <>
          {/* THE ROLL-UP, counting comparable things.
              It used to read `2 LIVE AGENTS · 76 IDLE LANES · 13 PROJECTS`. The 76 was
              13 projects × ~6 seeded roles — an artifact of seeding, not a fact about anyone's
              work, and it dwarfed the number that mattered. "Idle lanes" is not a quantity worth
              a headline: a team having members who aren't currently talking is the normal state.
              What IS worth counting is work nobody has picked up. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            <RollupChip n={liveCount} label={liveCount === 1 ? 'in play' : 'in play'} />
            <RollupChip
              n={queuedTotal}
              label={queuedTotal === 1 ? 'task waiting' : 'tasks waiting'}
              hint={queuedLanes ? `across ${queuedLanes} agent${queuedLanes === 1 ? '' : 's'}` : undefined}
            />
            <RollupChip n={groups.length} label={groups.length === 1 ? 'team' : 'teams'} />
          </div>

          {groups.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center' }}>
              <p style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                No agents yet. Open a project and launch a lane to see it here.
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.project.id} style={{ marginBottom: 26 }}>
                {/* ONE heading level. There used to be three — project, then ACTIVE, then IDLE
                    LANES — for what is often a single row and a few identical ones, and projects
                    with nothing live skipped ACTIVE entirely so the rhythm broke every few
                    sections. The cards say which state they are in; a subhead saying it again is
                    chrome that only shows up sometimes. */}
                <button
                  onClick={() => g.project.path && onOpenProject(g.project.id)}
                  disabled={!g.project.path}
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, padding: 0,
                    background: 'none', border: 'none', cursor: g.project.path ? 'pointer' : 'default',
                    fontFamily: 'inherit', color: 'var(--fg)', outline: 'none', textAlign: 'left',
                  }}
                  title={g.project.path ? 'Open project workspace' : undefined}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{g.project.name}</span>
                  <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>
                    {g.active.length ? `${g.active.length} in play · ` : ''}{g.active.length + g.passive.length} agent{g.active.length + g.passive.length === 1 ? '' : 's'}
                  </span>
                </button>

                {/* ONE grid, live first. Same card, two states — see AgentCard. */}
                <Grid>
                  {g.active.map((s) => {
                    const role = s.roleId ? g.project.roster?.find((r) => r.id === s.roleId) : undefined
                    const label = sessionLabel({ session: s, role, customName: customNames[s.id] })
                    const status = sessionWaveStatus(s)
                    const cfg = role ? resolveAgentConfig(role, roleDefaults, g.project.defaults) : undefined
                    return (
                      <AgentCard
                        key={s.id}
                        name={label}
                        accent={accentOf(s)}
                        seed={s.id}
                        status={status}
                        phase={PHASE_LABEL[status] ?? status}
                        // The session's OWN model wins here: it is what the transcript says is
                        // actually running, which can differ from the lane's configured default
                        // after a mid-session /model switch.
                        model={modelFamilyLabel(s.model) !== '—' ? modelFamilyLabel(s.model) : (cfg ? modelFamilyLabel(cfg.model) : '')}
                        effort={cfg?.effort}
                        worktree={cfg?.useWorktree}
                        task={s.summary}
                        queued={role ? (g.queued[role.id] ?? 0) : 0}
                        onClick={() => onFocusSession(s)}
                        actionLabel="focus"
                      />
                    )
                  })}
                  {g.passive.map((r) => {
                    const cfg = resolveAgentConfig(r, roleDefaults, g.project.defaults)
                    return (
                      <AgentCard
                        key={r.id}
                        name={r.name}
                        accent={r.accent}
                        seed={r.id}
                        status="idle"
                        // RESOLVED, not the raw pinned field. `modelFamilyLabel(role.model)`
                        // returned an em dash for every lane that inherits its model, which is
                        // most of them — that is the `_` that read as missing data. A lane always
                        // resolves to a model; showing the cascade's answer is both truthful and
                        // the end of the dash.
                        model={modelFamilyLabel(cfg.model)}
                        effort={cfg.effort}
                        worktree={cfg.useWorktree}
                        queued={g.queued[r.id] ?? 0}
                        onClick={() => onLaunchRole(g.project, r)}
                        actionLabel="launch"
                      />
                    )
                  })}
                </Grid>
              </section>
            ))
          )}
        </>
      ) : (
        <AgentLibraryView embedded />
      )}
    </PageShell>
  )
}

// (The local Tab component is gone — PageShell owns the tab bar now.)

function RollupChip({ n, label, hint }: { n: number; label: string; hint?: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '5px 11px',
      borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--overlay-subtle)',
    }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      {hint && (
        <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{hint}</span>
      )}
    </span>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', gap: 8, marginBottom: 14 }}>
      {children}
    </div>
  )
}

/** ONE card, TWO states — not two card components.
 *
 *  The brief asks whether a live agent and an idle one are different cards or one card in two
 *  states. One card, and the reason is the diagnosis itself: "97% of the pixels go to things that
 *  aren't happening" was possible precisely BECAUSE `ActiveCard` and `PassiveCard` were separate
 *  layouts that happened to look alike. A character sheet does not change shape when the character
 *  stops acting — you should recognise the same agent whether it is in play or on the bench, and
 *  the difference should be what is FILLED IN, not where things are.
 *
 *  So the anatomy is constant:
 *    orb + name       identity. The orb is a CIRCLE carrying the lane accent (shape vocabulary is
 *                     load-bearing: a circle is an agent, a rounded square is a project), and the
 *                     name is `laneTextColor`, never a raw accent.
 *    loadout          model · effort · worktree — the "class and stats". Always present, always
 *                     resolved through the cascade, so a card is worth looking at at rest.
 *    live line        phase + current task. EARNED by being live; absent otherwise, rather than
 *                     drawn as an empty placeholder.
 *    queued           work waiting on this agent. The most actionable thing this view can show
 *                     and it was absent entirely.
 *
 *  Idle recedes by TOKEN — a muted name and a static orb — never by a group `opacity`, which
 *  compounds, halves contrast and can't be overridden per child. That rule exists because of a
 *  previous idle-card fade.
 *
 *  Motion: the orb is the only animated thing and `StatusWave` already animates ONLY
 *  running/compacting, so a roster of idle agents is completely still. */
function AgentCard({ name, accent, seed, status, phase, model, effort, worktree, task, queued, onClick, actionLabel }: {
  name: string
  accent?: string
  seed: string
  status: ReturnType<typeof sessionWaveStatus>
  phase?: string
  model: string
  effort?: string
  worktree?: boolean
  task?: string
  queued: number
  onClick: () => void
  actionLabel: 'focus' | 'launch'
}) {
  const [hover, setHover] = useState(false)
  const live = actionLabel === 'focus'
  // The loadout, in one line. Worktree only when ON: "no worktree" is the absence of a property,
  // not a stat worth a slot — and once the default flips on for most lanes, printing both states
  // would put a word on every card that distinguishes nothing.
  const loadout = [model, effort ? effort[0].toUpperCase() + effort.slice(1) : null, worktree ? 'worktree' : null]
    .filter(Boolean).join(' · ')
  return (
    <button
      data-agent-card={seed}
      data-agent-live={live ? '' : undefined}
      onClick={onClick}
      title={live ? 'Focus this session' : `Launch ${name}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 7, padding: '11px 12px', width: '100%',
        textAlign: 'left', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
        // A live card sits on the surface; an idle one is transparent until you point at it. Both
        // keep the same hairline, so the grid stays a grid.
        background: live || hover ? 'var(--overlay-subtle)' : 'transparent',
        cursor: 'pointer', fontFamily: 'inherit', outline: 'none',
        transition: 'background 120ms ease',
      }}
    >
      {/* Identity row. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', minWidth: 0 }}>
        <span style={{ flexShrink: 0, display: 'flex' }}>
          <StatusWave status={status} seed={seed} size={20} accent={accent} />
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
          color: accent ? laneTextColor(accent) : 'var(--fg)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {name}
        </span>
        {/* Queued work — a transparent badge, never a solid fill. Drawn only when there IS work,
            so a card with no badge means nothing is waiting rather than "zero". */}
        {queued > 0 && (
          <span data-agent-queued={queued} title={`${queued} task${queued === 1 ? '' : 's'} waiting for this agent`} style={{
            flexShrink: 0, padding: '1px 6px', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--status-compacting) 12%, transparent)',
            fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.06em',
            // MIXED toward --fg, not the raw token. `--status-compacting` is tuned for a status
            // ORB — a filled dot, where hue is the whole message — and as 9px text it measured
            // 2.58 / 2.53 / 1.54 on the three light palettes, i.e. the most actionable thing on
            // the card was the least legible. At 45% it reads 4.74–12.43. Same correction, same
            // reason, as the channel's ACCENT_INK and WARN_INK.
            color: 'color-mix(in srgb, var(--status-compacting) 45%, var(--fg))',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {queued} queued
          </span>
        )}
      </div>

      {/* The loadout — class and stats, at rest. This is what makes an idle card worth reading;
          it used to be a lone em dash, which read as missing data rather than as a roster entry. */}
      <div style={{
        width: '100%', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.03em',
        color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {loadout}
      </div>

      {/* EARNED by being live: what it is doing, and what it is doing it about. */}
      {live && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, width: '100%', minWidth: 0 }}>
          <span style={{
            flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: accent ? laneTextColor(accent) : 'var(--fg-muted)',
          }}>
            {phase}
          </span>
          {task && (
            <span style={{
              flex: 1, minWidth: 0, fontSize: 11, color: 'color-mix(in srgb, var(--fg) 78%, transparent)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {task}
            </span>
          )}
        </div>
      )}

      {/* The verb, on hover only, and it reserves no space at rest — the row IS the control. */}
      {!live && (
        <span style={{
          alignSelf: 'flex-start', fontFamily: 'var(--font-mono)', fontSize: 9,
          textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--fg-muted)',
          opacity: hover ? 1 : 0, transition: 'opacity 120ms ease', height: 0, lineHeight: 1,
        }}>
          launch ▷
        </span>
      )}
    </button>
  )
}
