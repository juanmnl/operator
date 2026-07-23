import { useMemo, useState } from 'react'
import type { AgentSession, Project, Role } from '../../../shared/types'
import { StatusWave } from '../sidebar/StatusWave'
import { sessionWaveStatus } from '../../lib/session-status'
import { sessionLabel } from '../../lib/session-label'
import { modelFamilyLabel } from '../../lib/roster'
import { AgentLibraryView } from './AgentLibraryView'

interface AgentsHubProps {
  projects: Project[]
  /** The live, per-terminal sessions (= DashboardView's allSidebarSessions). */
  sessions: AgentSession[]
  accentOf: (s: AgentSession) => string | undefined
  customNames: Record<string, string>
  onFocusSession: (s: AgentSession) => void
  onLaunchRole: (project: Project, role: Role) => void
  onOpenProject: (projectId: string) => void
}

// The phase word shown on an active card — the same quiet vocabulary as the sidebar.
const PHASE_LABEL: Record<string, string> = {
  running: 'running', compacting: 'compacting', waiting: 'your turn', idle: 'idle', ended: 'ended', error: 'error',
}

type Group = { project: Project; active: AgentSession[]; passive: Role[] }

export function AgentsHubView({ projects, sessions, accentOf, customNames, onFocusSession, onLaunchRole, onOpenProject }: AgentsHubProps) {
  const [tab, setTab] = useState<'fleet' | 'library'>('fleet')

  const { groups, liveCount, idleCount } = useMemo(() => {
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
    let idle = 0
    for (const p of projects) {
      const active = activeByProject.get(p.id) ?? []
      const passive = (p.roster ?? []).filter((r) => !liveKeys.has(`${p.id}:${r.id}`))
      idle += passive.length
      if (active.length || passive.length) groups.push({ project: p, active, passive })
    }
    // Live sessions whose project isn't in the roster list (scratch folders, legacy) —
    // still surface them so the hub is a TRUE global view, just with no idle lanes.
    for (const [key, active] of activeByProject) {
      if (projects.some((p) => p.id === key)) continue
      const name = active[0]?.projectName || 'Other'
      groups.push({ project: { id: key, path: '', name, createdAt: '', lastActiveAt: '' }, active, passive: [] })
    }
    // Busiest projects first, then alphabetical.
    groups.sort((a, b) => b.active.length - a.active.length || a.project.name.localeCompare(b.project.name))
    return { groups, liveCount: live.length, idleCount: idle }
  }, [projects, sessions])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-body)', overflow: 'hidden' }}>
      {/* Header + tab switch. */}
      <div style={{ padding: '16px 24px 12px', flexShrink: 0, borderBottom: '1px solid var(--border)', maxWidth: 1100, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        <h2 style={{ fontFamily: 'var(--font-disp)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--fg)', margin: 0 }}>Agents</h2>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '4px 0 12px', opacity: 0.7, lineHeight: 1.6 }}>
          Every agent across your projects — live sessions and the idle lanes waiting to be launched.
        </p>
        <div style={{ display: 'flex', gap: 4 }}>
          <Tab label="Fleet" active={tab === 'fleet'} onClick={() => setTab('fleet')} />
          <Tab label="Subagent library" active={tab === 'library'} onClick={() => setTab('library')} />
        </div>
      </div>

      {tab === 'fleet' ? (
        <div style={{ flex: 1, overflow: 'auto', maxWidth: 1100, width: '100%', margin: '0 auto', boxSizing: 'border-box', padding: '16px 24px 40px' }}>
          {/* Global roll-up. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            <RollupChip n={liveCount} label={liveCount === 1 ? 'live agent' : 'live agents'} />
            <RollupChip n={idleCount} label={idleCount === 1 ? 'idle lane' : 'idle lanes'} />
            <RollupChip n={groups.length} label={groups.length === 1 ? 'project' : 'projects'} />
          </div>

          {groups.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center' }}>
              <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6, lineHeight: 1.7 }}>
                No agents yet. Open a project and launch a lane to see it here.
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.project.id} style={{ marginBottom: 26 }}>
                {/* Project header — click to open its workspace. */}
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
                  <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', opacity: 0.7 }}>
                    {g.active.length} live · {g.passive.length} idle
                  </span>
                </button>

                {g.active.length > 0 && <SubHead>Active</SubHead>}
                <Grid>
                  {g.active.map((s) => {
                    const role = s.roleId ? g.project.roster?.find((r) => r.id === s.roleId) : undefined
                    const label = sessionLabel({ session: s, role, customName: customNames[s.id] })
                    const status = sessionWaveStatus(s)
                    return (
                      <ActiveCard
                        key={s.id}
                        name={label}
                        phase={PHASE_LABEL[status] ?? status}
                        model={modelFamilyLabel(s.model)}
                        status={status}
                        seed={s.id}
                        accent={accentOf(s)}
                        onClick={() => onFocusSession(s)}
                      />
                    )
                  })}
                </Grid>

                {g.passive.length > 0 && <SubHead>Idle lanes</SubHead>}
                <Grid>
                  {g.passive.map((r) => (
                    <PassiveCard
                      key={r.id}
                      name={r.name}
                      model={modelFamilyLabel(r.model)}
                      worktree={!!r.useWorktree}
                      seed={r.id}
                      accent={r.accent}
                      onClick={() => onLaunchRole(g.project, r)}
                    />
                  ))}
                </Grid>
              </section>
            ))
          )}
        </div>
      ) : (
        <AgentLibraryView embedded />
      )}
    </div>
  )
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px', fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.04em',
        textTransform: 'uppercase', cursor: 'pointer', borderRadius: 'var(--radius-sm)', outline: 'none',
        border: '1px solid var(--border)',
        // Surface wash for the active tab — never an accent fill.
        background: active ? 'var(--overlay-medium)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
      }}
    >
      {label}
    </button>
  )
}

function RollupChip({ n, label }: { n: number; label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '5px 11px',
      borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--overlay-subtle)',
    }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    </span>
  )
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--fg-muted)', opacity: 0.7, margin: '2px 0 8px' }}>
      {children}
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', gap: 8, marginBottom: 14 }}>
      {children}
    </div>
  )
}

const cardBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', width: '100%',
  textAlign: 'left', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
  background: 'var(--overlay-subtle)', cursor: 'pointer', fontFamily: 'inherit', outline: 'none',
  transition: 'background 120ms ease',
}

function ActiveCard({ name, phase, model, status, seed, accent, onClick }: {
  name: string; phase: string; model: string; status: ReturnType<typeof sessionWaveStatus>; seed: string; accent?: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title="Focus this session"
      style={cardBase}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-medium)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
    >
      <span style={{ flexShrink: 0, display: 'flex' }}>
        <StatusWave status={status} seed={seed} size={20} accent={accent} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {phase} · {model}
        </div>
      </div>
    </button>
  )
}

function PassiveCard({ name, model, worktree, seed, accent, onClick }: {
  name: string; model: string; worktree: boolean; seed: string; accent?: string; onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title="Launch this lane"
      style={{ ...cardBase, background: hover ? 'var(--overlay-subtle)' : 'transparent' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Idle orb already reads as "dimmed" via the static-accent treatment — no group
          opacity; the name is the only other receded element (muted ink). */}
      <span style={{ flexShrink: 0, display: 'flex' }}>
        <StatusWave status="idle" seed={seed} size={20} accent={accent} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'color-mix(in srgb, var(--fg) 80%, transparent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model}{worktree ? ' · worktree' : ''}
        </div>
      </div>
      <span style={{
        flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--fg-muted)', opacity: hover ? 0.9 : 0, transition: 'opacity 120ms ease',
      }}>
        launch ▷
      </span>
    </button>
  )
}
