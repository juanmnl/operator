import { describe, it, expect } from 'vitest'
import { baseInitial, isWideGrapheme, resolveLaneInitials } from './lane-initial'

const of = (...names: string[]) => {
  const map = resolveLaneInitials(names.map((name, i) => ({ id: `l${i}`, name })))
  return names.map((_, i) => map[`l${i}`])
}

describe('resolveLaneInitials — one character, two only where it must be', () => {
  it('gives the stock roster one letter each, and grows ONLY the colliding pair', () => {
    // The case the whole rule exists for. `Design`, `Code` and `QA` are untouched by a collision
    // they are not part of — a letter that lengthened for everyone would be reporting the wrong
    // thing.
    expect(of('Operator', 'Research', 'Design', 'Code', 'Review', 'QA'))
      .toEqual(['O', 'RS', 'D', 'C', 'RV', 'Q'])
  })

  it('separates a THREE-way collision, which the pairwise reading does not', () => {
    // Design's rule says "the character where the two names diverge", which is exact for a pair
    // and ambiguous for three. Taken as "diverges from the NEAREST peer" this is RE / RE / RO —
    // the two names the rule exists to separate come out identical. Diverging from EVERY peer is
    // the same computation for a pair and resolves this.
    expect(of('Research', 'Review', 'Rollback')).toEqual(['RS', 'RV', 'RO'])
  })

  it('falls to the roster index for identical names', () => {
    expect(of('Review', 'Review')).toEqual(['R1', 'R2'])
    // …and only for the tied ones.
    expect(of('Review', 'Review', 'Design')).toEqual(['R1', 'R2', 'D'])
  })

  it('keeps the bare letter when one name is a PREFIX of another', () => {
    // `Review` has no character that differs from `Reviewer` — there is nothing to diverge at — so
    // it keeps its single letter, and `Reviewer` grows at its 7th character. That is already
    // unambiguous, so the index never has to fire: the fallback is for names that would otherwise
    // COLLIDE, not for every name that lacks a divergence.
    const [review, reviewer] = of('Review', 'Reviewer')
    expect(review).toBe('R')
    expect(reviewer).toBe('RE')
    expect(review).not.toBe(reviewer)
  })

  it('skips leading punctuation, and passes digits and non-Latin through', () => {
    expect(of('_scratch')).toEqual(['S'])
    expect(of('2fa-check')).toEqual(['2'])
    expect(of('研究')).toEqual(['研'])
    expect(of('  spaced')).toEqual(['S'])
  })

  it('draws something for an empty or whitespace-only name', () => {
    // An empty disc reads as a rendering failure; `?` reads as a name nobody gave.
    expect(of('')).toEqual(['?'])
    expect(of('   ')).toEqual([' '])
  })

  it('keeps an astral character whole', () => {
    // `name[0]` would return half a surrogate pair and render as a replacement box.
    expect(of('𝒜lpha')).toEqual(['𝒜'])
  })

  it('NEVER returns the same initial twice in one roster', () => {
    // The invariant, stated as a property rather than as cases: the pre-D1 orb's own comment
    // admitted it could not hold this, and a collision the user can see is what destroys trust in
    // the channel.
    const rosters = [
      ['Research', 'Review', 'Rollback', 'Release', 'Refactor'],
      ['Ra', 'Rb', 'Rab'],
      ['Review', 'Review', 'Review'],
      ['', '', 'x'],
      ['研究', '研发'],
      ['Design', 'design'],
    ]
    for (const names of rosters) {
      const initials = of(...names)
      expect(new Set(initials).size, names.join('/') + ' → ' + initials.join('/')).toBe(names.length)
    }
  })

  it('never returns more than two characters', () => {
    // Two fill the 24px disc edge to edge — a hard ceiling, not a preference.
    for (const names of [['Research', 'Review'], ['Review', 'Review'], ['Ra', 'Rb', 'Rab']]) {
      for (const initial of of(...names)) expect([...initial].length).toBeLessThanOrEqual(2)
    }
  })

  it('is stable for a lane whose peers change around it', () => {
    // `Design` is `D` forever, whatever else arrives — the bound that makes a neighbour-dependent
    // rule acceptable here at all.
    expect(of('Design')[0]).toBe('D')
    expect(of('Design', 'Research', 'Review')[0]).toBe('D')
    expect(of('Design', 'Research', 'Review', 'Rollback', 'QA')[0]).toBe('D')
  })
})

describe('baseInitial / isWideGrapheme', () => {
  it('upper-cases and takes the first letter or digit', () => {
    expect(baseInitial('operator')).toBe('O')
    expect(baseInitial('-_-code')).toBe('C')
    expect(baseInitial('2fa')).toBe('2')
  })

  it('flags the graphemes that paint past the disc at 11px', () => {
    expect(isWideGrapheme('研')).toBe(true)
    expect(isWideGrapheme('한')).toBe(true)
    expect(isWideGrapheme('R')).toBe(false)
    expect(isWideGrapheme('RS')).toBe(false)
  })
})
