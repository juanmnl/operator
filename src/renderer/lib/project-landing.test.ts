import { describe, it, expect } from 'vitest'
import type { Project, Role } from '../../shared/types'
import { landingFor, landingWithLastAgent, type LandingLane } from './project-landing'

const project = (roster: Role[], id = 'p'): Project =>
  ({ id, path: '/p', name: 'p', createdAt: '', lastActiveAt: '', roster })
const role = (id: string): Role => ({ id, name: id })
const lane = (o: Partial<LandingLane> & { id: string }): LandingLane => ({ projectId: 'p', ...o })

describe('landingFor — where entering a project puts you', () => {
  it('SEVERAL lanes → the board, which is project home', () => {
    // This used to be the channel — "several lanes → the room they talk in". The channel is
    // deleted; the multi-lane answer is now the same as every other non-single-live-lane case.
    expect(landingFor(project([role('operator'), role('code')]), [])).toEqual({ kind: 'board' })
    expect(landingFor(project([role('operator'), role('code'), role('qa')]), [])).toEqual({ kind: 'board' })
  })

  it('ONE lane that is LIVE → straight into that session', () => {
    const lanes = [lane({ id: 't3', roleId: 'operator' })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'session', terminalId: 't3' })
  })

  it('ONE lane that is IDLE → the board, where the work is', () => {
    // Deliberately not an empty terminal surface: the useful next action is saying what you want.
    expect(landingFor(project([role('operator')]), [])).toEqual({ kind: 'board' })
  })

  it('NO lanes → the board, the only place to add one', () => {
    expect(landingFor(project([]), [])).toEqual({ kind: 'board' })
    expect(landingFor(project([]), [lane({ id: 't1', roleId: 'ghost' })])).toEqual({ kind: 'board' })
  })

  it('keys off the ROSTER, not on how many lanes are running', () => {
    // "One agent" is a property of the project. Two lanes with nothing running is still the board.
    expect(landingFor(project([role('operator'), role('code')]), [])).toEqual({ kind: 'board' })
    // …and one lane with two stray ptys is still one agent.
    const strays = [lane({ id: 't1', roleId: 'operator' }), lane({ id: 't2', roleId: 'gone' })]
    expect(landingFor(project([role('operator')]), strays)).toEqual({ kind: 'session', terminalId: 't1' })
  })

  it('does not count an ENDED session as live', () => {
    const lanes = [lane({ id: 't1', roleId: 'operator', ended: true })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'board' })
  })

  it("does not count ANOTHER project's session as this lane being live", () => {
    // The damage would be landing on someone else's terminal, which also desyncs scope.
    const lanes = [lane({ id: 't1', roleId: 'operator', projectId: 'other' })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'board' })
  })

  it('matches the live lane by ROLE, not by position', () => {
    const lanes = [lane({ id: 't9', roleId: 'design' })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'board' })
  })

  it('handles an absent project and an absent roster', () => {
    expect(landingFor(null, [])).toEqual({ kind: 'board' })
    expect(landingFor(undefined, [])).toEqual({ kind: 'board' })
    expect(landingFor({ id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '' }, [])).toEqual({ kind: 'board' })
  })
})

// ── the memory in front of the rule ────────────────────────────────────────────────────────
// "when switching projects, show me the last selected agent, not the project itself" — which
// reverses the earlier "re-apply the rule, don't restore" decision, on purpose and per project.
describe('landingWithLastAgent', () => {
  const project = (roster: { id: string }[]) =>
    ({ id: 'p1', path: '/p', name: 'p', createdAt: '', lastActiveAt: '', roster }) as unknown as Parameters<typeof landingWithLastAgent>[0]
  const twoLanes = project([{ id: 'code' }, { id: 'design' }])

  it('lands on the remembered agent when it is still live', () => {
    const lanes = [
      { id: 't1', key: 'k-code', projectId: 'p1', roleId: 'code' },
      { id: 't2', key: 'k-design', projectId: 'p1', roleId: 'design' },
    ]
    // Two lanes → `landingFor` alone would say board. The memory is what overrides it.
    expect(landingFor(twoLanes, lanes)).toEqual({ kind: 'board' })
    expect(landingWithLastAgent(twoLanes, lanes, 'k-design')).toEqual({ kind: 'session', terminalId: 't2' })
  })

  it('falls through when the remembered session has ENDED', () => {
    const lanes = [{ id: 't1', key: 'k-code', projectId: 'p1', roleId: 'code', ended: true }]
    expect(landingWithLastAgent(twoLanes, lanes, 'k-code')).toEqual({ kind: 'board' })
  })

  it('falls through when the lane is gone entirely (deleted, or nothing running)', () => {
    // The restart case: no ptys at all, so there is no session object to land on.
    expect(landingWithLastAgent(twoLanes, [], 'k-code')).toEqual({ kind: 'board' })
  })

  it('falls through when the project was never visited', () => {
    const lanes = [{ id: 't1', key: 'k-code', projectId: 'p1', roleId: 'code' }]
    expect(landingWithLastAgent(twoLanes, lanes, undefined)).toEqual({ kind: 'board' })
  })

  it('never crosses projects — a key live in ANOTHER project does not count', () => {
    const lanes = [{ id: 't9', key: 'k-code', projectId: 'p2', roleId: 'code' }]
    expect(landingWithLastAgent(twoLanes, lanes, 'k-code')).toEqual({ kind: 'board' })
  })

  it('keeps `landingFor`s single-live-lane answer when there is no memory', () => {
    const solo = project([{ id: 'code' }])
    const lanes = [{ id: 't1', key: 'k-code', projectId: 'p1', roleId: 'code' }]
    expect(landingWithLastAgent(solo, lanes, undefined)).toEqual({ kind: 'session', terminalId: 't1' })
  })
})
