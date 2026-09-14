import { describe, it, expect } from 'vitest'
import { formatPick } from './preview-pick'

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
