import { describe, it, expect } from 'vitest'
import { computeFanMembership } from './fan-out'

describe('computeFanMembership', () => {
  it('collects effort levels keyed by terminal id', () => {
    const { effortLevels } = computeFanMembership([
      { id: 'a', effortLevel: 'high' },
      { id: 'b' },
    ])
    expect(effortLevels).toEqual({ a: 'high' })
  })

  it('numbers members by fanIndex within a group', () => {
    const { fanInfo } = computeFanMembership([
      { id: 'a', fanGroup: 'g', fanIndex: 2 },
      { id: 'b', fanGroup: 'g', fanIndex: 1 },
      { id: 'c', fanGroup: 'g', fanIndex: 3 },
    ])
    expect(fanInfo).toEqual({
      b: { index: 1, total: 3 },
      a: { index: 2, total: 3 },
      c: { index: 3, total: 3 },
    })
  })

  it('drops the badge for a lone survivor', () => {
    const { fanInfo } = computeFanMembership([{ id: 'a', fanGroup: 'g', fanIndex: 1 }])
    expect(fanInfo).toEqual({})
  })

  it('keeps separate groups independent', () => {
    const { fanInfo } = computeFanMembership([
      { id: 'a', fanGroup: 'g1', fanIndex: 1 },
      { id: 'b', fanGroup: 'g1', fanIndex: 2 },
      { id: 'c', fanGroup: 'g2', fanIndex: 1 },
    ])
    expect(fanInfo).toEqual({
      a: { index: 1, total: 2 },
      b: { index: 2, total: 2 },
    })
  })
})
