import { describe, it, expect } from 'vitest'
import { defaultRoster, roleIdFrom, modelFamilyLabel, orchestrationNote, stripDispatchLines, DEFAULT_ROLE_PROMPTS, ROSTER_MODELS } from './roster'

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
    expect(by('operator')?.model).toBe('fable') // the coordinator lane is named for the app
    expect(by('research')?.model).toBe('sonnet')
    expect(by('code')?.model).toBe('opus')
  })

  it('roleIdFrom slugs a name and disambiguates collisions', () => {
    const existing = defaultRoster()
    expect(roleIdFrom('Design QA', existing)).toBe('design-qa')
    expect(roleIdFrom('Research', existing)).toBe('research-2') // 'research' already taken
    expect(roleIdFrom('!!!', existing)).toBe('role')
  })

  it('every default lane ships a standing charter prompt', () => {
    for (const r of defaultRoster()) {
      expect(r.prompt, `role ${r.id} has a prompt`).toBeTruthy()
      expect(r.prompt).toBe(DEFAULT_ROLE_PROMPTS[r.id])
    }
  })

  it('orchestrationNote carries the lane charter and the dispatch protocol', () => {
    const roster = defaultRoster()
    const code = roster.find((r) => r.id === 'code')!
    const note = orchestrationNote('Demo', code, roster)
    expect(note).toContain('Your role charter:')
    expect(note).toContain(code.prompt!.slice(0, 40)) // the charter text itself rides along
    expect(note).toContain('OPERATOR-DISPATCH')
    // No charter → no dangling charter line.
    const bare = orchestrationNote('Demo', { ...code, prompt: undefined }, roster)
    expect(bare).not.toContain('Your role charter:')
  })

  it('the coordinator note is self-referential (you ARE Operator) and lists the team', () => {
    const roster = defaultRoster()
    const op = roster.find((r) => r.id === 'operator')!
    const note = orchestrationNote('Demo', op, roster)
    expect(note).toContain('You are Operator')
    expect(note).toContain('do it yourself') // the no-lane-fits fallback
    expect(note).toContain('id: code') // the team is listed with dispatchable ids
    expect(note).not.toContain('coordinated by Operator') // it doesn't refer to itself in 3rd person
  })

  it('a legacy roster keyed on the old "orchestrator" id still gets the Operator framing', () => {
    const legacy = [{ id: 'orchestrator', name: 'Orchestrator', model: 'fable', prompt: 'x' }, ...defaultRoster().filter((r) => r.id !== 'operator')]
    const note = orchestrationNote('Demo', legacy[0], legacy)
    expect(note).toContain('You are Operator')
  })

  it('stripDispatchLines removes directive lines, keeps the prose', () => {
    const text = 'I split the work.\n\nOPERATOR-DISPATCH [code] fix the parser\nOPERATOR-DISPATCH [qa] add a regression test\n\nBoth lanes are briefed.'
    expect(stripDispatchLines(text)).toBe('I split the work.\n\nBoth lanes are briefed.')
    // A directive-only message strips to empty (the turn is dropped upstream).
    expect(stripDispatchLines('OPERATOR-DISPATCH [code] do x')).toBe('')
    // Prose that merely MENTIONS the protocol mid-line is untouched.
    const mention = 'Use OPERATOR-DISPATCH [lane] to delegate.'
    expect(stripDispatchLines(mention)).toBe(mention)
  })

  it('modelFamilyLabel maps aliases and falls back gracefully', () => {
    expect(modelFamilyLabel('fable')).toBe('Fable')
    expect(modelFamilyLabel('opus')).toBe('Opus')
    expect(modelFamilyLabel('claude-x')).toBe('claude-x')
    expect(modelFamilyLabel(undefined)).toBe('—')
  })
})
