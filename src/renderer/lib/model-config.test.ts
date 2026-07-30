import { describe, it, expect } from 'vitest'
import type { Project, Role } from '../../shared/types'
import { rolePresets } from './roster'
import {
  resolveAgentConfig, configOrigins, worktreeStateOf, nextWorktreeState,
  clearSeededRoleFields, clearAllPinnedRoleFields, pinnedFieldCounts, seededFieldCounts,
  pruneGlobals, hasGlobalFor, seedGlobalDefaults, HARD_FALLBACK,
  type GlobalRoleDefaults,
} from './model-config'

const role = (o: Partial<Role> & { id: string }): Role => ({ name: o.id, ...o })
const project = (roster: Role[], defaults?: Project['defaults']): Project =>
  ({ id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '', roster, defaults })

describe('resolveAgentConfig — the cascade', () => {
  it('falls through to the built-in preset when nothing else is set', () => {
    expect(resolveAgentConfig(role({ id: 'operator' }))).toMatchObject({ model: 'fable', effort: 'normal' })
    expect(resolveAgentConfig(role({ id: 'code' }))).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('a lane PIN beats a global, which beats the preset', () => {
    const globals: GlobalRoleDefaults = { code: { model: 'sonnet' } }
    expect(resolveAgentConfig(role({ id: 'code' }), globals).model).toBe('sonnet')
    expect(resolveAgentConfig(role({ id: 'code', model: 'haiku' }), globals).model).toBe('haiku')
  })

  it('reaches the hard fallback only for a lane with no preset at all', () => {
    expect(resolveAgentConfig(role({ id: 'custom-lane' }))).toEqual(HARD_FALLBACK)
  })

  it('is PER FIELD — pinning effort alone still inherits the global model', () => {
    // The bug this ordering exists to prevent: resolving the whole object from the first source
    // that has anything, so one pinned field silently pins the rest.
    const globals: GlobalRoleDefaults = { code: { model: 'sonnet', effort: 'normal' } }
    expect(resolveAgentConfig(role({ id: 'code', effort: 'low' }), globals))
      .toMatchObject({ model: 'sonnet', effort: 'low' })
  })

  it("treats '' as NOT SET, because Project.defaults really stores model: ''", () => {
    expect(resolveAgentConfig(role({ id: 'code', model: '' })).model).toBe('opus')
    expect(resolveAgentConfig(role({ id: 'code' }), { code: { model: '' } }).model).toBe('opus')
    expect(resolveAgentConfig(role({ id: 'code' }), undefined, { model: '', effortLevel: undefined }).effort).toBe('high')
  })

  it('never returns undefined for a field the launch path requires', () => {
    for (const r of [role({ id: 'code' }), role({ id: 'nope' }), role({ id: 'qa', model: '' })]) {
      const c = resolveAgentConfig(r)
      expect(typeof c.model).toBe('string')
      expect(c.model.length).toBeGreaterThan(0)
      expect(['high', 'normal', 'low']).toContain(c.effort)
      expect(typeof c.permissionMode).toBe('string')
      expect(typeof c.useWorktree).toBe('boolean')
    }
  })

  it("keeps the project's saved defaults in the chain (the permission-prompt regression)", () => {
    // Was `roleLaunchSettings`: projects saved with permissionMode 'auto' regressed to prompts
    // because a role-level undefined won.
    expect(resolveAgentConfig(role({ id: 'code' }), undefined, { permissionMode: 'auto', effortLevel: 'normal' }))
      .toMatchObject({ permissionMode: 'auto', effort: 'normal' })
    // A role pin still beats it, and a lane with neither lands on the preset/hard default.
    expect(resolveAgentConfig(role({ id: 'code', effort: 'low', permissionMode: 'bypassPermissions' }), undefined, { permissionMode: 'auto', effortLevel: 'normal' }))
      .toMatchObject({ permissionMode: 'bypassPermissions', effort: 'low' })
    expect(resolveAgentConfig(role({ id: 'qa' }), undefined, undefined))
      .toMatchObject({ permissionMode: 'default', effort: 'high' })
  })

  it('a GLOBAL effort beats the project default, which beats the preset', () => {
    const globals: GlobalRoleDefaults = { qa: { effort: 'low' } }
    expect(resolveAgentConfig(role({ id: 'qa' }), globals, { effortLevel: 'normal' }).effort).toBe('low')
    expect(resolveAgentConfig(role({ id: 'qa' }), {}, { effortLevel: 'normal' }).effort).toBe('normal')
  })
})

describe('useWorktree is TRI-STATE — false is a choice, not an absence', () => {
  const globals: GlobalRoleDefaults = { code: { useWorktree: true } }

  it('absent → inherits the global', () => {
    expect(resolveAgentConfig(role({ id: 'code' }), globals).useWorktree).toBe(true)
  })

  it('EXPLICIT FALSE beats a global true — the bug that would break trust in the feature', () => {
    // A generic truthy check here swallows every deliberate opt-out, and the user's lane keeps
    // isolating after they turned it off.
    expect(resolveAgentConfig(role({ id: 'code', useWorktree: false }), globals).useWorktree).toBe(false)
  })

  it('explicit true beats a global false', () => {
    expect(resolveAgentConfig(role({ id: 'code', useWorktree: true }), { code: { useWorktree: false } }).useWorktree).toBe(true)
  })

  it('defaults to off when neither says anything', () => {
    expect(resolveAgentConfig(role({ id: 'code' })).useWorktree).toBe(false)
  })

  it('the lane control cycles inherit → on → off → inherit, so a pin has a route home', () => {
    // The old `!role.useWorktree` had no `undefined` in its cycle: one click pinned it forever.
    expect(worktreeStateOf(role({ id: 'code' }))).toBe('inherit')
    expect(nextWorktreeState('inherit')).toBe(true)
    expect(worktreeStateOf(role({ id: 'code', useWorktree: true }))).toBe('on')
    expect(nextWorktreeState('on')).toBe(false)
    expect(worktreeStateOf(role({ id: 'code', useWorktree: false }))).toBe('off')
    expect(nextWorktreeState('off')).toBeUndefined()
  })

  it('reports an explicit false as PINNED, not as a fall-through', () => {
    expect(configOrigins(role({ id: 'code', useWorktree: false }), globals).useWorktree).toBe('pinned')
    expect(configOrigins(role({ id: 'code' }), globals).useWorktree).toBe('global')
    expect(configOrigins(role({ id: 'code' }), {}).useWorktree).toBe('fallback')
  })
})

describe("THE USER'S STORY: operator → opus, configured once", () => {
  // "I want from now on, Operator to use Opus instead of Fable. I should be able to config once."
  const globals: GlobalRoleDefaults = { operator: { model: 'opus' } }

  it('every project resolves operator to opus once the global is set', () => {
    const projects = [
      project([role({ id: 'operator' })]),                       // already inheriting
      project([role({ id: 'operator', model: undefined })]),     // same, explicitly
    ]
    for (const p of projects) {
      expect(resolveAgentConfig(p.roster![0], globals, p.defaults).model).toBe('opus')
    }
  })

  it('INCLUDING a project whose stored role still says fable, because it matched the preset', () => {
    // This is the crux. A seeded value is indistinguishable from a pin, so without the migration
    // the global would be ignored forever — which is what "does nothing" looked like.
    const seeded = project([role({ id: 'operator', model: 'fable', effort: 'normal' })])
    expect(resolveAgentConfig(seeded.roster![0], globals).model).toBe('fable') // before
    const cleaned = clearSeededRoleFields(seeded)
    expect(resolveAgentConfig(cleaned.roster![0], globals).model).toBe('opus') // after
  })

  it('but a project that deliberately pinned sonnet KEEPS sonnet', () => {
    const pinned = project([role({ id: 'operator', model: 'sonnet' })])
    const cleaned = clearSeededRoleFields(pinned)
    expect(cleaned.roster![0].model).toBe('sonnet') // untouched by the migration
    expect(resolveAgentConfig(cleaned.roster![0], globals).model).toBe('sonnet')
  })
})

describe('clearSeededRoleFields — the hydrate migration', () => {
  it('clears a field that EQUALS its preset and leaves one that differs', () => {
    const p = project([
      role({ id: 'code', model: 'opus', effort: 'high' }),   // both seeded
      role({ id: 'qa', model: 'haiku', effort: 'high' }),    // model chosen, effort seeded
    ])
    const out = clearSeededRoleFields(p)
    expect(out.roster![0].model).toBeUndefined()
    expect(out.roster![0].effort).toBeUndefined()
    expect(out.roster![1].model).toBe('haiku')
    expect(out.roster![1].effort).toBeUndefined()
  })

  it('is a NO-OP today — the cascade lands on the same value it cleared', () => {
    // This is what makes it safe to run unattended on hydrate.
    for (const preset of rolePresets()) {
      const before = resolveAgentConfig(preset)
      const after = resolveAgentConfig(clearSeededRoleFields(project([preset])).roster![0])
      expect(after).toEqual(before)
    }
  })

  it('is IDEMPOTENT, and returns the same object when there is nothing to do', () => {
    const p = project([role({ id: 'code', model: 'opus' })])
    const once = clearSeededRoleFields(p)
    const twice = clearSeededRoleFields(once)
    expect(twice).toBe(once) // same reference → hydrate can early-bail
    expect(twice).toEqual(once)
  })

  it('never touches a CUSTOM lane, which has no preset to compare against', () => {
    const p = project([role({ id: 'my-lane', model: 'opus', effort: 'high' })])
    expect(clearSeededRoleFields(p)).toBe(p)
  })

  it('leaves a rosterless project alone', () => {
    const p: Project = { id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '' }
    expect(clearSeededRoleFields(p)).toBe(p)
  })

  it('does not touch useWorktree — presets never set it, so there is nothing seeded to undo', () => {
    const p = project([role({ id: 'code', model: 'opus', useWorktree: false })])
    expect(clearSeededRoleFields(p).roster![0].useWorktree).toBe(false)
  })

  it('counts what it would do, for the copy that has to name a number', () => {
    const counts = seededFieldCounts([
      project([role({ id: 'code', model: 'opus', effort: 'high' })]),
      project([role({ id: 'operator', model: 'opus' })]),
    ])
    expect(counts).toEqual({ clear: 2, pinned: 1, projects: 1 })
  })
})

describe('clearAllPinnedRoleFields — the explicit reset', () => {
  it('clears every pin, not only the seeded ones', () => {
    const projects = [
      project([role({ id: 'operator', model: 'opus' }), role({ id: 'code', model: 'fable', effort: 'low' })]),
    ]
    const out = clearAllPinnedRoleFields(projects)
    for (const r of out[0].roster!) {
      expect(r.model).toBeUndefined()
      expect(r.effort).toBeUndefined()
    }
  })

  it('leaves everything else on the role intact', () => {
    const out = clearAllPinnedRoleFields([project([role({ id: 'code', name: 'Code', model: 'opus', accent: '#7ee787', prompt: 'charter', useWorktree: true })])])
    expect(out[0].roster![0]).toMatchObject({ id: 'code', name: 'Code', accent: '#7ee787', prompt: 'charter', useWorktree: true })
  })

  it('returns the same project object when it has no pins', () => {
    const p = project([role({ id: 'code' })])
    expect(clearAllPinnedRoleFields([p])[0]).toBe(p)
  })

  it('counts fields, lanes and projects for the confirm copy', () => {
    expect(pinnedFieldCounts([
      project([role({ id: 'code', model: 'opus', effort: 'low' }), role({ id: 'qa' })]),
      project([role({ id: 'operator', model: 'opus' })]),
      project([role({ id: 'design' })]),
    ])).toEqual({ fields: 3, lanes: 2, projects: 2 })
  })
})

describe('the global store itself', () => {
  it('prunes empty entries so a cleared role stops reading as configured', () => {
    expect(pruneGlobals({ code: { model: '' }, qa: {}, operator: { model: 'opus' } }))
      .toEqual({ operator: { model: 'opus' } })
  })

  it('keeps an explicit useWorktree: false — pruning it would silently drop an opt-out', () => {
    expect(pruneGlobals({ code: { useWorktree: false } })).toEqual({ code: { useWorktree: false } })
  })

  it('hasGlobalFor sees a false worktree as configured', () => {
    expect(hasGlobalFor({ code: { useWorktree: false } }, 'code')).toBe(true)
    expect(hasGlobalFor({ code: {} }, 'code')).toBe(false)
    expect(hasGlobalFor(undefined, 'code')).toBe(false)
  })

  it('seeds only the worktree posture, leaving model and effort to the presets', () => {
    const seed = seedGlobalDefaults()
    for (const g of Object.values(seed)) {
      expect(g.model).toBeUndefined()
      expect(g.effort).toBeUndefined()
      expect(typeof g.useWorktree).toBe('boolean')
    }
    // Lanes that WRITE get isolation; lanes that read and coordinate don't.
    expect(seed.code.useWorktree).toBe(true)
    expect(seed.design.useWorktree).toBe(true)
    expect(seed.operator.useWorktree).toBe(false)
    expect(seed.research.useWorktree).toBe(false)
    // And the seed survives a round-trip through the store's own pruning.
    expect(pruneGlobals(seed)).toEqual(seed)
  })

  it('survives a role-defaults.json round-trip', () => {
    const seed = seedGlobalDefaults()
    expect(JSON.parse(JSON.stringify(seed))).toEqual(seed)
  })
})

describe('configOrigins — what the roster card prints', () => {
  it('names each layer', () => {
    const globals: GlobalRoleDefaults = { code: { effort: 'normal' } }
    const o = configOrigins(role({ id: 'code', model: 'haiku' }), globals, { permissionMode: 'auto' })
    expect(o.model).toBe('pinned')
    expect(o.effort).toBe('global')
    expect(o.permissionMode).toBe('project')
    expect(configOrigins(role({ id: 'code' })).model).toBe('preset')
    expect(configOrigins(role({ id: 'unknown' })).model).toBe('fallback')
  })
})
