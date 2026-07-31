import { describe, it, expect } from 'vitest'
import type { Project, Role } from '../../shared/types'
import { landingFor, type LandingLane } from './project-landing'

const project = (roster: Role[], id = 'p'): Project =>
  ({ id, path: '/p', name: 'p', createdAt: '', lastActiveAt: '', roster })
const role = (id: string): Role => ({ id, name: id })
const lane = (o: Partial<LandingLane> & { id: string }): LandingLane => ({ projectId: 'p', ...o })

describe('landingFor — where entering a project puts you', () => {
  it('SEVERAL lanes → the channel', () => {
    expect(landingFor(project([role('operator'), role('code')]), [])).toEqual({ kind: 'channel' })
    expect(landingFor(project([role('operator'), role('code'), role('qa')]), [])).toEqual({ kind: 'channel' })
  })

  it('ONE lane that is LIVE → straight into that session', () => {
    const lanes = [lane({ id: 't3', roleId: 'operator' })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'session', terminalId: 't3' })
  })

  it('ONE lane that is IDLE → the board, where its Launch button is', () => {
    // Deliberately not an empty terminal surface: the useful next action is launching it.
    expect(landingFor(project([role('operator')]), [])).toEqual({ kind: 'roster' })
  })

  it('NO lanes → the board, the only place to add one', () => {
    expect(landingFor(project([]), [])).toEqual({ kind: 'roster' })
    expect(landingFor(project([]), [lane({ id: 't1', roleId: 'ghost' })])).toEqual({ kind: 'roster' })
  })

  it('keys off the ROSTER, not on how many lanes are running', () => {
    // "One agent" is a property of the project. Two lanes with nothing running is still a channel.
    expect(landingFor(project([role('operator'), role('code')]), [])).toEqual({ kind: 'channel' })
    // …and one lane with two stray ptys is still one agent.
    const strays = [lane({ id: 't1', roleId: 'operator' }), lane({ id: 't2', roleId: 'gone' })]
    expect(landingFor(project([role('operator')]), strays)).toEqual({ kind: 'session', terminalId: 't1' })
  })

  it('does not count an ENDED session as live', () => {
    const lanes = [lane({ id: 't1', roleId: 'operator', ended: true })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'roster' })
  })

  it("does not count ANOTHER project's session as this lane being live", () => {
    // The damage would be landing on someone else's terminal, which also desyncs scope.
    const lanes = [lane({ id: 't1', roleId: 'operator', projectId: 'other' })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'roster' })
  })

  it('matches the live lane by ROLE, not by position', () => {
    const lanes = [lane({ id: 't9', roleId: 'design' })]
    expect(landingFor(project([role('operator')]), lanes)).toEqual({ kind: 'roster' })
  })

  it('handles an absent project and an absent roster', () => {
    expect(landingFor(null, [])).toEqual({ kind: 'roster' })
    expect(landingFor(undefined, [])).toEqual({ kind: 'roster' })
    expect(landingFor({ id: 'p', path: '/p', name: 'p', createdAt: '', lastActiveAt: '' }, [])).toEqual({ kind: 'roster' })
  })
})
