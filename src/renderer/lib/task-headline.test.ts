import { describe, it, expect } from 'vitest'
import { headlineOf } from './task-headline'

// Every fixture below is a REAL `task.text` lifted from ~/.operator/projects.json, ugly parts
// included. A fixture more generous than reality validates a design that cannot work — this
// project has paid for that before, with a disclosure control whose body could never open.

const WRAPPED = 'Read /Users/juanmnl/.operator/briefs/sidebar-project-header-dead.md in full and do both tasks in it — the sidebar project header is an inert control; write your result to ~/.operator/briefs/RESULT-sidebar-project-header.md'
const WRAPPER_ONLY = 'Read /Users/juanmnl/.operator/briefs/review-sidebar-header.md in full and review commit a8eaf82 adversarially — findings only, no fixes; write to ~/.operator/briefs/RESULT-review-sidebar-header.md'
const REPORT = 'code done: sidebar "Previously open" sessions replaced by a "Recent" projects list (≤5, lastActiveAt desc, excludes live groups)'
const HAND_TYPED = 'deploy the landing site so the privacy URL resolves'
const PRIORITY = 'HIGH, do this first: read /Users/juanmnl/.operator/briefs/rescue-cr-submits-user-typing.md — the rescue CR submits the user\'s half-typed text'

describe('headlineOf', () => {
  it('strips the dispatch wrapper and takes the instruction', () => {
    const h = headlineOf(WRAPPED)
    expect(h.from).toBe('instruction')
    expect(h.title).toBe('the sidebar project header is an inert control')
    expect(h.brief).toBe('sidebar-project-header-dead')
  })

  it('never opens a headline with an absolute path', () => {
    // The whole reason the board was unscannable: 15 of 23 cards began `Read /Users/…`.
    for (const t of [WRAPPED, WRAPPER_ONLY, PRIORITY]) {
      expect(headlineOf(t).title).not.toMatch(/^[~/]/)
      expect(headlineOf(t).title).not.toContain('/Users/')
    }
  })

  it('strips a priority prefix before anything else', () => {
    expect(headlineOf(PRIORITY).title).not.toMatch(/^HIGH/)
  })

  it('reads an agent report past its "code done:" prefix', () => {
    const h = headlineOf(REPORT)
    expect(h.from).toBe('report')
    expect(h.title).toBe('sidebar "Previously open" sessions replaced by a "Recent" projects list')
  })

  it('RETURNS A SHORT HAND-TYPED TASK VERBATIM', () => {
    // The guard that matters. A deriver built for dispatch text must not mangle a task that is
    // already its own headline.
    const h = headlineOf(HAND_TYPED)
    expect(h.title).toBe(HAND_TYPED)
    expect(h.from).toBe('verbatim')
  })

  it('cuts at the writer\'s punctuation, not at a character count', () => {
    const h = headlineOf('Reconcile the terminal liveness flag — it is event-sourced and the renderer misses events, so a dead lane reads as live')
    expect(h.title).toBe('Reconcile the terminal liveness flag')
  })

  it('refuses a cut that would leave a uselessly short headline', () => {
    // The 24-char floor. "Fix the router" is 14, so the em dash is NOT taken and the clause
    // extends past it — a headline is only useful if it says enough to tell cards apart.
    const h = headlineOf('Fix the router — it resolves a dead lane and files the task as running anyway, which nobody ever sees')
    expect(h.title).not.toBe('Fix the router')
    expect(h.title.length).toBeGreaterThan(24)
    expect(h.title.startsWith('Fix the router')).toBe(true)
  })

  it('never leaves an unbalanced bracket', () => {
    const h = headlineOf('Rework the partition (the one in TaskBoard that decides which column a task belongs to and how it sorts)')
    const open = (h.title.match(/\(/g) || []).length
    const close = (h.title.match(/\)/g) || []).length
    expect(open).toBe(close)
  })

  it('handles the degenerate inputs without producing an empty card', () => {
    expect(headlineOf('').title).toBe('Untitled')
    expect(headlineOf(undefined).title).toBe('Untitled')
    expect(headlineOf(null).title).toBe('Untitled')
    expect(headlineOf('   ').title).toBe('Untitled')
  })

  it('keeps every headline inside the two-line clamp budget', () => {
    for (const t of [WRAPPED, WRAPPER_ONLY, REPORT, HAND_TYPED, PRIORITY]) {
      const { title } = headlineOf(t)
      expect(title.length).toBeGreaterThan(0)
      expect(title.length).toBeLessThanOrEqual(78)
    }
  })

  it('is stable — deriving twice gives the same answer', () => {
    for (const t of [WRAPPED, REPORT, HAND_TYPED]) {
      expect(headlineOf(t)).toEqual(headlineOf(t))
    }
  })
})
