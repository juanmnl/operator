import { describe, it, expect } from 'vitest'
import { laneActionItems, type LaneActionsInput } from './lane-actions'

const lane = (over: Partial<LaneActionsInput> = {}): LaneActionsInput => ({
  active: true, live: true, closable: true, canSuspend: false, ...over,
})

describe('the lane menu (lifecycle audit B1, task 9)', () => {
  it('a live lane on screen: Close arms and shows ⌘W, then Colour under a hairline', () => {
    expect(laneActionItems(lane())).toEqual([
      { id: 'lane-close', action: 'close', label: 'Close session', hint: '⌘W', confirm: true, disabled: false },
      { id: 'lane-colour', action: 'colour', label: 'Lane colour…', separator: true },
    ])
  })

  it('shows ⌘W only on the lane it closes, and does not arm for an ended lane', () => {
    const [close] = laneActionItems(lane({ active: false, live: false }))
    expect(close.hint).toBeUndefined()
    expect(close.confirm).toBe(false)
  })

  it('offers Restart only when out of date, disabled while the lane is busy', () => {
    expect(laneActionItems(lane()).some((i) => i.action === 'restart')).toBe(false)
    const restart = laneActionItems(lane({ restart: { version: '2.1.310', canRestart: false } })).find((i) => i.action === 'restart')
    expect(restart).toEqual({ id: 'lane-restart', action: 'restart', label: 'Restart on Claude Code 2.1.310', disabled: true })
  })

  it('offers Suspend only when the rules allow it, after Restart and before Colour', () => {
    expect(laneActionItems(lane()).some((i) => i.action === 'suspend')).toBe(false)
    const items = laneActionItems(lane({ canSuspend: true, restart: { version: '2.1.310', canRestart: true } }))
    expect(items.map((i) => i.action)).toEqual(['close', 'restart', 'suspend', 'colour'])
    expect(items[2].label).toBe('Suspend — keep the conversation')
  })

  it('every verb has its own label; none is drawn with ■ or ✕', () => {
    const labels = laneActionItems(lane({ canSuspend: true, restart: { version: 'x', canRestart: true } })).map((i) => i.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const l of labels) expect(l).not.toMatch(/[■✕×]/)
  })

  it('Close is disabled with no terminal to end', () => {
    expect(laneActionItems(lane({ closable: false }))[0].disabled).toBe(true)
  })
})
