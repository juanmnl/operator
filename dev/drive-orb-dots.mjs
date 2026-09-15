// THE RAIL ORB'S DOT COUNT, drawn. See dev/results/orb-dot-count.md.
//
// Every candidate geometry × every size StatusWave is ACTUALLY rendered at (audited from the
// call sites, 11–24 — 24 is the largest, not the only one), running beside resting, at
// deviceScaleFactor 2 so the sheet is real retina size rather than a zoom.
//
// THREE FRAMES ~0.55 s apart, because one still of a shimmer lies: the question is whether the
// mark holds its silhouette while its texture moves, and that is only visible across frames.
// Shot in WebKit (what the app ships in) AND Chromium (whose compositor the perf work was
// about), so the pixels can be checked to agree.
//
// Self-contained: the dot generation is transcribed from StatusWave.tsx and the palettes are
// scraped out of src/renderer/themes/*.ts, so no dev server and no build step.
//
// Run: `node dev/drive-orb-dots.mjs` → /tmp/operator-shots/orb-dots/
import { webkit, chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = '/tmp/operator-shots/orb-dots'
mkdirSync(OUT, { recursive: true })

// ── palettes, scraped from the theme modules ────────────────────────────────
const THEME_FILES = {
  'mission-control-dark': 'mission-control.ts', 'mission-control-light': 'mission-control-light.ts',
  '1984-dark': '1984.ts', 'mr-pink-light': 'mr-pink-light.ts',
}
const themes = {}
for (const [key, file] of Object.entries(THEME_FILES)) {
  const src = readFileSync(new URL('../src/renderer/themes/' + file, import.meta.url), 'utf8')
  const body = src.match(/export const \w*Vars[^=]*=\s*\{([\s\S]*?)\n\}/)[1]
  const vars = {}
  for (const line of body.split('\n')) {
    const m = line.match(/['"](--[a-z0-9-]+)['"]\s*:\s*['"]([^'"]*)['"]/i)
    if (m) vars[m[1]] = m[2]
  }
  themes[key] = vars
}

// ── the component, transcribed 1:1 from StatusWave.tsx ──────────────────────
const rand = (s) => { const x = Math.sin(s * 12.9898) * 43758.5453; return x - Math.floor(x) }
const hashSeed = (s) => { if (typeof s === 'number') return s; let h = 0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))%1000003; return h }
function gridPointsInDisc(cells, radius) {
  const out = []; const center = (cells - 1) / 2 + 0.5; const max = radius * radius * 1.04
  for (let c = 0; c < cells; c++) for (let r = 0; r < cells; r++) {
    const cx = c + 0.5, cy = r + 0.5, dx = cx - center, dy = cy - center
    if (dx*dx + dy*dy <= max) out.push({ cx, cy })
  }
  return out
}
const R = 0.5, REST_OP = 0.25, durMin = 1.4, durMax = 2.6, maxOp = 0.95

// Candidate layouts. `cells` sets the viewBox so every candidate draws the SAME
// physical disc diameter — only the dot count/size changes.
const CAND = [
  { key: 37, cells: 7, radius: 3.4, label: '37 · 7×7 r3.4 (SHIPPED)' },
  { key: 29, cells: 7, radius: 3.0, label: '29 · 7×7 r3.0' },
  { key: 21, cells: 5, radius: 2.4, label: '21 · 5×5 r2.4' },
  { key: 13, cells: 5, radius: 2.0, label: '13 · 5×5 r2.0' },
  {  key: 9, cells: 3, radius: 1.4, label:  '9 · 3×3 r1.4' },
]
// Every size StatusWave is actually rendered at, audited from the call sites.
const SIZES = [11, 12, 13, 14, 15, 17, 20, 24]

function orbSvg(c, size, seed, running, accent, initial) {
  const dots = gridPointsInDisc(c.cells, c.radius)
  const s = hashSeed(seed)
  const tempo = 0.82 + rand(s + 0.5) * 0.42
  // Scale the dot radius so a coarser grid still FILLS the disc: cell size grows
  // with a smaller `cells`, and r is in cell units, so R=0.5 is already correct.
  const circles = dots.map((d, i) => {
    if (!running) {
      const fill = accent ? `color-mix(in srgb, ${accent} 82%, var(--fg-muted))` : 'var(--fg-muted)'
      return `<circle cx="${d.cx}" cy="${d.cy}" r="${R}" style="opacity:${REST_OP};fill:${fill}"/>`
    }
    const dur = (durMin + rand(i+1+s)*(durMax-durMin)) * tempo
    const delay = -rand(i+7+s*1.7) * dur
    return `<circle cx="${d.cx}" cy="${d.cy}" r="${R}" style="transform-box:fill-box;transform-origin:center;animation:twinkle ${dur.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite"/>`
  }).join('')
  const vars = running
    ? `--tw-max:${maxOp};--tw-fill-peak:${accent || 'var(--green)'};`
    : ''
  const letter = initial ? `<span style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;line-height:1;font-size:${11*(size/24)}px;color:var(--fg);text-shadow:0 0 3px var(--bg-sidebar),0 0 3px var(--bg-sidebar),0 0 2px var(--bg-sidebar)">${initial}</span>` : ''
  return `<span style="position:relative;flex-shrink:0;display:inline-flex;line-height:0;${vars}">`
    + `<svg width="${size}" height="${size}" viewBox="0 0 ${c.cells} ${c.cells}" fill="none"><g fill="var(--fg)">${circles}</g></svg>${letter}</span>`
}

const ACCENTS = ['#2fe39a', '#c98bff', '#ff9f45', '#5ac8fa']

function themeBlock(tk, tv) {
  const varsCss = Object.entries(tv).map(([k,v]) => `${k}:${v}`).join(';')
  let rows = ''
  for (const c of CAND) {
    let cells = ''
    for (const size of SIZES) {
      cells += `<td><div class="pair">`
        + orbSvg(c, size, 'design', true, ACCENTS[0], null)
        + orbSvg(c, size, 'design', false, ACCENTS[0], null)
        + `</div><div class="sz">${size}</div></td>`
    }
    // The 24px rail case, with the letter, in all four lane accents.
    let rail = ''
    for (let i = 0; i < 4; i++) rail += orbSvg(c, 24, 'lane' + i, true, ACCENTS[i], 'RS'[i%2] === 'R' ? 'D' : 'RS')
    rows += `<tr><th>${c.label}</th>${cells}<td class="rail"><div class="pair">${rail}</div><div class="sz">24 · rail + letter</div></td></tr>`
  }
  return `<section style="${varsCss};background:var(--bg-sidebar);color:var(--fg)">
    <h2>${tk}</h2>
    <table><tr><th></th>${SIZES.map(s=>`<td class="hdr">${s}px</td>`).join('')}<td class="hdr">rail</td></tr>${rows}</table>
    <p class="cap">each cell: RUNNING orb, then the RESTING orb of the same geometry.</p>
  </section>`
}

const html = `<!doctype html><meta charset="utf-8"><style>
@keyframes twinkle {
  0%, 100% { opacity: 0.3; transform: scale(0.5); fill: var(--tw-fill, var(--fg-muted)); }
  50%      { opacity: var(--tw-max, 0.85); transform: scale(1); fill: var(--tw-fill-peak, var(--fg)); }
}
body{margin:0;font:12px/1.4 ui-sans-serif,system-ui;background:#222}
section{padding:14px 18px 18px}
h2{font:600 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.65;margin:0 0 10px}
table{border-collapse:collapse}
th{font:600 10px ui-monospace,monospace;text-align:right;padding-right:14px;white-space:nowrap;opacity:.8}
td{padding:5px 9px;text-align:center;vertical-align:middle}
td.hdr{font:10px ui-monospace,monospace;opacity:.5;padding-bottom:2px}
td.rail{padding-left:20px}
.pair{display:flex;align-items:center;gap:7px;justify-content:center;min-height:26px}
.sz{font:9px ui-monospace,monospace;opacity:.35;margin-top:3px}
.cap{font:10px ui-monospace,monospace;opacity:.4;margin:10px 0 0}
</style>
${Object.entries(themes).filter(([k]) => k.includes('mission-control') || k === '1984-dark' || k === 'mr-pink-light').map(([k,v]) => themeBlock(k,v)).join('')}`


const page = join(tmpdir(), 'operator-orb-dots.html')
writeFileSync(page, html)

for (const [name, engine] of [['wk', webkit], ['blink', chromium]]) {
  const browser = await engine.launch()
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1180, height: 1400 } })
  const p = await ctx.newPage()
  await p.goto('file://' + page)
  await p.waitForTimeout(700)
  for (const section of await p.$$('section')) {
    const theme = await section.$eval('h2', (e) => e.textContent)
    for (let f = 0; f < 3; f++) {
      await section.screenshot({ path: `${OUT}/${name}-${theme}-f${f}.png` })
      await p.waitForTimeout(550)
    }
  }
  await browser.close()
  console.log(name, '→', OUT)
}
