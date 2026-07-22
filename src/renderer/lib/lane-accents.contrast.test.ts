import { describe, it, expect } from 'vitest'
import { ACCENT_SWATCHES } from './lane-accents'
import { themes } from '../themes'

// Every colour the picker offers must still be READABLE once `laneTextColor` blends it
// toward --fg — otherwise adding a pretty swatch quietly ships an invisible lane name.
// This recomputes what the browser does for `color-mix(in srgb, <accent>, var(--fg) <blend>)`
// against the darkest surface a lane title sits on, per theme.

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}
const mix = (a: [number, number, number], b: [number, number, number], p: number) =>
  a.map((v, i) => v * (1 - p) + b[i] * p) as [number, number, number]
const lum = (c: [number, number, number]) => {
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('accent swatches stay legible through laneTextColor', () => {
  for (const [key, theme] of Object.entries(themes)) {
    it(`${key}: every swatch clears 4.5:1 on the darkest lane surface`, () => {
      const blendRaw = theme.vars['--lane-ink-blend']
      expect(blendRaw, `${key} must define --lane-ink-blend`).toBeTruthy()
      const blend = parseFloat(blendRaw) / 100
      const fg = rgb(theme.vars['--fg'])
      // Candidate backdrops for a lane title; the darkest is the hard case once the
      // accent has been mixed toward a dark --fg (and the lightest when --fg is light).
      const surfaces = [theme.vars['--bg-surface'], theme.vars['--bg-sidebar'], theme.vars['--bg-terminal']]
        .filter(Boolean).map(rgb)

      const failures: string[] = []
      for (const swatch of ACCENT_SWATCHES) {
        const ink = mix(rgb(swatch), fg, blend)
        for (const bg of surfaces) {
          const r = ratio(ink, bg)
          if (r < 4.5) failures.push(`${swatch} on rgb(${bg.map(Math.round)}) = ${r.toFixed(2)}:1`)
        }
      }
      expect(failures, `${key} unreadable swatches:\n  ${failures.join('\n  ')}`).toEqual([])
    })
  }
})
