import { describe, it, expect } from 'vitest'
import { defaultRoster, roleIdFrom, modelFamilyLabel, ROSTER_MODELS } from './roster'

describe('roster', () => {
  it('seeds a default roster with unique ids and valid models', () => {
    const roster = defaultRoster()
    expect(roster.length).toBeGreaterThan(0)
    const ids = roster.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length) // unique — safe as React keys
    const models = new Set<string>(ROSTER_MODELS.map((m) => m.id))
    for (const r of roster) expect(models.has(r.model)).toBe(true)
  })

  it('matches the user framing: Fable orchestrates, Sonnet research, Opus code', () => {
    const roster = defaultRoster()
    const by = (id: string) => roster.find((r) => r.id === id)
    expect(by('orchestrator')?.model).toBe('fable')
    expect(by('research')?.model).toBe('sonnet')
    expect(by('code')?.model).toBe('opus')
  })

  it('roleIdFrom slugs a name and disambiguates collisions', () => {
    const existing = defaultRoster()
    expect(roleIdFrom('Design QA', existing)).toBe('design-qa')
    expect(roleIdFrom('Research', existing)).toBe('research-2') // 'research' already taken
    expect(roleIdFrom('!!!', existing)).toBe('role')
  })

  it('modelFamilyLabel maps aliases and falls back gracefully', () => {
    expect(modelFamilyLabel('fable')).toBe('Fable')
    expect(modelFamilyLabel('opus')).toBe('Opus')
    expect(modelFamilyLabel('claude-x')).toBe('claude-x')
    expect(modelFamilyLabel(undefined)).toBe('—')
  })
})
