import { describe, it, expect } from 'vitest'
import { closeKeyAction } from './close-key'

const lane = (phase: string, status = 'active') => ({ terminalId: 't1', status, phase })

describe('closeKeyAction — ⌘W on the active lane', () => {
  it('closes an idle or waiting lane on the first press', () => {
    expect(closeKeyAction(lane('idle'), null, 0)).toBe('close')
    expect(closeKeyAction(lane('waiting'), null, 0)).toBe('close')
  })

  it('arms on a mid-turn lane: running, compacting or asking', () => {
    for (const phase of ['running', 'compacting', 'asking']) expect(closeKeyAction(lane(phase), null, 0)).toBe('arm')
  })

  it('closes on the second press inside the window', () => {
    expect(closeKeyAction(lane('running'), { terminalId: 't1', until: 2500 }, 2499)).toBe('close')
  })

  it('arms again once the window has passed, or for another lane', () => {
    expect(closeKeyAction(lane('running'), { terminalId: 't1', until: 2500 }, 2500)).toBe('arm')
    expect(closeKeyAction(lane('running'), { terminalId: 't2', until: 2500 }, 100)).toBe('arm')
  })

  it('closes an ended or suspended lane at once, whatever its last phase', () => {
    expect(closeKeyAction(lane('running', 'ended'), null, 0)).toBe('close')
  })
})
