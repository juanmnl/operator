import { describe, it, expect } from 'vitest'
import { laneTextColor } from './lane-color'

describe('laneTextColor', () => {
  it('mixes the lane accent toward --fg by the theme-controlled amount', () => {
    expect(laneTextColor('#7ee787')).toBe('color-mix(in srgb, #7ee787, var(--fg) var(--lane-ink-blend, 0%))')
  })

  it('falls back to the theme accent for a lane-less session', () => {
    expect(laneTextColor(undefined)).toBe('color-mix(in srgb, var(--accent), var(--fg) var(--lane-ink-blend, 0%))')
    expect(laneTextColor('')).toBe('color-mix(in srgb, var(--accent), var(--fg) var(--lane-ink-blend, 0%))')
    // Whitespace-only is an empty accent, not a colour named " ".
    expect(laneTextColor('   ')).toBe('color-mix(in srgb, var(--accent), var(--fg) var(--lane-ink-blend, 0%))')
  })

  it('defaults the blend to 0% so a theme without the token leaves accents untouched', () => {
    expect(laneTextColor('#ff7ac6')).toContain('var(--lane-ink-blend, 0%)')
  })

  it('accepts a css variable as the accent', () => {
    expect(laneTextColor('var(--accent)')).toBe('color-mix(in srgb, var(--accent), var(--fg) var(--lane-ink-blend, 0%))')
  })
})
