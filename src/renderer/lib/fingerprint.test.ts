import { describe, it, expect } from 'vitest'
import { fingerprint } from './fingerprint'

describe('fingerprint', () => {
  it('is the same for the same text and short whatever the text', () => {
    const big = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ id: `p-${i}`, name: 'x'.repeat(40) })))
    expect(fingerprint(big)).toBe(fingerprint(big.slice()))
    expect(fingerprint(big).length).toBeLessThan(24)
  })

  it('changes with one character, at the start, the middle or the end', () => {
    const s = '[{"id":"a","name":"Operator","tasks":[]}]'
    const at = (i: number) => s.slice(0, i) + (s[i] === 'x' ? 'y' : 'x') + s.slice(i + 1)
    for (const i of [0, Math.floor(s.length / 2), s.length - 1]) expect(fingerprint(at(i))).not.toBe(fingerprint(s))
  })

  it('tells apart texts that differ only in length or order', () => {
    expect(fingerprint('')).not.toBe(fingerprint('\u0000'))
    expect(fingerprint('ab')).not.toBe(fingerprint('ba'))
  })
})
