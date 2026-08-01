import { describe, it, expect } from 'vitest'
import type { Project, Role, SavedSession } from '../../shared/types'
import { rolePresets, NO_COMMISSIONING, DEFAULT_ROLE_PROMPTS } from './roster'
import { clearSeededRoleFields } from './model-config'
import { isStockLane, laneHasHistory, stockPrompts, seededIdleLaneCounts, pruneSeededIdleLanes } from './prune-seeded-lanes'

/** A lane exactly as seeding left it. */
const seeded = (id: string, over: Partial<Role> = {}): Role => ({ ...rolePresets().find((r) => r.id === id)!, ...over })

const project = (roster: Role[], over: Partial<Project> = {}): Project =>
  ({ id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '', roster, ...over })

const saved = (o: Partial<SavedSession>): SavedSession =>
  ({ key: 'k', cwd: '/p', projectName: 'p', lastActiveAt: '', ...o })

describe('isStockLane', () => {
  it('accepts a lane straight out of the presets', () => {
    for (const r of rolePresets()) expect(isStockLane(r), r.id).toBe(true)
  })

  it('accepts a lane whose preset-equal fields were already cleared to "inherit"', () => {
    // clearSeededRoleFields runs FIRST on hydrate, so this is the shape the prune actually sees.
    const cleared = clearSeededRoleFields(project(rolePresets()))
    for (const r of cleared.roster!) expect(isStockLane(r), r.id).toBe(true)
  })

  it('accepts the charter as it read before NO_COMMISSIONING was appended', () => {
    const legacy = DEFAULT_ROLE_PROMPTS.code.slice(0, -NO_COMMISSIONING.length)
    expect(legacy).not.toBe(DEFAULT_ROLE_PROMPTS.code)
    expect(isStockLane(seeded('code', { prompt: legacy }))).toBe(true)
  })

  it('accepts both retired coordinator charters, under either coordinator id', () => {
    for (const prompt of stockPrompts('operator')) {
      expect(isStockLane(seeded('operator', { prompt })), prompt.slice(0, 30)).toBe(true)
      expect(isStockLane({ ...seeded('operator'), id: 'orchestrator', prompt })).toBe(true)
    }
    expect(stockPrompts('operator').length).toBeGreaterThan(2) // current + two retired
  })

  it('refuses a lane the user touched, whichever field they touched', () => {
    expect(isStockLane(seeded('code', { name: 'Builder' }))).toBe(false)
    expect(isStockLane(seeded('code', { model: 'haiku' }))).toBe(false)
    expect(isStockLane(seeded('code', { effort: 'low' }))).toBe(false)
    expect(isStockLane(seeded('code', { accent: '#123456' }))).toBe(false)
    expect(isStockLane(seeded('code', { permissionMode: 'plan' }))).toBe(false)
    expect(isStockLane(seeded('code', { agentName: 'my-agent' }))).toBe(false)
    expect(isStockLane(seeded('code', { prompt: 'do it my way' }))).toBe(false)
  })

  it('treats a useWorktree that DIFFERS from the preset as a decision', () => {
    // This used to read "any explicit value is a decision", which was right only while no preset
    // set the field. The one-altitude collapse moved the worktree posture onto the presets, so
    // the test is now whether the lane disagrees with its own — same shape as model and effort.
    expect(isStockLane(seeded('code', { useWorktree: false }))).toBe(false) // code's preset is ON
    expect(isStockLane(seeded('qa', { useWorktree: true }))).toBe(false)    // qa's preset is OFF
    // …and matching the preset is stock, however it got written down.
    expect(isStockLane(seeded('code', { useWorktree: true }))).toBe(true)
    expect(isStockLane(seeded('qa', { useWorktree: false }))).toBe(true)
  })

  it("reads '' as unset, since real stored rosters carry empty strings", () => {
    expect(isStockLane(seeded('code', { model: '', accent: '', permissionMode: '' }))).toBe(true)
  })

  it('never claims a custom lane is stock', () => {
    expect(isStockLane({ id: 'perf', name: 'Perf' })).toBe(false)
  })
})

describe('laneHasHistory', () => {
  const p = project([seeded('code')], {
    tasks: [{ id: 't1', text: 'x', status: 'done', createdAt: '', roleId: 'review' }],
    dispatches: [{ id: 'd1', at: '', toRoleId: 'design', task: 'x', outcome: 'sent' }],
  })

  it('finds a launch, a task at ANY status, or a dispatch in either direction', () => {
    expect(laneHasHistory(p, 'code', [saved({ projectId: 'p', roleId: 'code' })])).toBe(true)
    expect(laneHasHistory(p, 'review', [])).toBe(true) // a completed task still counts
    expect(laneHasHistory(p, 'design', [])).toBe(true)
    expect(laneHasHistory(p, 'qa', [])).toBe(false)
  })

  it('does not count another project\'s session', () => {
    expect(laneHasHistory(p, 'code', [saved({ projectId: 'other', roleId: 'code' })])).toBe(false)
  })
})

describe('pruneSeededIdleLanes', () => {
  it('reduces a project whose six lanes were all seeded and never used to just Operator', () => {
    // Was "empties … to []" before the floor landed (dev/briefs/operator-is-the-floor.md): the
    // migration must never leave a project with no coordinator and therefore no entry point.
    const before = [project(rolePresets())]
    const out = pruneSeededIdleLanes(before, [])
    expect(out.lanes).toBe(5)
    expect(out.touched).toBe(1)
    expect(out.projects[0].roster!.map((r) => r.id)).toEqual(['operator'])
  })

  it('keeps every lane with history, and every lane the user edited', () => {
    const p = project(rolePresets(), {
      tasks: [{ id: 't1', text: 'x', status: 'queued', createdAt: '', roleId: 'review' }],
    })
    p.roster = p.roster!.map((r) => (r.id === 'design' ? { ...r, accent: '#abcdef' } : r))
    const out = pruneSeededIdleLanes([p], [saved({ projectId: 'p', roleId: 'operator' })])
    expect(out.projects[0].roster!.map((r) => r.id)).toEqual(['operator', 'review', 'design'])
    expect(out.lanes).toBe(3)
  })

  it('leaves an untouched project by REFERENCE, so the caller can count rewrites', () => {
    const p = project([seeded('code')], {
      dispatches: [{ id: 'd', at: '', toRoleId: 'code', task: 'x', outcome: 'sent' }],
    })
    const before = [p]
    const out = pruneSeededIdleLanes(before, [])
    expect(out.projects).toBe(before) // same array, and…
    expect(out.projects[0]).toBe(p)   // …the same project object inside it
    expect(out.lanes).toBe(0)
  })

  it('is idempotent — a second run finds nothing left to drop', () => {
    const first = pruneSeededIdleLanes([project(rolePresets())], [])
    const second = pruneSeededIdleLanes(first.projects, [])
    expect(second.lanes).toBe(0)
    expect(second.projects).toBe(first.projects)
  })

  it('never touches a project that already has an empty roster', () => {
    const p = project([])
    expect(pruneSeededIdleLanes([p], []).projects[0]).toBe(p)
  })

  it('counts exactly what it would remove, before removing it', () => {
    const projects = [project(rolePresets()), project(rolePresets(), { id: 'q' })]
    const counts = seededIdleLaneCounts(projects, [])
    const out = pruneSeededIdleLanes(projects, [])
    expect(counts).toEqual({ lanes: out.lanes, projects: out.touched })
  })
})

// --- OPERATOR IS THE FLOOR (dev/briefs/operator-is-the-floor.md) --------------------------
// The prune shipped with no floor: a project whose six lanes were all stock and unused went to
// ZERO. Zero is a dead end rather than a blank canvas — `OPERATOR-DISPATCH [lane] …` addresses a
// lane by id, so an empty roster has no entry point and nothing that can create the others.
describe('the coordinator is never pruned', () => {
  it('takes an all-stock six-lane project to exactly ONE lane, not zero', () => {
    const out = pruneSeededIdleLanes([project(rolePresets())], [])
    expect(out.projects[0].roster!.map((r) => r.id)).toEqual(['operator'])
    expect(out.lanes).toBe(5) // five went; the floor stayed
  })

  it('protects the pre-rename `orchestrator` id too', () => {
    const legacy = { ...seeded('operator'), id: 'orchestrator' }
    const out = pruneSeededIdleLanes([project([legacy, seeded('code')])], [])
    expect(out.projects[0].roster!.map((r) => r.id)).toEqual(['orchestrator'])
  })

  it('leaves a project whose Operator HAS history exactly as it was', () => {
    const p = project([seeded('operator')], {
      tasks: [{ id: 't', text: 'x', status: 'done', createdAt: '', roleId: 'operator' }],
    })
    const out = pruneSeededIdleLanes([p], [])
    expect(out.lanes).toBe(0)
    expect(out.projects[0]).toBe(p) // untouched, by reference
  })

  it('leaves a roster the USER emptied empty — the floor is on the migration, not on them', () => {
    // Deleting lanes by hand is a decision; this migration is not, which is the whole difference.
    const p = project([])
    expect(pruneSeededIdleLanes([p], []).projects[0].roster).toEqual([])
  })

  it('never resurrects Operator into a roster that does not have one', () => {
    // The floor protects a lane that is there; it does not add one. Seeding a NEW project with
    // Operator is a separate decision, made at the creation site (DashboardView upsertProject).
    const out = pruneSeededIdleLanes([project([seeded('code'), seeded('qa')])], [])
    expect(out.projects[0].roster).toEqual([])
  })

  it('COUNTS what it will actually do — a toast promising more than it removes is worse than none', () => {
    const projects = [project(rolePresets()), project(rolePresets(), { id: 'q' })]
    const counts = seededIdleLaneCounts(projects, [])
    const out = pruneSeededIdleLanes(projects, [])
    expect(counts).toEqual({ lanes: out.lanes, projects: out.touched })
    expect(counts.lanes).toBe(10) // 2 projects × 5, NOT 12
  })

  it('is still idempotent with the floor in place', () => {
    const first = pruneSeededIdleLanes([project(rolePresets())], [])
    const second = pruneSeededIdleLanes(first.projects, [])
    expect(second.lanes).toBe(0)
    expect(second.projects).toBe(first.projects)
  })
})
