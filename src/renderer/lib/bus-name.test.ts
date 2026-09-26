import { describe, it, expect } from 'vitest'
import { laneBusName, parseBusName, projectSlug, sameProject, slugify } from './bus-name'
import { buildArgs } from './launch-args'
import { busNote, orchestrationNote, rolePresets } from './roster'
import { restartLaunchOptions } from './cli-update'

// The projects on the machine that exposed the prefix rule (review-xproject-devports, A1).
const p = (name: string, id = `/Users/x/Developer/${name}`) => ({ id, name })
const pairs = [
  [p('mantel'), p('mantel-landing')],
  [p('operator'), p('Operator-landing')],
  [p('fastrack'), p('Fastrack-landing')],
] as const

describe('lane names on the session bus (X1)', () => {
  it('is <slug>--<role id>, and --<n> from the second instance on', () => {
    const m = p('mantel')
    expect(laneBusName(m, 'design')).toMatch(/^mantel-[0-9a-f]{4}--design$/)
    expect(laneBusName(m, 'code', 2)).toMatch(/^mantel-[0-9a-f]{4}--code--2$/)
    expect(laneBusName(m, 'design')).toBe(laneBusName(m, 'design')) // stable
  })

  it('no slug ever contains the separator', () => {
    for (const name of ['mantel--landing', 'a  --  b', '--x--', 'uwazi_app', 'Operator-landing', 'ñandú 2']) {
      expect(slugify(name)).not.toContain('--')
      expect(projectSlug(p(name))).not.toContain('--')
    }
  })

  it('the -landing pairs on this machine are different projects by name, parsed and by equality (A1)', () => {
    for (const [a, b] of pairs) {
      const nameA = laneBusName(a, 'design'), nameB = laneBusName(b, 'design')
      expect(sameProject(nameA, projectSlug(a))).toBe(true)
      expect(sameProject(nameB, projectSlug(a))).toBe(false) // mantel-landing's Design is not mantel's
      expect(sameProject(nameA, projectSlug(b))).toBe(false)
      expect(nameB.startsWith(projectSlug(a))).toBe(false) // even the raw prefix no longer overlaps
    }
  })

  it('parses a slug with digits and dashes and a role id with a dash', () => {
    const proj = p('web27 v2-beta')
    const name = laneBusName(proj, 'design-qa', 3)
    expect(parseBusName(name)).toEqual({ slug: projectSlug(proj), role: 'design-qa', instance: 3 })
    expect(projectSlug(proj)).toMatch(/^web27-v2-beta-[0-9a-f]{4}$/)
    expect(sameProject(name, projectSlug(proj))).toBe(true)
  })

  it('does not parse a derived bus name or a malformed one as a lane', () => {
    for (const n of ['mantel-2b', 'uwazi-app-ab', 'mantel--', '--code', 'a--b--c--d', 'a--b--zero', 'a--b--0']) {
      expect(parseBusName(n), n).toBeNull()
    }
  })

  it('a project\'s slug does not change when a project with a similar name is added (A2)', () => {
    // It depends on the project alone; there is no "all projects" argument any more.
    const m = p('mantel')
    const before = projectSlug(m)
    const fork = p('Mantel', '/Users/x/forks/mantel')
    expect(projectSlug(m)).toBe(before)
    expect(projectSlug(fork)).not.toBe(before) // same name, different id: different hash
  })

  it('is passed to the CLI as --name, without swallowing the prompt', () => {
    const args = buildArgs({ sessionName: 'mantel-1a2b--design', initialPrompt: 'do the thing' }, 'uuid')
    expect(args.slice(args.indexOf('--name'), args.indexOf('--name') + 2)).toEqual(['--name', 'mantel-1a2b--design'])
    expect(args[args.length - 1]).toBe('do the thing')
    expect(buildArgs({}, 'uuid')).not.toContain('--name')
  })

  it('a restart keeps the name', () => {
    expect(restartLaunchOptions({ roleId: 'code' }, 'sid', { remoteControl: false, sessionName: 'mantel-1a2b--code--2' }).sessionName).toBe('mantel-1a2b--code--2')
  })
})

describe('the launch note tells lanes how to address sessions (X1)', () => {
  const roster = rolePresets()
  const code = roster.find((r) => r.id === 'code')!
  const op = roster.find((r) => r.id === 'operator')!
  const slug = projectSlug(p('mantel'))

  it('states the exact-match rule, to the coordinator and to a lane, and no prefix rule', () => {
    for (const role of [op, code]) {
      const n = orchestrationNote('mantel', role, roster, { busSlug: slug, ownWorktree: role === code })
      expect(n).toContain(`\`${slug}--<role>\``)
      expect(n).toContain(`part before the first \`--\` is exactly \`${slug}\``)
      expect(n).toContain('Never match a session by prefix')
      expect(n).not.toMatch(/starts with `mantel-/)
    }
  })

  it('keeps the note as a real launch builds it under a size guard', () => {
    // RAISED DELIBERATELY for the bus note (X1). Measured as launched, with the bus slug and the
    // lane's own workspace lines; the longest is Infra.
    for (const role of roster) {
      const n = orchestrationNote('mantel', role, roster, {
        busSlug: slug, ownWorktree: role.useWorktree === true, sharesMainCheckout: role.useWorktree === false && role.id !== 'operator',
      })
      expect(n.length, role.id).toBeLessThan(4300)
    }
  })

  it('says nothing about the bus when no slug is given', () => {
    expect(orchestrationNote('mantel', code, roster)).not.toContain(busNote(slug))
  })
})
