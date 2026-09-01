import { describe, it, expect } from 'vitest'
import { defaultRoster, rolePresets, roleIdFrom, modelFamilyLabel, orchestrationNote, stripDispatchLines, reorderRoles, orderByRoster, patchRoleIn, removeRoleFrom, migrateLegacyCoordinator, DEFAULT_ROLE_PROMPTS, ROSTER_MODELS } from './roster'
import type { Project, Role } from '../../shared/types'

describe('roster', () => {
  it('seeds a default roster with unique ids and valid models', () => {
    const roster = defaultRoster()
    expect(roster.length).toBeGreaterThan(0)
    const ids = roster.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length) // unique — safe as React keys
    const models = new Set<string>(ROSTER_MODELS.map((m) => m.id))
    for (const r of roster) expect(models.has(r.model!)).toBe(true) // presets always pin one
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

  /// Removing a lane leaves its tasks NAMING it — see removeRoleFrom for why clearing the
  /// reference made the board's "lane gone" treatment unreachable through the only path to it.
  it('removeRoleFrom drops the lane and leaves its tasks naming it', () => {
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
    // Tasks are not rewritten at all — the patch doesn't carry them.
    expect(patch.tasks).toBeUndefined()
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

// `roleLaunchSettings` moved into `resolveAgentConfig` — its cases live in model-config.test.ts.

// --- lane deletion is destructive (dev/briefs/lane-delete-is-destructive.md) --------------
// Shipped in v0.10.0: the ✕ on a lane card called this in ONE unguarded click, taking the
// lane's model/effort/accent/charter with it and unassigning its tasks. The guard is in the
// UI (confirm + blocked while live); this pins what the function itself destroys, so the
// blast radius stays documented and nobody re-points a single click at it.
describe('removeRoleFrom — what a lane deletion actually costs', () => {
  const project = (): Project => ({
    id: 'p', name: 'P', path: '/p', createdAt: 't', lastActiveAt: 't',
    roster: [
      { id: 'operator', name: 'Operator', model: 'fable', effort: 'medium' },
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

  it('leaves its tasks NAMING the deleted lane, so the board can say so', () => {
    // The old behaviour cleared `roleId`, which made a task filed against Research read as
    // "Unassigned" — as though nobody had ever been asked — and made `AgentChip`'s
    // `research — lane gone` unreachable, since deleting a lane is the only way to produce a
    // dangling roleId at all. Deleting a lane must not delete the record of who it was for.
    const next = removeRoleFrom(project(), 'research')
    expect(next.tasks).toBeUndefined() // the patch does not touch tasks
    // …and applying the patch leaves the original task pointing at a lane no roster holds.
    const after: Project = { ...project(), ...next }
    expect(after.tasks?.find((t) => t.id === 't1')?.roleId).toBe('research')
    expect(after.roster?.some((r) => r.id === 'research')).toBe(false)
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
      // No `or "project"`: broadcasts were dropped with the channel that was their only reader.
      expect(note).toContain('OPERATOR-REPLY [<lane-id>]')
      expect(note).not.toContain('"project"')
    }
  })

  it('is honest that delivery can fail and does not replace the result file', () => {
    // A lane that believes it is having a guaranteed conversation will wait for an answer that
    // never comes; one that thinks the reply IS the deliverable will skip writing the file.
    // The reply IS delivered now (into the addressee's pty) — what it is not is guaranteed, and
    // the brakes deliberately tell the sender nothing.
    const note = orchestrationNote('proj', code, roster)
    expect(note).toContain('Delivery is not guaranteed')
    expect(note).toContain('does NOT replace a result file')
  })

  it('scopes WHEN to reply, and names the anti-cases', () => {
    // "Post your progress" was noise in a room; addressed to one lane it is an interruption.
    const note = orchestrationNote('proj', code, roster)
    expect(note).toContain('FINISHED')
    expect(note).toContain('BLOCKED')
    expect(note).toContain('CHANGES its work')
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
    // Measured: coordinator 2866 chars, lane 2952 — up from 2221/2136 when the artifact-plane
    // protocol was added (2026-08-06). RAISED DELIBERATELY, once, for a stated addition, which is
    // what this guard is for: it caught the first draft at 3138/3349 and that draft was trimmed
    // (an audit anecdote and a task count came out) rather than the ceiling being moved to fit it.
    // The guard is against a slow slide, not the current value; a note that outgrows the charter
    // it accompanies has stopped being a note.
    for (const role of [op, code]) {
      expect(orchestrationNote('proj', role, roster).length).toBeLessThan(3100)
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

// Ordering the STRIP's members by the roster is what makes a lane reorder visible. Without it the
// drag rewrites the durable roster and the rows you dragged do not move — which is how the
// v0.13.7 join broke reordering in a way that looked like nothing at all was wired.
describe('orderByRoster', () => {
  const roster = [{ id: 'operator' }, { id: 'code' }, { id: 'research' }]
  const ids = (list: { roleId?: string; id?: string }[]) => list.map((m) => m.roleId ?? m.id)

  it('puts lane members in roster order', () => {
    const live = [{ roleId: 'research' }, { roleId: 'operator' }, { roleId: 'code' }]
    expect(ids(orderByRoster(live, roster))).toEqual(['operator', 'code', 'research'])
  })

  it('leaves AD-HOC members exactly where they are — lanes fill only the slots lanes had', () => {
    const live = [{ roleId: 'research' }, { id: 'adhoc-1' }, { roleId: 'operator' }, { id: 'adhoc-2' }]
    // Slots 0 and 2 were lanes and stay lanes, now in roster order; slots 1 and 3 are untouched.
    expect(ids(orderByRoster(live, roster))).toEqual(['operator', 'adhoc-1', 'research', 'adhoc-2'])
  })

  it('is a no-op when the members are already in roster order', () => {
    const live = [{ roleId: 'operator' }, { roleId: 'code' }]
    expect(ids(orderByRoster(live, roster))).toEqual(['operator', 'code'])
  })

  it('sorts a member whose lane is gone LAST among lanes, never dropping it', () => {
    const live = [{ roleId: 'ghost' }, { roleId: 'code' }]
    expect(ids(orderByRoster(live, roster))).toEqual(['code', 'ghost'])
  })

  it('handles an empty roster and an all-adhoc group without reordering anything', () => {
    const live: { roleId?: string; id?: string }[] = [{ id: 'a' }, { id: 'b' }]
    expect(ids(orderByRoster(live, []))).toEqual(['a', 'b'])
    expect(ids(orderByRoster([{ roleId: 'code' }, { roleId: 'operator' }], []))).toEqual(['code', 'operator'])
  })
})

// THE CHARTER HALF of the artifact plane. The tools shipped first and nothing invoked them —
// the spike's "charter-dependency risk moved, not removed". These pin that every lane is now
// asked, and asked ONCE.
describe('orchestrationNote — the artifact plane is asked for', () => {
  const roster = rolePresets()
  const noteFor = (id: string) => orchestrationNote('proj', roster.find((r) => r.id === id)!, roster)

  it('a WORKER lane is told to report its result and to close its task', () => {
    const n = noteFor('code')
    expect(n).toContain('operator__report')
    expect(n).toContain("`mcp__operator__task_status`(id, 'done')")
    // The REASON, not just the instruction: a lane weighing a tool call against writing the file
    // it was asked for needs to know the file is unreadable elsewhere.
    expect(n).toContain('unreadable to them')
  })

  it('…and is NOT told to stop writing result files — both, with a reason for each', () => {
    expect(noteFor('code')).toContain('Still write the file when your brief names one')
    expect(noteFor('code')).toContain('unreadable')
  })

  it('the COORDINATOR is told it RECEIVES reports, not that it should file them', () => {
    const n = noteFor('operator')
    expect(n).toContain('operator__report')
    expect(n).toContain('Silence means no report')
    // It is Operator; "call this to reach Operator" is the wrong half for it.
    // It is Operator; it must not be told to file a report to reach itself.
    expect(n).not.toContain('When you finish a piece of work, call `mcp__operator__report`')
    // …but it still closes its own tasks.
    expect(n).toContain("`mcp__operator__task_status`(id, 'done')")
  })

  it('says each instruction EXACTLY once — a first version appended it twice, run together', () => {
    for (const id of ['operator', 'code', 'research', 'qa']) {
      const n = noteFor(id)
      expect((n.match(/operator__task_status/g) ?? []).length).toBe(1)
      expect((n.match(/operator__report/g) ?? []).length).toBe(1)
    }
  })

  // THE NAME HAS TO MATCH THE TOOL LIST. Claude Code namespaces MCP tools as
  // `mcp__<server>__<tool>`; a lane told any other name searches, finds nothing, and goes quiet.
  // Verified against the packaged binary — with the tools named `operator__report` inside a server
  // named `operator`, the exposed name was `mcp__operator__operator__report`, matching nothing any
  // prompt said. This test is what stops that drifting back.
  it('names the tools EXACTLY as Claude Code will expose them', () => {
    for (const id of ['operator', 'code', 'research', 'qa']) {
      const n = noteFor(id)
      expect(n).toContain('mcp__operator__report')
      expect(n).toContain('mcp__operator__task_status')
      // …and never the bare or doubled forms, which are the two ways this has already been wrong.
      expect(n).not.toMatch(/(?<!mcp__)operator__operator__/)
      expect(n).not.toMatch(/(?<!mcp__)\boperator__report\b/)
    }
  })

  it('reaches EVERY lane, including one with a customised charter — it is not the charter', () => {
    // The reason this lives in the launch note: role prompts are persisted per project, so
    // editing DEFAULT_ROLE_PROMPTS would reach only lanes that never customised theirs.
    const custom: Role = { ...roster.find((r) => r.id === 'code')!, prompt: 'my own charter, nothing else' }
    const n = orchestrationNote('proj', custom, roster)
    expect(n).toContain('my own charter, nothing else')
    expect(n).toContain('operator__report')
  })
})
