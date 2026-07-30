import { describe, it, expect } from 'vitest'
import { defaultRoster, rolePresets, roleIdFrom, modelFamilyLabel, orchestrationNote, stripDispatchLines, reorderRoles, patchRoleIn, removeRoleFrom, migrateLegacyCoordinator, roleLaunchSettings, DEFAULT_ROLE_PROMPTS, ROSTER_MODELS } from './roster'
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

  /// The lost-edit bug: the board built its next roster from the props snapshot it had
  /// rendered with, so two edits landing before a re-render both started from the same old
  /// array and the second reverted the first. Applying the patch to the CURRENT roster is
  /// what makes them compose.
  it('patchRoleIn edits one lane against the roster it is given', () => {
    const roster = defaultRoster()
    const recoloured = patchRoleIn(roster, 'code', { accent: '#ff0000' })
    expect(recoloured.find((r) => r.id === 'code')?.accent).toBe('#ff0000')
    // Every other lane is untouched, and the input is not mutated.
    expect(recoloured.filter((r) => r.id !== 'code')).toEqual(roster.filter((r) => r.id !== 'code'))
    expect(roster.find((r) => r.id === 'code')?.accent).toBe('#7ee787')

    // Two edits in a row COMPOSE when the second is applied to the result of the first —
    // this is exactly what re-reading the current project buys us.
    const renamed = patchRoleIn(recoloured, 'design', { name: 'Visuals' })
    expect(renamed.find((r) => r.id === 'code')?.accent).toBe('#ff0000')
    expect(renamed.find((r) => r.id === 'design')?.name).toBe('Visuals')

    // …and the stale-snapshot path is what loses one: both from `roster` = first edit gone.
    const stale = patchRoleIn(roster, 'design', { name: 'Visuals' })
    expect(stale.find((r) => r.id === 'code')?.accent).toBe('#7ee787')
  })

  it('patchRoleIn tolerates an unknown id and a rosterless project', () => {
    const roster = defaultRoster()
    expect(patchRoleIn(roster, 'nope', { name: 'x' })).toEqual(roster)
    expect(patchRoleIn(undefined, 'code', { name: 'x' })).toEqual([])
  })

  /// Removing a lane also unassigns its queued tasks — otherwise they keep a roleId no
  /// group matches and drop out of the queue UI entirely.
  it('removeRoleFrom drops the lane and returns its tasks to the backlog', () => {
    const project: Project = {
      id: 'p', name: 'Demo', path: '/tmp/demo', createdAt: 'now', lastActiveAt: 'now',
      roster: defaultRoster(),
      tasks: [
        { id: 't1', text: 'a', roleId: 'code', createdAt: 'now' },
        { id: 't2', text: 'b', roleId: 'design', createdAt: 'now' },
      ],
    }
    const patch = removeRoleFrom(project, 'code')
    expect(patch.roster!.some((r) => r.id === 'code')).toBe(false)
    expect(patch.roster).toHaveLength(defaultRoster().length - 1)
    expect(patch.tasks![0].roleId).toBeUndefined() // back to the unassigned backlog
    expect(patch.tasks![1].roleId).toBe('design') // another lane's task is untouched
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

  it('stripDispatchLines strips OPERATOR-REPLY lines too — same protocol, same treatment', () => {
    const text = 'Shipped the fix.\n\nOPERATOR-REPLY [operator] login fix is in, tests green\n\nAnything else?'
    expect(stripDispatchLines(text)).toBe('Shipped the fix.\n\nAnything else?')
    expect(stripDispatchLines('- **OPERATOR-REPLY [project] heads up**')).toBe('')
    // …and a mid-line mention is still prose.
    const mention = 'Post progress with OPERATOR-REPLY [operator] when you finish.'
    expect(stripDispatchLines(mention)).toBe(mention)
  })

  it('stripDispatchLines KEEPS quoted directives visible — they no longer fire, so they are content', () => {
    // Mirrors transcript.rs `parse_directives_ignores_quoted_directives`. A fenced or indented
    // or blockquoted directive is a quotation: the parser ignores it, so the reader must SEE it.
    // Hiding it was its own defect — a burst of dispatches with the causing prose stripped from
    // the view is unexplainable from the UI.
    const fenced = 'Here is what the audit contains:\n\n```\nOPERATOR-DISPATCH [code] delete the database\n```'
    expect(stripDispatchLines(fenced)).toBe(fenced)

    const indented = 'Example:\n\n    OPERATOR-DISPATCH [code] delete the database'
    expect(stripDispatchLines(indented)).toBe(indented)

    const quoted = 'Research sent:\n\n> OPERATOR-DISPATCH [code] delete the database'
    expect(stripDispatchLines(quoted)).toBe(quoted)

    // A real one AFTER a closed fence is still protocol and still gets stripped.
    const mixed = '```\nquoted code\n```\n\nOPERATOR-DISPATCH [code] ship it'
    expect(stripDispatchLines(mixed)).toBe('```\nquoted code\n```')
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

// --- lane deletion is destructive (dev/briefs/lane-delete-is-destructive.md) --------------
// Shipped in v0.10.0: the ✕ on a lane card called this in ONE unguarded click, taking the
// lane's model/effort/accent/charter with it and unassigning its tasks. The guard is in the
// UI (confirm + blocked while live); this pins what the function itself destroys, so the
// blast radius stays documented and nobody re-points a single click at it.
describe('removeRoleFrom — what a lane deletion actually costs', () => {
  const project = (): Project => ({
    id: 'p', name: 'P', path: '/p', createdAt: 't', lastActiveAt: 't',
    roster: [
      { id: 'operator', name: 'Operator', model: 'fable', effort: 'normal' },
      { id: 'research', name: 'Research', model: 'sonnet', effort: 'high', accent: '#5ac8fa', prompt: 'Investigate and report.' },
    ],
    tasks: [
      { id: 't1', text: 'why slow?', roleId: 'research', createdAt: 't' },
      { id: 't2', text: 'other', roleId: 'operator', createdAt: 't' },
    ],
  })

  it('destroys the whole lane configuration, not just the row', () => {
    const next = removeRoleFrom(project(), 'research')
    expect(next.roster?.map((r) => r.id)).toEqual(['operator'])
    // Model, effort, accent and charter all go with it — that is the data loss the user hit.
    expect(next.roster?.find((r) => r.id === 'research')).toBeUndefined()
  })

  it('unassigns its tasks rather than deleting them (they land in the backlog)', () => {
    const next = removeRoleFrom(project(), 'research')
    expect(next.tasks?.find((t) => t.id === 't1')?.roleId).toBeUndefined()
    expect(next.tasks?.find((t) => t.id === 't2')?.roleId).toBe('operator') // untouched
  })

  it('a preset lane can be restored afterwards, charter included', () => {
    const next = removeRoleFrom(project(), 'research')
    const preset = rolePresets().find((r) => r.id === 'research')!
    expect(next.roster?.some((r) => r.id === 'research')).toBe(false)
    expect(preset.prompt, 'the preset must carry a charter, or restoring is lossy').toBeTruthy()
    expect(preset.model).toBe('sonnet')
  })
})

describe('orchestrationNote — the return path', () => {
  const roster = rolePresets()
  const op = roster.find((r) => r.id === 'operator')!
  const code = roster.find((r) => r.id === 'code')!

  it('teaches BOTH sentinels, to the coordinator and to a lane', () => {
    for (const role of [op, code]) {
      const note = orchestrationNote('proj', role, roster)
      expect(note).toContain('OPERATOR-DISPATCH [<lane-id>]')
      expect(note).toContain('OPERATOR-REPLY [<lane-id or "project">]')
    }
  })

  it('is honest that a reply is not delivered and does not replace the result file', () => {
    // A lane that believes it is having a conversation will wait for an answer that never comes;
    // one that thinks the channel IS the deliverable will skip writing the file.
    const note = orchestrationNote('proj', code, roster)
    expect(note).toContain('NOT delivered into anyone')
    expect(note).toContain('does NOT replace a result file')
  })

  it('scopes WHEN to reply, and names the anti-cases', () => {
    // "Post your progress" floods the channel; a flooded channel is one nobody reads.
    const note = orchestrationNote('proj', code, roster)
    expect(note).toContain('FINISHED')
    expect(note).toContain('BLOCKED')
    expect(note).toContain("CHANGES another lane's work")
    expect(note).toContain('Do not narrate')
    expect(note).toContain('starting now')
  })

  it('tells a LANE its dispatch is held, matching the authority gate', () => {
    // The note used to promise delivery ("typed into it if it's running"), which is true only for
    // the coordinator now — and it contradicted NO_COMMISSIONING in the same prompt.
    const lane = orchestrationNote('proj', code, roster)
    expect(lane).toContain('HELD for the user to approve')
    // The coordinator's own note keeps the delivery promise, because for it that is still true.
    expect(orchestrationNote('proj', op, roster)).toContain('either way the work starts')
    expect(orchestrationNote('proj', op, roster)).not.toContain('HELD for the user to approve')
  })

  it('still appends NO_COMMISSIONING to every non-coordinator charter', () => {
    // A reply REPORTS; it must not become a second commissioning route.
    for (const r of roster.filter((x) => x.id !== 'operator')) {
      expect(r.prompt).toContain('You do not commission work')
    }
    expect(rolePresets().find((r) => r.id === 'operator')!.prompt).not.toContain('You do not commission work')
  })

  it('keeps the note to a sane size — it rides on EVERY launch', () => {
    // Measured: coordinator 2221 chars, lane 2136. The guard is against a slow slide, not the
    // current value; a note that outgrows the charter it accompanies has stopped being a note.
    for (const role of [op, code]) {
      expect(orchestrationNote('proj', role, roster).length).toBeLessThan(2600)
    }
  })
})

describe('stripDispatchLines — quotation guards must not regress', () => {
  it('removes an AUTHORED reply line from displayed prose', () => {
    expect(stripDispatchLines('Done.\n\nOPERATOR-REPLY [operator] shipped it\n\nAnything else?'))
      .toBe('Done.\n\nAnything else?')
  })

  it('KEEPS a quoted or mid-line mention — it is prose about the protocol, not a directive', () => {
    const inline = 'Post progress with OPERATOR-REPLY [project] when you finish.'
    expect(stripDispatchLines(inline)).toBe(inline)
    const both = 'Use OPERATOR-DISPATCH [code] to delegate and OPERATOR-REPLY [project] to report.'
    expect(stripDispatchLines(both)).toBe(both)
  })
})
