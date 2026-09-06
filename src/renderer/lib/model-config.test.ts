import { describe, it, expect } from 'vitest'
import type { Project, Role } from '../../shared/types'
import { rolePresets } from './roster'
import { EFFORT_LEVELS } from './effort'
import {
  resolveAgentConfig, worktreeStateOf, clearSeededRoleFields, clearCoordinatorWorktree,
  migrateGlobalsToLanePins, HARD_FALLBACK,
  remoteControlLaunch,
  type LegacyGlobalDefaults,
} from './model-config'

const role = (o: Partial<Role> & { id: string }): Role => ({ name: o.id, ...o })
const project = (roster: Role[], defaults?: Project['defaults']): Project =>
  ({ id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '', roster, defaults })

describe('resolveAgentConfig — two altitudes', () => {
  it('falls through to the built-in preset when the lane pins nothing', () => {
    expect(resolveAgentConfig(role({ id: 'operator' }))).toMatchObject({ model: 'fable', effort: 'medium' })
    expect(resolveAgentConfig(role({ id: 'code' }))).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('a lane PIN beats the preset', () => {
    expect(resolveAgentConfig(role({ id: 'code' })).model).toBe('opus')
    expect(resolveAgentConfig(role({ id: 'code', model: 'haiku' })).model).toBe('haiku')
  })

  it('reaches the hard fallback only for a lane with no preset at all', () => {
    expect(resolveAgentConfig(role({ id: 'custom-lane' }))).toEqual(HARD_FALLBACK)
  })

  it('is PER FIELD — pinning effort alone still takes its model from the preset', () => {
    // The bug this ordering exists to prevent: resolving the whole object from the first source
    // that has anything, so one pinned field silently pins the rest.
    expect(resolveAgentConfig(role({ id: 'code', effort: 'low' })))
      .toMatchObject({ model: 'opus', effort: 'low' })
  })

  it("treats '' as NOT SET, because Project.defaults really stores model: ''", () => {
    expect(resolveAgentConfig(role({ id: 'code', model: '' })).model).toBe('opus')
  })

  it('never returns undefined for a field the launch path requires', () => {
    for (const r of [role({ id: 'code' }), role({ id: 'nope' }), role({ id: 'qa', model: '' })]) {
      const c = resolveAgentConfig(r)
      expect(typeof c.model).toBe('string')
      expect(c.model.length).toBeGreaterThan(0)
      expect(EFFORT_LEVELS).toContain(c.effort)
      expect(typeof c.permissionMode).toBe('string')
      expect(typeof c.useWorktree).toBe('boolean')
    }
  })

  it('a lane pin still carries permission mode (the permission-prompt regression)', () => {
    expect(resolveAgentConfig(role({ id: 'code', effort: 'low', permissionMode: 'bypassPermissions' })))
      .toMatchObject({ permissionMode: 'bypassPermissions', effort: 'low' })
    expect(resolveAgentConfig(role({ id: 'qa' }))).toMatchObject({ permissionMode: 'default', effort: 'high' })
  })
})

describe('useWorktree is TRI-STATE — false is a choice, not an absence', () => {
  it('absent → inherits the preset, which is where the posture now lives', () => {
    expect(resolveAgentConfig(role({ id: 'code' })).useWorktree).toBe(true)
    expect(resolveAgentConfig(role({ id: 'qa' })).useWorktree).toBe(false)
  })

  it('EXPLICIT FALSE beats a preset true — the bug that would break trust in the feature', () => {
    // A generic truthy check here swallows every deliberate opt-out, and the user's lane keeps
    // isolating after they turned it off.
    expect(resolveAgentConfig(role({ id: 'code', useWorktree: false })).useWorktree).toBe(false)
  })

  it('explicit true beats a preset false', () => {
    expect(resolveAgentConfig(role({ id: 'qa', useWorktree: true })).useWorktree).toBe(true)
  })

  it('defaults to off for a lane with no preset to inherit from', () => {
    expect(resolveAgentConfig(role({ id: 'custom' })).useWorktree).toBe(false)
  })

  it('the lane control reads inherit / on / off, so a pin has a route home', () => {
    expect(worktreeStateOf(role({ id: 'code' }))).toBe('inherit')
    expect(worktreeStateOf(role({ id: 'code', useWorktree: true }))).toBe('on')
    expect(worktreeStateOf(role({ id: 'code', useWorktree: false }))).toBe('off')
  })

  it('EVERY writing WORKER lane still isolates, which is what the deleted global seed used to do', () => {
    // The posture moved from `seedGlobalDefaults()` onto the presets. If it had not, all six
    // would have fallen to the hard fallback (off) the moment the global tier was removed.
    //
    // `operator` USED TO BE IN THIS LIST and was deliberately taken out on 2026-08-05: the
    // coordinator merges lane branches, reaps worktrees and launches every other lane, so doing
    // that from a checkout of its own is how work went missing. See the coordinator cases below.
    const on = (id: string) => resolveAgentConfig(role({ id })).useWorktree
    expect([on('code'), on('design'), on('research')]).toEqual([true, true, true])
    expect([on('review'), on('qa')]).toEqual([false, false])
  })

  // THE COORDINATOR IS NOT A CASCADE. Every other field ranks pin over preset; this one ignores
  // the pin outright, because a preset change alone would have fixed only the lanes that never
  // expressed an opinion — and five real projects have `useWorktree: true` PERSISTED from when
  // the preset said so.
  it('a coordinator NEVER gets a worktree, whatever is pinned on it', () => {
    expect(resolveAgentConfig(role({ id: 'operator' })).useWorktree).toBe(false)
    expect(resolveAgentConfig(role({ id: 'operator', useWorktree: true })).useWorktree).toBe(false)
    // The legacy id migrates to `operator`, but a roster restored from a backup can still carry
    // it — so the rule is keyed on `isCoordinator`, which knows both.
    expect(resolveAgentConfig(role({ id: 'orchestrator', useWorktree: true })).useWorktree).toBe(false)
  })

  it('and a WORKER lane keeps both of its answers — the override is not a blanket', () => {
    expect(resolveAgentConfig(role({ id: 'code', useWorktree: false })).useWorktree).toBe(false)
    expect(resolveAgentConfig(role({ id: 'review', useWorktree: true })).useWorktree).toBe(true)
  })
})

describe('clearCoordinatorWorktree — the backfill for the 5 persisted `true`s', () => {
  it('DELETES the pin rather than writing false — nobody chose it, a preset wrote it', () => {
    const out = clearCoordinatorWorktree(project([role({ id: 'operator', useWorktree: true })]))
    expect('useWorktree' in out.roster![0]).toBe(false)
  })

  it('clears a persisted `false` too — the field is not offered, so no value on it is honest', () => {
    const out = clearCoordinatorWorktree(project([role({ id: 'operator', useWorktree: false })]))
    expect('useWorktree' in out.roster![0]).toBe(false)
  })

  it('leaves WORKER lanes alone, both true and false', () => {
    const out = clearCoordinatorWorktree(project([
      role({ id: 'code', useWorktree: true }),
      role({ id: 'review', useWorktree: false }),
    ]))
    expect(out.roster!.map((r) => r.useWorktree)).toEqual([true, false])
  })

  it('returns the SAME object when there is nothing to do, so hydrate can early-bail', () => {
    const p = project([role({ id: 'operator' }), role({ id: 'code', useWorktree: true })])
    expect(clearCoordinatorWorktree(p)).toBe(p)
    // …and is idempotent: a second pass over a cleared roster finds nothing.
    const once = clearCoordinatorWorktree(project([role({ id: 'operator', useWorktree: true })]))
    expect(clearCoordinatorWorktree(once)).toBe(once)
  })

  it('leaves a rosterless project alone', () => {
    const p = { id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '' } as Project
    expect(clearCoordinatorWorktree(p)).toBe(p)
  })
})

describe('migrateGlobalsToLanePins — collapsing three altitudes to two', () => {
  // THE PROPERTY THAT MATTERS: after the migration, every lane resolves to exactly what it
  // resolved to before the global tier was deleted. Everything else here is a detail of how.
  const legacyResolveForTest = (r: Role, g: LegacyGlobalDefaults | undefined, d: Project['defaults']) => {
    const preset = rolePresets().find((p) => p.id === r.id)
    const gg = g?.[r.id]
    const set = <T>(v: T | undefined | null): v is T => v !== undefined && v !== null && v !== ''
    const setBool = (v: boolean | undefined | null): v is boolean => v !== undefined && v !== null
    return {
      model: [r.model, gg?.model, preset?.model].find(set) ?? HARD_FALLBACK.model,
      effort: [r.effort, gg?.effort, d?.effortLevel, preset?.effort].find(set) ?? HARD_FALLBACK.effort,
      permissionMode: [r.permissionMode, gg?.permissionMode, d?.permissionMode, preset?.permissionMode].find(set) ?? HARD_FALLBACK.permissionMode,
      useWorktree: [r.useWorktree, gg?.useWorktree].find(setBool) ?? HARD_FALLBACK.useWorktree,
    }
  }

  it('NO LANE CHANGES ITS EFFECTIVE CONFIG — across a matrix of stores and rosters', () => {
    const stores: Array<LegacyGlobalDefaults | undefined> = [
      undefined,
      {},
      { operator: { model: 'opus' } },                                     // the user's story
      { code: { useWorktree: true }, qa: { useWorktree: false } },         // the shipped seed
      { operator: { useWorktree: false }, research: { useWorktree: false } }, // the pre-flip seed
      { qa: { model: 'haiku', effort: 'low', permissionMode: 'auto', useWorktree: true } },
      { code: { model: 'opus' } },                                        // agrees with the preset
    ]
    const rosters: Role[][] = [
      rolePresets().map((p) => ({ ...p })),                               // fully seeded (legacy)
      rolePresets().map((p) => role({ id: p.id })),                       // fully inheriting
      [role({ id: 'code', model: 'haiku' }), role({ id: 'qa', effort: 'low' }), role({ id: 'operator', useWorktree: false })],
      [role({ id: 'custom-lane' })],                                      // no preset at all
      [],
    ]
    const defaultsList: Array<Project['defaults']> = [
      undefined, { model: '', effortLevel: 'low' }, { permissionMode: 'auto', effortLevel: 'medium' },
    ]

    for (const globals of stores) {
      for (const roster of rosters) {
        for (const defaults of defaultsList) {
          const p = project(roster.map((r) => ({ ...r })), defaults)
          const before = (p.roster ?? []).map((r) => legacyResolveForTest(r, globals, defaults))
          const out = migrateGlobalsToLanePins([p], globals)
          const after = (out.projects[0].roster ?? []).map((r) => resolveAgentConfig(r, defaults))
          // `remoteControl` is excluded, and it is the only field that may be: it did not exist
          // when the legacy cascade did, so there is no "before" for it to be unchanged from —
          // `legacyResolve` reports the fallback precisely because nothing used to write it.
          // Comparing it would assert that a NEW feature changed nothing, which is backwards.
          // Every field the migration is actually about is still compared exactly.
          const drop = (c: Record<string, unknown>) => { const { remoteControl: _rc, ...rest } = c; return rest }
          expect(after.map((c) => drop(c as unknown as Record<string, unknown>)))
            .toEqual(before.map((c) => drop(c as unknown as Record<string, unknown>)))
        }
      }
    }
  })

  it('writes ZERO permissionMode pins — the project is its source in BOTH cascades now', () => {
    // F1. permissionMode's only source was `Project.defaults`, and the collapse removed it from
    // the new cascade; the migration then papered over that by pinning it onto 37 real lanes —
    // pins no screen can edit — while a NEW project got no such cover and silently stopped
    // honouring the project's permission mode. Restoring the project as the source fixes both
    // ends, and makes the migration a no-op for this field BY CONSTRUCTION rather than by a
    // special case: both cascades read the same value, so comparing them finds nothing.
    const p = project([role({ id: 'code' }), role({ id: 'qa' })], { permissionMode: 'auto' })
    const out = migrateGlobalsToLanePins([p], { code: { useWorktree: true }, qa: { useWorktree: false } })
    expect(out.pins).toBe(0)
    expect(out.projects[0].roster!.every((r) => r.permissionMode === undefined)).toBe(true)
    // …and the project's mode still reaches the launch.
    expect(resolveAgentConfig(out.projects[0].roster![0], p.defaults).permissionMode).toBe('auto')
  })

  it('a NEW project honours its permission mode with no migration in sight', () => {
    // The case the migration could never cover, because it has already run.
    expect(resolveAgentConfig(role({ id: 'code' }), { permissionMode: 'auto' }).permissionMode).toBe('auto')
    expect(resolveAgentConfig(role({ id: 'code' })).permissionMode).toBe('default')
    // A lane pin still wins, and is still the only per-lane override.
    expect(resolveAgentConfig(role({ id: 'code', permissionMode: 'bypassPermissions' }), { permissionMode: 'auto' }).permissionMode)
      .toBe('bypassPermissions')
  })

  it('is MINIMAL — a global that agrees with the preset writes no pin at all', () => {
    // Pinning everything would be easier and would also mean no future preset change could ever
    // reach anyone. `code`'s preset is already opus, and its worktree posture already true.
    const p = project([role({ id: 'code' })])
    const out = migrateGlobalsToLanePins([p], { code: { model: 'opus', useWorktree: true } })
    expect(out.pins).toBe(0)
    expect(out.projects[0]).toBe(p)          // same reference → hydrate can early-bail
    expect(out.projects[0].roster![0].model).toBeUndefined()
  })

  it('writes the pin when the global DISAGREES with the preset', () => {
    const store = { operator: { model: 'opus', useWorktree: true } }
    const out = migrateGlobalsToLanePins([project([role({ id: 'operator' })])], store)
    expect(out).toMatchObject({ pins: 1, lanes: 1 })
    expect(out.projects[0].roster![0].model).toBe('opus') // preset is fable
  })

  it('pins worktree OFF for a store with no entry for that lane — that WAS the old answer', () => {
    // The old cascade had no preset layer for `useWorktree`: an absent global fell straight to
    // the hard fallback, i.e. off. The preset now says `code` isolates, so preserving what the
    // user actually launched with means writing the `false` down rather than quietly flipping
    // four lanes into worktrees. This is the case that makes "resolve both ways and compare"
    // worth more than pattern-matching the tier.
    const out = migrateGlobalsToLanePins([project([role({ id: 'code' })])], {})
    expect(out.projects[0].roster![0].useWorktree).toBe(false)
  })

  it("carries a project's effort default down, since that layer is gone too", () => {
    const p = project([role({ id: 'qa' })], { effortLevel: 'low' }) // qa's preset effort is high
    const out = migrateGlobalsToLanePins([p], undefined)
    expect(out.projects[0].roster![0].effort).toBe('low')
  })

  it('preserves a deliberate worktree opt-out rather than re-deriving it', () => {
    const p = project([role({ id: 'code', useWorktree: false })])
    const out = migrateGlobalsToLanePins([p], { code: { useWorktree: true } })
    expect(out.pins).toBe(0) // the lane already pinned false; both cascades agree
    expect(resolveAgentConfig(out.projects[0].roster![0]).useWorktree).toBe(false)
  })

  it('is IDEMPOTENT — the second pass has nothing left to write', () => {
    const store = { operator: { model: 'opus', useWorktree: true } }
    const p = project([role({ id: 'operator' })])
    const once = migrateGlobalsToLanePins([p], store)
    const twice = migrateGlobalsToLanePins(once.projects, store)
    expect(twice.pins).toBe(0)
    expect(twice.projects).toBe(once.projects)
  })

  it('leaves a rosterless project, and every other field, alone', () => {
    const bare: Project = { id: 'x', path: '/x', name: 'x', createdAt: '', lastActiveAt: '' }
    expect(migrateGlobalsToLanePins([bare], { code: { model: 'haiku' } }).projects[0]).toBe(bare)
    const out = migrateGlobalsToLanePins(
      [project([role({ id: 'operator', name: 'Operator', accent: '#c98bff', prompt: 'charter' })])],
      { operator: { model: 'opus', useWorktree: true } },
    )
    expect(out.projects[0].roster![0]).toMatchObject({ id: 'operator', name: 'Operator', accent: '#c98bff', prompt: 'charter' })
  })

  it('does not mutate what it was handed', () => {
    const p = project([role({ id: 'operator' })])
    const snapshot = JSON.parse(JSON.stringify(p))
    migrateGlobalsToLanePins([p], { operator: { model: 'opus', useWorktree: true } })
    expect(p).toEqual(snapshot)
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

  it('is a NO-OP for the launch — the cascade lands on the same value it cleared', () => {
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

  it('does not touch useWorktree — a lane\'s opt-out is never "seeded"', () => {
    const p = project([role({ id: 'code', model: 'opus', useWorktree: false })])
    expect(clearSeededRoleFields(p).roster![0].useWorktree).toBe(false)
  })
})

// REMOTE CONTROL — a tri-state pin like `useWorktree`, resolving preset → fallback.
describe('resolveAgentConfig — remoteControl', () => {
  it('is ON for the coordinator by default, and off for every other preset', () => {
    for (const preset of rolePresets()) {
      expect(resolveAgentConfig({ ...preset, remoteControl: undefined }).remoteControl)
        .toBe(preset.id === 'operator')
    }
  })

  it('honours an explicit pin in both directions', () => {
    expect(resolveAgentConfig({ id: 'operator', name: 'Operator', remoteControl: false }).remoteControl).toBe(false)
    expect(resolveAgentConfig({ id: 'code', name: 'Code', remoteControl: true }).remoteControl).toBe(true)
  })

  it('treats `false` as a pin and not as an absence — the tri-state', () => {
    // The bug this shape prevents: `.find(set)` would skip a pinned `false` and fall through to
    // the preset, so turning the coordinator OFF would silently do nothing.
    expect(resolveAgentConfig({ id: 'operator', name: 'Operator', remoteControl: false }).remoteControl)
      .not.toBe(resolveAgentConfig({ id: 'operator', name: 'Operator' }).remoteControl)
  })

  it('falls back to off for a custom lane with no preset', () => {
    expect(resolveAgentConfig({ id: 'custom-lane', name: 'Custom' }).remoteControl).toBe(false)
  })

  it('is not overridden by the coordinator rule that forces useWorktree off', () => {
    // `useWorktree` ignores its pin for a coordinator; `remoteControl` deliberately does not —
    // a coordinator you have turned off stays off.
    const off = resolveAgentConfig({ id: 'operator', name: 'Operator', useWorktree: true, remoteControl: false })
    expect(off.useWorktree).toBe(false)
    expect(off.remoteControl).toBe(false)
  })
})

// The review's blocker 2: the launch path resolved this and the restore path did not, so every
// RESTORED lane wrote `remoteControlAtStartup: false` — including the coordinator, which is the
// one lane the feature exists for and the one a restore ordinarily brings back.
describe('remoteControlLaunch — one resolution, both call sites', () => {
  const proj = (roster: Role[]): Project => ({
    id: 'p1', name: 'operator', path: '/p', createdAt: '', roster,
  } as Project)
  const roster: Role[] = [
    { id: 'operator', name: 'Operator' },
    { id: 'code', name: 'Code' },
  ]

  it('turns it ON for the coordinator and names the session for the project', () => {
    expect(remoteControlLaunch(proj(roster), 'operator'))
      .toEqual({ remoteControl: true, remoteControlName: 'operator · Operator' })
  })

  it('leaves every other role off, with no name to pass', () => {
    expect(remoteControlLaunch(proj(roster), 'code')).toEqual({ remoteControl: false })
  })

  it('honours an explicit OFF pin on the coordinator', () => {
    const off = proj([{ id: 'operator', name: 'Operator', remoteControl: false }])
    expect(remoteControlLaunch(off, 'operator')).toEqual({ remoteControl: false })
  })

  it('honours an explicit ON pin on another role', () => {
    const on = proj([{ id: 'code', name: 'Code', remoteControl: true }])
    expect(remoteControlLaunch(on, 'code').remoteControl).toBe(true)
  })

  it('is off for a lane with no role and for a missing project — never a guess', () => {
    expect(remoteControlLaunch(proj(roster), undefined)).toEqual({ remoteControl: false })
    expect(remoteControlLaunch(undefined, 'operator')).toEqual({ remoteControl: false })
    expect(remoteControlLaunch(proj(roster), 'nobody')).toEqual({ remoteControl: false })
  })
})
