import { describe, it, expect } from 'vitest'
import { zoneLabel, composeMessage, type Annotation } from './annotations'

describe('zoneLabel', () => {
  it('maps corners and center', () => {
    expect(zoneLabel(10, 10)).toBe('top-left')
    expect(zoneLabel(90, 90)).toBe('bottom-right')
    expect(zoneLabel(50, 50)).toBe('center')
    expect(zoneLabel(50, 10)).toBe('top')
    expect(zoneLabel(10, 50)).toBe('left')
  })
})

describe('composeMessage', () => {
  const pin: Annotation = { id: '1', xPct: 12, yPct: 20, note: 'Button clipped', route: '/login', createdAt: '' }
  const box: Annotation = { id: '2', xPct: 40, yPct: 40, wPct: 20, hPct: 10, note: 'Too tight', route: '/login', createdAt: '' }

  it('returns empty for no annotations', () => {
    expect(composeMessage([], '/login')).toBe('')
  })

  it('lists notes with location hints + route + viewport', () => {
    const msg = composeMessage([pin, box], '/login', { w: 1280, h: 800 })
    expect(msg).toContain('UI feedback on /login (viewport 1280×800):')
    expect(msg).toContain('1. [top-left · ~12%,20%] Button clipped')
    expect(msg).toContain('region] Too tight')
    expect(msg).toMatch(/address it\.$/)
  })

  it('falls back to (no note) and default route', () => {
    const bare: Annotation = { id: '3', xPct: 5, yPct: 5, note: '   ', route: '', createdAt: '' }
    const msg = composeMessage([bare], '')
    expect(msg).toContain('UI feedback on /:')
    expect(msg).toContain('(no note)')
  })
})
