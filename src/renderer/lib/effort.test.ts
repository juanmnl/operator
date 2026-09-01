import { describe, it, expect } from 'vitest'
import type { Project, SavedSession } from '../../shared/types'
import {
  EFFORT_LEVELS, EFFORT_OPTIONS, SETTINGS_EFFORT_LEVELS,
  migrateEffort, settingsEffort, effortCode,
  migrateProjectEfforts, migrateSavedEfforts, countLegacyEfforts, isLegacyEffort,
} from './effort'

// `'normal'` appears in this file on purpose and nowhere else in the app but lib/effort: it is the
// value being migrated AWAY from, and a migration with no test is how the last one rotted.
const LEGACY = 'normal' as never

const project = (o: Partial<Project>): Project =>
  ({ id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '', ...o })
const saved = (o: Partial<SavedSession>): SavedSession =>
  ({ key: 'k', cwd: '/p', projectName: 'p', lastActiveAt: '', ...o } as SavedSession)

describe('the ladder', () => {
  it('is the CLI\'s five levels, ascending', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(EFFORT_OPTIONS.map((o) => o.id)).toEqual(EFFORT_LEVELS)
  })

  // The gap that made the bug silent: the flag takes five, the file takes four.
  it('offers settings.json only the four values its enum accepts', () => {
    expect(SETTINGS_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(SETTINGS_EFFORT_LEVELS).not.toContain('max')
  })
})

describe('migrateEffort — normal → medium', () => {
  it('maps the legacy value to medium, not to the fallback', () => {
    expect(migrateEffort(LEGACY)).toBe('medium')
  })

  it('leaves every real level alone', () => {
    for (const level of EFFORT_LEVELS) expect(migrateEffort(level)).toBe(level)
  })

  it('answers undefined for absent or unrecognisable values, so the cascade can decide', () => {
    expect(migrateEffort(undefined)).toBeUndefined()
    expect(migrateEffort(null)).toBeUndefined()
    expect(migrateEffort('')).toBeUndefined()
    expect(migrateEffort('turbo')).toBeUndefined()
  })

  it('is idempotent — running it on its own output changes nothing', () => {
    expect(migrateEffort(migrateEffort(LEGACY))).toBe('medium')
  })
})

describe('settingsEffort — the settings.json clamp', () => {
  // Writing `max` into the file does not error; the file keeps it and Claude Code drops it on the
  // next read. That is the failure this clamp exists to make impossible.
  it('clamps max to xhigh', () => {
    expect(settingsEffort('max')).toBe('xhigh')
  })

  it('passes the four in-enum values through', () => {
    for (const level of SETTINGS_EFFORT_LEVELS) expect(settingsEffort(level)).toBe(level)
  })

  it('never produces a value outside the file\'s enum', () => {
    for (const level of EFFORT_LEVELS) expect(SETTINGS_EFFORT_LEVELS).toContain(settingsEffort(level))
  })
})

describe('effortCode — the sidebar badge', () => {
  it('distinguishes medium from max, which share a first letter', () => {
    expect(effortCode('medium')).toBe('M')
    expect(effortCode('max')).toBe('MAX')
    expect(effortCode('xhigh')).toBe('XH')
  })

  it('gives every level a distinct code', () => {
    const codes = EFFORT_LEVELS.map(effortCode)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('migrateProjectEfforts', () => {
  it('migrates a roster pin', () => {
    const p = project({ roster: [{ id: 'operator', name: 'Operator', effort: LEGACY }] })
    expect(migrateProjectEfforts(p).roster?.[0].effort).toBe('medium')
  })

  it("migrates the project's own default", () => {
    const p = project({ defaults: { model: 'opus', effortLevel: LEGACY } })
    expect(migrateProjectEfforts(p).defaults?.effortLevel).toBe('medium')
    // …and leaves the rest of `defaults` alone.
    expect(migrateProjectEfforts(p).defaults?.model).toBe('opus')
  })

  it('does not touch a lane that never pinned an effort', () => {
    const p = project({ roster: [{ id: 'code', name: 'Code', model: 'opus' }] })
    expect(migrateProjectEfforts(p).roster?.[0]).not.toHaveProperty('effort')
  })

  it('clears a pin to an unrecognisable level rather than leaving it', () => {
    const p = project({ roster: [{ id: 'code', name: 'Code', effort: 'turbo' as never }] })
    expect(migrateProjectEfforts(p).roster?.[0]).not.toHaveProperty('effort')
  })

  // Same contract as clearSeededRoleFields: the hydrate path early-bails on identity.
  it('returns the SAME object when there is nothing to do', () => {
    const p = project({ roster: [{ id: 'code', name: 'Code', effort: 'high' }], defaults: { effortLevel: 'low' } })
    expect(migrateProjectEfforts(p)).toBe(p)
    const migrated = migrateProjectEfforts(project({ roster: [{ id: 'code', name: 'Code', effort: LEGACY }] }))
    expect(migrateProjectEfforts(migrated)).toBe(migrated)
  })
})

describe('migrateSavedEfforts', () => {
  it('migrates the stored level and counts what it touched', () => {
    const out = migrateSavedEfforts([
      saved({ key: 'a', effortLevel: LEGACY }),
      saved({ key: 'b', effortLevel: 'high' }),
      saved({ key: 'c' }),
    ])
    expect(out.migrated).toBe(1)
    expect(out.sessions.map((s) => s.effortLevel)).toEqual(['medium', 'high', undefined])
  })

  it('returns the SAME array when there is nothing to migrate', () => {
    const list = [saved({ effortLevel: 'xhigh' })]
    expect(migrateSavedEfforts(list).sessions).toBe(list)
  })
})

describe('countLegacyEfforts — what the migration actually found', () => {
  it('counts roster pins, project defaults and saved sessions', () => {
    const projects = [
      project({ roster: [{ id: 'operator', name: 'O', effort: LEGACY }, { id: 'design', name: 'D', effort: LEGACY }] }),
      project({ id: 'q', defaults: { effortLevel: LEGACY } }),
      project({ id: 'r', roster: [{ id: 'code', name: 'C', effort: 'high' }] }),
    ]
    expect(countLegacyEfforts(projects, [saved({ effortLevel: LEGACY }), saved({ effortLevel: 'low' })])).toBe(4)
  })

  it('is zero once the migration has run', () => {
    const projects = [project({ roster: [{ id: 'operator', name: 'O', effort: LEGACY }] })].map(migrateProjectEfforts)
    expect(countLegacyEfforts(projects, [])).toBe(0)
  })
})

describe('isLegacyEffort', () => {
  it('recognises only the one value Operator used to write', () => {
    expect(isLegacyEffort(LEGACY)).toBe(true)
    for (const level of EFFORT_LEVELS) expect(isLegacyEffort(level)).toBe(false)
    expect(isLegacyEffort(undefined)).toBe(false)
  })
})
