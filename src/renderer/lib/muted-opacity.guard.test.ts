import { describe, it, expect } from 'vitest'

// THE GUARD. Never stack an `opacity` on text already coloured `var(--fg-muted)` — the token
// IS the recede, and stacking measures 1.8–2.9:1, effectively invisible on the three light
// palettes. Hierarchy comes from token + size, never a second alpha.
//
// This rule has been swept by hand at least four times (ActivityDashboard; the project-first
// four-theme pass, 24 instances; the settings-page template, ~8; review's §5, 4 more) and the
// count kept climbing — it reached 63 across 23 files. A rule enforced only by review is not
// enforced, so it lives here now, in `npm test`, where every lane and CI hits it.
//
// Deliberately cheap and always-on rather than thorough and occasional: the six-palette
// contrast sweep in dev/drive-theme-pass.mjs still measures the real thing, but it needs a
// browser and nobody runs it on every change.

// Sources are read through Vite's own glob rather than node:fs — it needs no @types/node,
// and it resolves the same files the app actually builds from.
const SOURCES = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Strip comments so the guard matches DECLARATIONS, not the prose explaining the rule —
 *  several files carry a comment naming `--fg-muted` and `opacity` in the same breath. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

/** An `opacity` whose value is a real fade. `0` and `1` are not fades — a reveal that goes
 *  0 → 1 is legitimate, and so is an explicit full-strength 1. */
function fadingOpacity(objectBody: string): string | null {
  const re = /opacity:\s*([^,}\n]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(objectBody))) {
    const expr = m[1].trim()
    // Collect every numeric literal in the expression (handles ternaries like `x ? 1 : 0.4`).
    const nums = expr.match(/\d*\.?\d+/g)?.map(Number) ?? []
    if (nums.length === 0) continue                    // a variable — can't judge, don't fail
    if (nums.some((n) => n > 0 && n < 1)) return expr  // any partial alpha is the violation
  }
  return null
}

/** Every `style={{ … }}` object in a file, with its line number. */
function styleObjects(src: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = []
  const re = /style=\{\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 2
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, body: src.slice(m.index, i) })
  }
  return out
}

describe('no stacked opacity on --fg-muted', () => {
  it('every muted-coloured element carries the token alone', () => {
    // A guard that reads nothing passes vacuously — the worst failure mode for a guard.
    expect(Object.keys(SOURCES).length, 'the source glob resolved no files').toBeGreaterThan(30)
    const violations: string[] = []
    for (const [file, raw] of Object.entries(SOURCES)) {
      const src = stripComments(raw)
      for (const { line, body } of styleObjects(src)) {
        // The rule is about INK: an element whose `color` is the muted token. A muted border
        // or fill beside an opacity is a weaker case and is judged by eye, not failed here.
        const colorsMuted = /color:\s*[^,}\n]*var\(--fg-muted\)/.test(body)
        if (!colorsMuted) continue
        const fade = fadingOpacity(body)
        if (fade) violations.push(`${file.replace('../', 'src/renderer/')}:${line}  opacity: ${fade}`)
      }
    }
    expect(violations, `stacked opacity on --fg-muted (the token already recedes):\n${violations.join('\n')}`).toEqual([])
  })
})
