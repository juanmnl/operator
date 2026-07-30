import { describe, it, expect } from 'vitest'
import { projectAccent, projectInitials, PROJECT_ACCENTS } from './project-accent'

// The real store's project ids are the canonical repo paths' basenames-plus-hash shape; what
// matters for the spread check is that these are 19 DISTINCT realistic ids, matching the
// user's actual store (two uwazi_webs, three fastrack casings, mantel/mantel-landing, …).
const REAL_IDS = [
  'operator', 'Operator-landing', 'mantel', 'mantel-landing', 'el-encanto',
  'uwazi_web', 'uwazi_web-2', 'uwazi_app', 'fastrack', 'FastRack', 'Fastrack',
  'Developer', 'claude-code', 'sandbox', 'scratch', 'portfolio', 'notes-app',
  'invoices', 'api-gateway',
]

describe('projectAccent', () => {
  it('is deterministic and stable for an id', () => {
    expect(projectAccent('operator')).toBe(projectAccent('operator'))
    // Pinned, so a future "improvement" to the hash can't silently repaint everyone's rail.
    expect(projectAccent('operator')).toBe(PROJECT_ACCENTS[(() => {
      let h = 0x811c9dc5
      for (const ch of 'operator') { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) }
      return (h >>> 0) % PROJECT_ACCENTS.length
    })()])
  })

  it('depends on the id alone — not on order, neighbours or count', () => {
    const alone = projectAccent('mantel')
    const shuffled = ['zzz', 'mantel', 'aaa'].map(projectAccent)
    expect(shuffled[1]).toBe(alone)
  })

  it('always returns a swatch from the palette', () => {
    for (const id of REAL_IDS) expect(PROJECT_ACCENTS).toContain(projectAccent(id))
    expect(projectAccent('')).toBeTruthy()
  })

  it('spreads the real 19-project store across the palette', () => {
    // 12 swatches, 19 projects: perfect uniqueness is impossible by pigeonhole, so the bar is
    // SPREAD — most of the palette in play and no colour hogging the rail. Measured today:
    // 10 distinct, largest bucket 4. The bars sit just below that, so this catches a hash
    // that starts clustering without failing on an ordinary reshuffle.
    const counts = new Map<string, number>()
    for (const c of REAL_IDS.map(projectAccent)) counts.set(c, (counts.get(c) ?? 0) + 1)
    expect(counts.size).toBeGreaterThanOrEqual(8)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(5)
  })

  it('uses the WHOLE palette — no dead swatches', () => {
    // The uniformity check the 19-id case can't make. A hash with a bad modulus interaction
    // (or a palette length sharing a factor with it) leaves swatches permanently unused.
    const used = new Set(Array.from({ length: 400 }, (_, i) => projectAccent(`proj-${i}`)))
    expect(used.size).toBe(PROJECT_ACCENTS.length)
  })

  it('does not group ids by their prefix', () => {

    // The three fastrack casings are the case that motivated identity colour at all. Two of
    // them DO collide (see the pigeonhole above) — what must not happen is similar strings
    // landing together systematically, which is what a weak hash does.
    const family = ['mantel', 'mantel-landing', 'mantel-api', 'mantel2', 'mantelx', 'mantel-www']
      .map(projectAccent)
    expect(new Set(family).size).toBeGreaterThanOrEqual(4)
  })
})

describe('projectInitials', () => {
  it('takes the first letter of each of the first two parts', () => {
    expect(projectInitials('el-encanto')).toBe('EE')
    expect(projectInitials('mantel-landing')).toBe('ML')
    expect(projectInitials('uwazi_app')).toBe('UA')
    expect(projectInitials('visual language')).toBe('VL')
  })

  it('falls back to the first two letters of a single part', () => {
    expect(projectInitials('operator')).toBe('OP')
    expect(projectInitials('mantel')).toBe('MA')
    expect(projectInitials('web27')).toBe('WE')
    expect(projectInitials('fastrack')).toBe('FA')
  })

  it('splits camelCase — this is what keeps the fastrack variants apart', () => {
    expect(projectInitials('fastrack')).toBe('FA')
    expect(projectInitials('Fastrack-landing')).toBe('FL')
    expect(projectInitials('FastTrack')).toBe('FT')
    expect(new Set(['fastrack', 'Fastrack-landing', 'FastTrack'].map(projectInitials)).size).toBe(3)
  })

  it('survives names with nothing to split on', () => {
    expect(projectInitials('')).toBe('?')
    expect(projectInitials('---')).toBe('?')
    expect(projectInitials('x')).toBe('X')
  })
})
