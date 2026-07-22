import { describe, it, expect } from 'vitest'
import { defaultRoster, roleIdFrom, modelFamilyLabel, orchestrationNote, stripDispatchLines, reorderRoles, migrateLegacyCoordinator, roleLaunchSettings, DEFAULT_ROLE_PROMPTS, ROSTER_MODELS } from './roster'
import type { Project } from '../../shared/types'

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
    expect(note).toContain('operated by Operator') // a worker lane is operated, not coordinated
    // No charter → no dangling charter line.
    const bare = orchestrationNote('Demo', { ...code, prompt: undefined }, roster)
    expect(bare).not.toContain('Your role charter:')
  })

  it('the coordinator note is self-referential (you ARE Operator) and lists the team', () => {
    const roster = defaultRoster()
    const op = roster.find((r) => r.id === 'operator')!
    const note = orchestrationNote('Demo', op, roster)
    expect(note).toContain('You are Operator — you operate the "Demo" project')
    expect(note).toContain('do it yourself') // the no-lane-fits fallback
    expect(note).toContain('id: code') // the team is listed with dispatchable ids
    expect(note).not.toContain('operated by Operator') // it doesn't refer to itself in 3rd person
  })

  it('a legacy roster keyed on the old "orchestrator" id still gets the Operator framing', () => {
    const legacy = [{ id: 'orchestrator', name: 'Orchestrator', model: 'fable', prompt: 'x' }, ...defaultRoster().filter((r) => r.id !== 'operator')]
    const note = orchestrationNote('Demo', legacy[0], legacy)
    expect(note).toContain('You are Operator')
  })

  it('reorderRoles moves a lane before/after another', () => {
    const ids = (rs: ReturnType<typeof defaultRoster>) => rs.map((r) => r.id)
    const roster = defaultRoster() // operator, research, code, review, design, qa
    // Drag DOWNWARD: the target index must be recomputed after the removal, or the
    // moved lane lands one slot short of the drop line.
    expect(ids(reorderRoles(roster, 'operator', 'code', 'after'))).toEqual(['research', 'code', 'operator', 'review', 'design', 'qa'])
    // Drag UPWARD.
    expect(ids(reorderRoles(roster, 'qa', 'research', 'before'))).toEqual(['operator', 'qa', 'research', 'code', 'review', 'design'])
  })

  it('reorderRoles is a no-op for unknown ids or a self-drop', () => {
    const roster = defaultRoster()
    expect(reorderRoles(roster, 'code', 'code', 'before')).toBe(roster)
    expect(reorderRoles(roster, 'nope', 'code', 'before')).toBe(roster)
    expect(reorderRoles(roster, 'code', 'nope', 'after')).toBe(roster)
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

  it('stripDispatchLines also strips markdown-decorated directives (mirrors the Rust parser)', () => {
    const text = 'Plan:\n\n- **OPERATOR-DISPATCH [code] fix it**\n`OPERATOR-DISPATCH [qa] verify it`\n2. OPERATOR-DISPATCH [design] polish it\n\nAll dispatched.'
    expect(stripDispatchLines(text)).toBe('Plan:\n\nAll dispatched.')
  })

  it('modelFamilyLabel maps aliases and falls back gracefully', () => {
    expect(modelFamilyLabel('fable')).toBe('Fable')
    expect(modelFamilyLabel('opus')).toBe('Opus')
    expect(modelFamilyLabel('claude-x')).toBe('claude-x')
    expect(modelFamilyLabel(undefined)).toBe('—')
  })
})

describe('migrateLegacyCoordinator', () => {
  const base = (over: Partial<Project>): Project => ({
    id: 'p', path: '/p', name: 'P', createdAt: 't', lastActiveAt: 't', ...over,
  })

  it('renames the legacy lane (id + stock name) and remaps stored references', () => {
    const p = base({
      roster: [{ id: 'orchestrator', name: 'Orchestrator', model: 'fable' }, { id: 'code', name: 'Code', model: 'opus' }],
      tasks: [{ id: 't1', text: 'x', roleId: 'orchestrator', createdAt: 't' }, { id: 't2', text: 'y', roleId: 'code', createdAt: 't' }],
      dispatches: [{ id: 'd1', at: 't', fromRoleId: 'orchestrator', toRoleId: 'code', task: 'z', outcome: 'sent' }],
    })
    const m = migrateLegacyCoordinator(p)
    expect(m.roster![0]).toMatchObject({ id: 'operator', name: 'Operator' })
    expect(m.tasks!.map((t) => t.roleId)).toEqual(['operator', 'code'])
    expect(m.dispatches![0].fromRoleId).toBe('operator')
    expect(m.dispatches![0].toRoleId).toBe('code')
  })

  it('keeps a user-customized coordinator name while still migrating the id', () => {
    const p = base({ roster: [{ id: 'orchestrator', name: 'Boss', model: 'fable' }] })
    const m = migrateLegacyCoordinator(p)
    expect(m.roster![0]).toMatchObject({ id: 'operator', name: 'Boss' })
  })

  it('is a reference-preserving no-op for already-migrated projects', () => {
    const p = base({ roster: defaultRoster() })
    expect(migrateLegacyCoordinator(p)).toBe(p)
    const bare = base({})
    expect(migrateLegacyCoordinator(bare)).toBe(bare) // no roster at all
  })

  it('does not collide when both ids somehow exist — only the stock name refreshes', () => {
    const p = base({
      roster: [{ id: 'operator', name: 'Operator', model: 'fable' }, { id: 'orchestrator', name: 'Orchestrator', model: 'fable' }],
      tasks: [{ id: 't1', text: 'x', roleId: 'orchestrator', createdAt: 't' }],
    })
    const m = migrateLegacyCoordinator(p)
    expect(m.roster!.map((r) => r.id)).toEqual(['operator', 'orchestrator']) // ids untouched
    expect(m.roster![1].name).toBe('Operator')
    expect(m.tasks![0].roleId).toBe('orchestrator') // reference still resolves to its lane
  })
})

describe('roleLaunchSettings', () => {
  it('falls back to the project defaults when the role does not pin a mode', () => {
    // The regression: projects saved with permissionMode 'auto' were launching lanes
    // with permission prompts because the role-level undefined won.
    const role = { id: 'code', name: 'Code', model: 'opus' }
    expect(roleLaunchSettings(role, { permissionMode: 'auto', effortLevel: 'normal' }))
      .toEqual({ permissionMode: 'auto', effortLevel: 'normal' })
  })

  it('role pins beat project defaults; hard defaults apply when neither pins', () => {
    const role = { id: 'code', name: 'Code', model: 'opus', effort: 'low' as const, permissionMode: 'bypassPermissions' }
    expect(roleLaunchSettings(role, { permissionMode: 'auto', effortLevel: 'normal' }))
      .toEqual({ permissionMode: 'bypassPermissions', effortLevel: 'low' })
    expect(roleLaunchSettings({ id: 'qa', name: 'QA', model: 'sonnet' }, undefined))
      .toEqual({ permissionMode: 'default', effortLevel: 'high' })
  })
})
