import { describe, it, expect } from 'vitest'
import { themeKey, resolveThemeKey, themes } from './index'

describe('themeKey', () => {
  it('joins identity and mode', () => {
    expect(themeKey('mr-pink', 'dark')).toBe('mr-pink-dark')
    expect(themeKey('mission-control', 'light')).toBe('mission-control-light')
  })
})

describe('resolveThemeKey', () => {
  it('passes through a currently-valid key', () => {
    expect(resolveThemeKey('1984-dark')).toBe('1984-dark')
    expect(themes['1984-dark']).toBeDefined()
  })

  it('migrates pre-split identity-only keys', () => {
    expect(resolveThemeKey('mission-control')).toBe('mission-control-dark')
    expect(resolveThemeKey('1984')).toBe('1984-dark')
  })

  it('migrates the removed Light identity to Mission Control, preserving mode', () => {
    expect(resolveThemeKey('light')).toBe('mission-control-light')
    expect(resolveThemeKey('light-dark')).toBe('mission-control-dark')
    expect(resolveThemeKey('light-light')).toBe('mission-control-light')
  })

  it('falls back to the default for null/unknown', () => {
    expect(resolveThemeKey(null)).toBe('mission-control-dark')
    expect(resolveThemeKey(undefined)).toBe('mission-control-dark')
    expect(resolveThemeKey('nope')).toBe('mission-control-dark')
    expect(resolveThemeKey('')).toBe('mission-control-dark')
  })
})

// ── syntax ink contrast, all six palettes ────────────────────────────────────────────────────
//
// The code viewer's roles used to borrow the ANSI tokens, on the assumption that those are
// "already tuned per palette against that palette's own background". True for a terminal, false
// for small syntax text on the LIGHT palettes. Measured before the fix, against each palette's
// own `--bg-terminal`:
//
//   green   2.92 / 2.67 / 2.32:1        yellow  3.05 / 3.03 / 1.86:1
//   1984-light failed on EVERY role — keyword 2.63, type 2.44, attr 2.07, comment 4.30.
//
// QA reported the 1.86 independently; it is `--syn-number` on 1984-light. This test is what stops
// it coming back, and it runs over all six palettes because "verified by eye" has meant four in
// this repo's comments for a while.

/** WCAG relative luminance. */
function luminance(hex: string): number {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The floor for body-size text. The viewer draws at 11px, so AA-large does not apply. */
const FLOOR = 4.5

const SYNTAX_TOKENS = ['--syn-keyword', '--syn-string', '--syn-number', '--syn-type', '--syn-attr', '--syn-comment'] as const

describe('syntax ink clears 4.5:1 in every palette', () => {
  const keys = Object.keys(themes) as Array<keyof typeof themes>

  it('covers all SIX palettes, not four', () => {
    expect(keys).toHaveLength(6)
  })

  for (const key of Object.keys(themes) as Array<keyof typeof themes>) {
    it(`${key}`, () => {
      const vars = themes[key].vars as Record<string, string>
      // The viewer's ground: the Files panel and the main-view overlay both paint
      // `--bg-terminal` behind it, and the CM6 theme itself is transparent.
      const ground = vars['--bg-terminal']
      expect(ground, `${key} has no --bg-terminal`).toBeTruthy()

      for (const token of SYNTAX_TOKENS) {
        const ink = vars[token]
        expect(ink, `${key} is missing ${token}`).toBeTruthy()
        const ratio = contrast(ink, ground)
        expect(
          ratio,
          `${key} ${token} = ${ink} on ${ground} is ${ratio.toFixed(2)}:1, under ${FLOOR}`,
        ).toBeGreaterThanOrEqual(FLOOR)
      }
    })
  }

  // The rule this fix had to obey: the token IS the recede. Stacking opacity on `--fg-muted` is
  // the documented way this ink has failed before, so `--syn-comment` is its own value.
  it('gives comments their own token rather than dimming --fg-muted', () => {
    for (const key of Object.keys(themes) as Array<keyof typeof themes>) {
      const vars = themes[key].vars as Record<string, string>
      expect(vars['--syn-comment'], key).not.toContain('color-mix')
      expect(vars['--syn-comment'], key).not.toContain('opacity')
    }
  })
})

// ── redline ink contrast, all six palettes ───────────────────────────────────────────────────
//
// `--measure-ink` is the text on the Preview's redline chips, drawn on `--bg-surface`. It is a mix,
// so it is resolved here the way the browser resolves `color-mix(in srgb, …)` (channel by channel)
// and measured. At the design's 70%, 1984-light measured 3.73:1 (magenta toward a dark fg on a light
// surface) and 60% only 4.53:1; it uses 55%, 4.99:1.

function resolveColor(vars: Record<string, string>, value: string): string {
  const v = value.trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) return resolveColor(vars, vars[ref[1]])
  const mix = /^color-mix\(in srgb, (.+) (\d+(?:\.\d+)?)%, (.+)\)$/.exec(v)
  if (mix) {
    const p = Number(mix[2]) / 100
    const [a, b] = [resolveColor(vars, mix[1]), resolveColor(vars, mix[3])]
      .map((h) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16)))
    return '#' + a.map((c, i) => Math.round(c * p + b[i] * (1 - p)).toString(16).padStart(2, '0')).join('')
  }
  return v.toLowerCase()
}

describe('redline tokens', () => {
  for (const key of Object.keys(themes) as Array<keyof typeof themes>) {
    const vars = themes[key].vars as Record<string, string>

    it(`${key}: --measure-ink clears ${FLOOR}:1 on --bg-surface`, () => {
      const ratio = contrast(resolveColor(vars, vars['--measure-ink']), vars['--bg-surface'])
      expect(ratio, `${key} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(FLOOR)
    })

    it(`${key}: --measure is neither the accent nor the grid hue`, () => {
      const measure = resolveColor(vars, vars['--measure'])
      expect(measure).not.toBe(resolveColor(vars, vars['--accent']))
      expect(measure).not.toBe(resolveColor(vars, vars['--grid']))
    })
  }
})
