// Did the UI typefaces actually LOAD, and did anything they must not touch move?
// dev/briefs/landing-look-and-feel.md, part 1.
//
// `--font-body: 'Archivo'` and `--font-mono: 'JetBrains Mono'` have been in the tokens since they
// were written with no @font-face behind either, so every surface fell back to system-ui / SF Mono
// and the app never rendered in the type it declares. A declared family that isn't loaded fails
// SILENTLY — that is the whole reason this went unnoticed, and the reason it needs a driver rather
// than a screenshot: the fallback looks fine, it just isn't the design.
//
// Run: `./node_modules/.bin/vite --port 1436 --strictPort` then `node dev/drive-fonts.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1436
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3500)
await p.evaluate(() => document.fonts.ready)

// ---- 1. Are they loaded at all? --------------------------------------------------------------
const loaded = await p.evaluate(() => ({
  faces: [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`).sort(),
  archivo: document.fonts.check('600 13px Archivo'),
  jb: document.fonts.check('500 11px "JetBrains Mono"'),
}))
console.log('1 @font-face rules registered:')
for (const f of loaded.faces) console.log('   ', f)
console.log(`1 usable — Archivo: ${loaded.archivo}   JetBrains Mono: ${loaded.jb}`)

// ---- 2. Is the fallback actually different? --------------------------------------------------
// A family that failed to load resolves to the fallback and every measurement still looks
// plausible. Measuring the SAME string in the real family and in the fallback is what tells the
// two apart: identical widths mean the @font-face never took.
const widths = await p.evaluate(() => {
  const c = document.createElement('canvas').getContext('2d')
  const sample = 'Operator — dispatch 0123 lIl'
  const at = (font) => { c.font = font; return +c.measureText(sample).width.toFixed(2) }
  return {
    archivo: at('600 13px Archivo'),
    archivoFallback: at('600 13px system-ui'),
    jb: at('500 11px "JetBrains Mono"'),
    jbFallback: at('500 11px ui-monospace'),
  }
})
const d1 = +(widths.archivo - widths.archivoFallback).toFixed(2)
const d2 = +(widths.jb - widths.jbFallback).toFixed(2)
console.log(`\n2 same string, real family vs the fallback it has been using:`)
console.log(`    Archivo 600/13        ${widths.archivo}px   vs system-ui   ${widths.archivoFallback}px   Δ ${d1}`)
console.log(`    JetBrains Mono 500/11 ${widths.jb}px   vs ui-monospace ${widths.jbFallback}px   Δ ${d2}`)
console.log(`2 the families are genuinely distinct: ${d1 !== 0 && d2 !== 0}`)

// ---- 3. What is each real surface RESOLVING to? ----------------------------------------------
// The resolved stack, per surface, so a token change can't quietly miss one.
const used = await p.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    return getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim()
  }
  return {
    body: pick('body'),
    sidebarLane: pick('[data-session-item]') ?? pick('[data-rail-card-name]'),
    railAcronym: pick('[data-rail-initials]'),
    xtermRoot: pick('.xterm'),
    xtermRows: pick('.xterm-rows'),
    xtermMeasure: pick('.xterm-char-measure-element'),
  }
})
// NOTE: this is the DECLARED stack, not proof of what rendered — `fontFamily` reads back the
// same string whether or not the family ever loaded, which is exactly how this went unnoticed.
// Sections 1, 2 and 5 are the ones that prove anything.
console.log('\n3 first family DECLARED by each surface (not proof of use — see 1 and 5):')
for (const [k, v] of Object.entries(used)) console.log('    ' + k.padEnd(14), v ?? '(absent in this fixture)')

// ---- 4. THE TERMINAL MUST NOT MOVE -----------------------------------------------------------
// The brief's hard constraint, and the assertion has to name the right elements. `.xterm` and
// `.xterm-screen` DO inherit Archivo from body — they always inherited whatever body had — but
// they render no text. The two that decide a cell are `.xterm-rows` (what you see) and
// `.xterm-char-measure-element` (what xterm sizes the grid from), and both take the terminal's
// own stack from lib/terminal-options.ts, which never reads --font-mono. Checking `.xterm`
// instead reports a regression that isn't one; checking neither misses the one that would be.
const termClean = [used.xtermRows, used.xtermMeasure]
  .filter(Boolean).every((f) => !/JetBrains|Archivo/i.test(f))
console.log(`\n4 rows: ${used.xtermRows ?? '—'}   measure element: ${used.xtermMeasure ?? '—'}`)
console.log(`4 no UI typeface reached a cell-determining element: ${termClean}${termClean ? '' : '  ◀ REGRESSION'}`)

// ---- 5. Cell metrics, measured against the same page with the UI faces REMOVED ---------------
// The only claim worth making is that the number did not change. Deleting the two families from
// `document.fonts` puts the page back in its pre-vendoring state without a second run, so the
// two measurements come from one identical layout.
const cell = await p.evaluate(async () => {
  const read = () => {
    const m = document.querySelector('.xterm-char-measure-element')
    const r = document.querySelector('.xterm-rows > div')
    return {
      measure: m ? +m.getBoundingClientRect().width.toFixed(3) : null,
      row: r ? +r.getBoundingClientRect().width.toFixed(3) : null,
      rowH: r ? +r.getBoundingClientRect().height.toFixed(3) : null,
    }
  }
  const after = read()
  const drop = [...document.fonts].filter((f) => /Archivo|JetBrains/i.test(f.family))
  for (const f of drop) document.fonts.delete(f)
  document.body.offsetHeight
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return { after, before: read() }
})
if (!cell?.after?.measure) console.log('5 (no terminal mounted in this fixture)')
else {
  const same = JSON.stringify(cell.after) === JSON.stringify(cell.before)
  console.log(`\n5 terminal metrics WITH the UI faces:    ${JSON.stringify(cell.after)}`)
  console.log(`5 terminal metrics with them REMOVED:   ${JSON.stringify(cell.before)}`)
  console.log(`5 identical: ${same}${same ? '' : '  ◀ REGRESSION'}`)
}

await p.screenshot({ path: '/tmp/operator-shots/fonts-after.png' })
console.log(`\n${loaded.archivo && loaded.jb && d1 !== 0 && d2 !== 0 && termClean ? 'PASS' : 'FAIL'} — fonts load, differ from the fallback, and stay out of the terminal`)
await b.close()
