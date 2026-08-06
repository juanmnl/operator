import { describe, it, expect } from 'vitest'
import {
  coalesceToasts,
  MAX_VISIBLE,
  DISMISS_ALL_THRESHOLD,
  type ToastMessage,
} from './Toast'

let seq = 0
function toast(over: Partial<ToastMessage> = {}): ToastMessage {
  return { id: `t${++seq}`, text: 'Operator never started the task it was sent', ...over }
}

/** What the render site does with a stack of this size. */
function visible<T>(groups: T[]): T[] {
  return groups.slice(-MAX_VISIBLE)
}

describe('coalesceToasts', () => {
  it('collapses byte-identical toasts into one counted card', () => {
    const msgs = [toast(), toast(), toast(), toast()]
    const groups = coalesceToasts(msgs)
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(4)
  })

  it('keeps toasts apart when text, kind or detail differ', () => {
    const groups = coalesceToasts([
      toast({ text: 'Operator never started the task it was sent', kind: 'error' }),
      toast({ text: 'Code never started the task it was sent', kind: 'error' }),
      toast({ text: 'Operator never started the task it was sent', kind: 'info' }),
      toast({ text: 'Operator never started the task it was sent', kind: 'error', detail: 'still in its composer' }),
    ])
    expect(groups).toHaveLength(4)
    expect(groups.every((g) => g.count === 1)).toBe(true)
  })

  it('coalesces despite different action closures — the burst is N identical sentences', () => {
    const groups = coalesceToasts([
      toast({ action: { label: 'Show', run: () => {} } }),
      toast({ action: { label: 'Show', run: () => {} } }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(2)
  })

  it('carries every occurrence id so dismissing the card clears all of them', () => {
    const msgs = [toast(), toast(), toast()]
    const [group] = coalesceToasts(msgs)
    expect(group.ids).toEqual(msgs.map((m) => m.id))
  })

  it('keys the card on the OLDEST id so a repeat increments in place', () => {
    const first = toast()
    const groups = coalesceToasts([first, toast(), toast()])
    expect(groups[0].id).toBe(first.id)
  })

  it('offers the NEWEST occurrence action, and flags that it reaches only that one', () => {
    const older = toast({ action: { label: 'Show', run: () => {} } })
    const newer = toast({ action: { label: 'Show', run: () => {} } })
    const [group] = coalesceToasts([older, newer])
    expect(group.message.action).toBe(newer.action)
    expect(group.actionIsLatestOnly).toBe(true)
  })

  it('does not flag "latest only" when just one occurrence was actionable', () => {
    const [group] = coalesceToasts([
      toast(),
      toast({ action: { label: 'Show', run: () => {} } }),
    ])
    expect(group.count).toBe(2)
    expect(group.actionIsLatestOnly).toBe(false)
  })

  it('a later action-less occurrence does not blank out an earlier action', () => {
    const actionable = toast({ action: { label: 'Show', run: () => {} } })
    const [group] = coalesceToasts([actionable, toast()])
    expect(group.message.action).toBe(actionable.action)
  })

  it('preserves first-seen order across distinct groups', () => {
    const groups = coalesceToasts([
      toast({ text: 'A' }), toast({ text: 'B' }), toast({ text: 'A' }), toast({ text: 'C' }),
    ])
    expect(groups.map((g) => g.message.text)).toEqual(['A', 'B', 'C'])
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1])
  })

  it('is a no-op on an empty stack', () => {
    expect(coalesceToasts([])).toEqual([])
  })
})

describe('clear all / stack thresholds', () => {
  it('dismissing a coalesced card clears every occurrence it stands for', () => {
    const msgs = [toast(), toast(), toast(), toast({ text: 'other' })]
    const groups = coalesceToasts(msgs)
    // Render site: `g.ids.forEach(onDismiss)`.
    let stack = msgs
    const dismiss = (id: string) => { stack = stack.filter((t) => t.id !== id) }
    groups[0].ids.forEach(dismiss)
    expect(stack.map((t) => t.text)).toEqual(['other'])
  })

  it('clears only the ids caught at click time — a toast pushed mid-fade survives', () => {
    const onScreen = [toast(), toast({ text: 'Code never started the task it was sent' })]
    let stack = [...onScreen]
    // Dismiss all snapshots the ids, then arrives 180ms later. A toast pushed in
    // between must not be swallowed by the clear.
    const snapshot = stack.map((t) => t.id)
    const arrivedMidFade = toast({ text: 'Review never started the task it was sent' })
    stack = [...stack, arrivedMidFade]
    // What DashboardView's dismissAllToasts does with the snapshot.
    const gone = new Set(snapshot)
    stack = stack.filter((t) => !gone.has(t.id))
    expect(stack).toEqual([arrivedMidFade])
  })

  it('shows Dismiss all only once the stack is 2+ cards AFTER coalescing', () => {
    const four = coalesceToasts([toast(), toast(), toast(), toast()])
    expect(four).toHaveLength(1)
    // Four identical toasts are ONE card — the stack control would be noise.
    expect(four.length >= DISMISS_ALL_THRESHOLD).toBe(false)

    const two = coalesceToasts([toast(), toast({ text: 'Code never started the task it was sent' })])
    expect(two.length >= DISMISS_ALL_THRESHOLD).toBe(true)
  })

  it('caps the rendered column and reports the remainder instead of clipping', () => {
    const msgs = Array.from({ length: 7 }, (_, i) => toast({ text: `distinct ${i}` }))
    const groups = coalesceToasts(msgs)
    expect(groups).toHaveLength(7)
    const shown = visible(groups)
    expect(shown).toHaveLength(MAX_VISIBLE)
    expect(groups.length - shown.length).toBe(3)
    // Keeps the NEWEST cards; the hidden ones are the older news.
    expect(shown[shown.length - 1].message.text).toBe('distinct 6')
    expect(shown[0].message.text).toBe('distinct 3')
  })

  it('does not cap a stack that fits', () => {
    const groups = coalesceToasts(Array.from({ length: MAX_VISIBLE }, (_, i) => toast({ text: `d${i}` })))
    expect(visible(groups)).toHaveLength(MAX_VISIBLE)
    expect(groups.length - visible(groups).length).toBe(0)
  })
})
