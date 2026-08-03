import { describe, it, expect } from 'vitest'
import type { Project, Role } from '../../shared/types'
import { landingFor, type LandingLane } from './project-landing'

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
