import { describe, it, expect } from 'vitest'
import { laneBusName, projectSlug } from './bus-name'
import { buildArgs } from './launch-args'
import { busNote, orchestrationNote, rolePresets } from './roster'
import { restartLaunchOptions } from './cli-update'

const mantel = { id: '/Users/x/Developer/mantel', name: 'mantel' }
const uwazi = { id: '/Users/x/Developer/huridocs/uwazi_app', name: 'uwazi_app' }
const all = [mantel, uwazi]

describe('lane names on the session bus (X1)', () => {
  it('is <project-slug>-<role id>, stable for the same project and role', () => {
    expect(laneBusName(mantel, 'design', all)).toBe('mantel-design')
    expect(laneBusName(uwazi, 'design', all)).toBe('uwazi-app-design')
    expect(laneBusName(mantel, 'design', all)).toBe(laneBusName(mantel, 'design', [...all].reverse()))
  })

  it('leaves room for further instances of the same lane: -2, -3', () => {
    expect(laneBusName(mantel, 'code', all, 1)).toBe('mantel-code')
    expect(laneBusName(mantel, 'code', all, 2)).toBe('mantel-code-2')
  })

  it('stays unique when two projects\' names give the same slug', () => {
    const fork = { id: '/Users/x/forks/mantel', name: 'Mantel' }
    const a = projectSlug(mantel, [mantel, fork])
    const b = projectSlug(fork, [mantel, fork])
    expect(a).not.toBe(b)
    expect(a).toMatch(/^mantel-[0-9a-f]{4}$/)
    expect(projectSlug(mantel, all)).toBe('mantel') // no clash, no hash
  })

  it('is passed to the CLI as --name, without swallowing the prompt', () => {
    const args = buildArgs({ sessionName: 'mantel-design', initialPrompt: 'do the thing' }, 'uuid')
    expect(args.slice(args.indexOf('--name'), args.indexOf('--name') + 2)).toEqual(['--name', 'mantel-design'])
    expect(args.at(-1)).toBe('do the thing')
    expect(buildArgs({}, 'uuid')).not.toContain('--name')
  })

  it('a restart keeps the name', () => {
    expect(restartLaunchOptions({ roleId: 'code' }, 'sid', { remoteControl: false, sessionName: 'mantel-code' }).sessionName).toBe('mantel-code')
  })
})

describe('the launch note tells lanes how to address sessions (X1)', () => {
  const roster = rolePresets()
  const code = roster.find((r) => r.id === 'code')!
  const op = roster.find((r) => r.id === 'operator')!

  it('names this project\'s prefix and the rule, to the coordinator and to a lane', () => {
    for (const role of [op, code]) {
      const n = orchestrationNote('mantel', role, roster, { busPrefix: 'mantel', ownWorktree: role === code })
      expect(n).toContain('`mantel-<role>`')
      expect(n).toContain('mcp__operator__dispatch')
      expect(n).toContain('starts with `mantel-`')
      expect(n).toContain('never pick a session by a guessed prefix')
    }
  })

  it('keeps the note as a real launch builds it under a size guard', () => {
    // RAISED DELIBERATELY for the bus note (about 390 characters; X1). Measured 2026-09-25 as
    // launched, with the bus prefix and the lane's own workspace lines: Infra, the longest, 4143.
    for (const role of roster) {
      const n = orchestrationNote('mantel', role, roster, {
        busPrefix: 'mantel', ownWorktree: role.useWorktree === true, sharesMainCheckout: role.useWorktree === false && role.id !== 'operator',
      })
      expect(n.length, role.id).toBeLessThan(4300)
    }
  })

  it('says nothing about the bus when no prefix is given', () => {
    expect(orchestrationNote('mantel', code, roster)).not.toContain(busNote('mantel'))
  })
})
