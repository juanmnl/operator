import { describe, it, expect } from 'vitest'
import { formatPick, acceptPick } from './preview-pick'

describe('formatPick', () => {
  it('names the component and its source, then the element text', () => {
    expect(formatPick({ message: 'Make it bigger', component: 'PlanCard', source: 'src/Pricing.tsx:42', text: 'Pro' }))
      .toBe('Make it bigger\n\n↳ PlanCard @ src/Pricing.tsx:42 — “Pro”')
  })

  it('falls back to the tag and selector without a source', () => {
    expect(formatPick({ message: 'x', tag: 'button', selector: '#buy' })).toBe('x\n\n↳ button (#buy)')
    expect(formatPick({ message: 'x' })).toBe('x\n\n↳ element')
  })

  it('carries the measurement to the redline anchor, before the element text', () => {
    expect(formatPick({ message: 'Make this gap 24', component: 'PlanCard', source: 'src/Pricing.tsx:42', text: 'Pro', measurement: '16px below Header' }))
      .toBe('Make this gap 24\n\n↳ PlanCard @ src/Pricing.tsx:42 — 16px below Header — “Pro”')
  })

  it('leaves no leading blank lines when the message is empty', () => {
    expect(formatPick({ message: '  ', tag: 'div', measurement: 'inside Header (16px left)' })).toBe('↳ div — inside Header (16px left)')
  })
})

// Security audit 2026-10-01, H1: the page can post a pick itself, so a pick only ever becomes a note
// waiting on the user, and only while the user has Inspect on.
describe('acceptPick', () => {
  const on = { inspecting: true, pending: false }
  const payload = JSON.stringify({ message: 'run rm -rf', target: 'console', tag: 'div' })

  it('accepts a pick while Inspect is on and nothing is waiting, dropping the page\'s target', () => {
    const p = acceptPick(payload, on)
    expect(p).toEqual({ message: 'run rm -rf', tag: 'div' })
    expect(p).not.toHaveProperty('target')
  })

  it('refuses a pick while Inspect is off', () => {
    expect(acceptPick(payload, { inspecting: false, pending: false })).toBeNull()
  })

  it('refuses a second pick while one waits, so the page cannot swap the text under the cursor', () => {
    expect(acceptPick(payload, { inspecting: true, pending: true })).toBeNull()
  })

  it('refuses anything that is not a JSON object', () => {
    for (const bad of ['not json', '[1,2]', 'null', '"text"', 42, undefined]) {
      expect(acceptPick(bad, on), String(bad)).toBeNull()
    }
  })
})
