import { describe, it, expect } from 'vitest'
import { isStaleTask, taskAgeDays, splitStale, describeSkipped, STALE_TASK_DAYS } from './task-staleness'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-03T12:00:00Z')
const task = (days: number, text = 't') => ({ createdAt: new Date(NOW - days * DAY).toISOString(), text })

describe('task staleness', () => {
  it('measures age from createdAt, in whole days', () => {
    expect(taskAgeDays(task(0), NOW)).toBe(0)
    expect(taskAgeDays(task(6.9), NOW)).toBe(6)
    expect(taskAgeDays(task(13), NOW)).toBe(13)
  })

  it('THE INCIDENT: the twelve-day-old rows are caught', () => {
    // The eight rows that were dispatched twelve days late were 12–13 days old. A 14-day
    // horizon — the existing STALE_DAYS — would have let every one of them through, which is
    // why this constant is 7 and not that one.
    expect(STALE_TASK_DAYS).toBe(7)
    expect(isStaleTask(task(12), NOW)).toBe(true)
    expect(isStaleTask(task(13), NOW)).toBe(true)
  })

  it('is inclusive at the horizon and false below it', () => {
    expect(isStaleTask(task(6), NOW)).toBe(false)
    expect(isStaleTask(task(7), NOW)).toBe(true)
  })

  it('does not treat an unparseable date as old', () => {
    // Age is evidence; a broken timestamp is the absence of evidence, and blocking a send on it
    // would make a data glitch look like a guardrail.
    expect(isStaleTask({ createdAt: 'not a date' }, NOW)).toBe(false)
  })

  it('splits without losing anything — there is no third branch', () => {
    const tasks = [task(1, 'a'), task(9, 'b'), task(2, 'c'), task(30, 'd')]
    const { fresh, stale } = splitStale(tasks, NOW)
    expect(fresh.map((t) => t.text)).toEqual(['a', 'c'])
    expect(stale.map((t) => t.text)).toEqual(['b', 'd'])
    expect(fresh.length + stale.length).toBe(tasks.length)
  })

  it('names what was held back — no silent caps', () => {
    expect(describeSkipped([task(9, 'ship the notes')], NOW)).toBe('“ship the notes” is 9 days old')
    expect(describeSkipped([task(9, 'a'), task(30, 'b')], NOW)).toBe('2 tasks up to 30 days old')
  })
})
