// Drive the BOTTOM-LEFT CORNER: the ProjectRail's foot and the Sidebar's footer row, which sit
// 1px apart across a hairline and read as one L-shaped cluster of app chrome — but were built
// by two different tasks and never measured against each other.
//
// What this asserts is BALANCE, not existence: the two rows' icon INK sits on one baseline
// (align ink, not boxes); the hit boxes and corner radii match; every control in the cluster
// answers the pointer the same way; and no icon recedes by stacking opacity on --fg-muted.
//
// Run against a vite dev server: `npx vite --port 1436` then `node dev/drive-corner-balance.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1436
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))

const boot = async () => { await p.waitForTimeout(3000) }

// Every control in the corner cluster, keyed by which row it belongs to. The measurement that
// matters is the ICON's box (the svg), not the button's — a button can be padded any which way
// and still look aligned; it's the drawn glyph the eye lines up.
const corner = () => p.evaluate(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) } }
  const read = (el, row) => {
    const svg = el.querySelector('svg')
    const s = getComputedStyle(el)
    return {
      row,
      id: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim().slice(0, 18),
      btn: box(el),
      ink: svg ? box(svg) : null,
      radius: s.borderTopLeftRadius,
      opacity: s.opacity,
      // The painted ink colour, so a hardcoded --fg-muted stroke under an opacity can be caught
      // as the composited value rather than as source text.
      stroke: svg ? (svg.getAttribute('stroke') || svg.querySelector('[stroke]')?.getAttribute('stroke') || null) : null,
    }
  }
  const railFoot = document.querySelector('[data-rail-gallery]')?.parentElement
  // Anchor on a BUTTON, not on the version string: the identity is wrapped in its own flex box
  // (so it can be left-anchored beside the icons without a basis that wraps), which moved it a
  // level deeper and silently emptied this probe when it read `identity.parentElement`.
  const sidebarFoot = document.querySelector('[data-sidebar-foot-btn]')?.parentElement
  const rail = railFoot ? Array.from(railFoot.querySelectorAll('button')).map((el) => read(el, 'rail')) : []
  const side = sidebarFoot ? Array.from(sidebarFoot.querySelectorAll('button')).map((el) => read(el, 'sidebar')) : []
  const identity = document.querySelector('[data-sidebar-identity]')
  // A lane row's orb, to check the footer icons line up with the column they sit under.
  const orb = document.querySelector('[data-session-row] svg, [data-lane-row] svg')
  return {
    rail, side,
    railFootBox: railFoot ? box(railFoot) : null,
    sidebarFootBox: sidebarFoot ? box(sidebarFoot) : null,
    identity: identity ? { ...box(identity), text: identity.textContent.trim(), size: getComputedStyle(identity).fontSize } : null,
    orbInk: orb ? box(orb) : null,
    railPad: railFoot ? getComputedStyle(railFoot).padding : null,
    sidePad: sidebarFoot ? getComputedStyle(sidebarFoot).padding : null,
  }
})

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await boot()

const c = await corner()

// ---- 1. One baseline across the corner --------------------------------------------------
// The rail's last icon and the sidebar's icons are 1px apart across the border. If their ink
// centres differ, the corner staggers — the single most visible defect here.
const railLast = c.rail[c.rail.length - 1]
const sideIcons = c.side.filter((s) => s.ink)
console.log('1 rail foot padding:', c.railPad, '· sidebar foot padding:', c.sidePad)
console.log('1 rail LAST icon ink cy:', railLast?.ink?.cy, `(${railLast?.id})`)
console.log('1 sidebar icon ink cys:', JSON.stringify(sideIcons.map((s) => s.ink.cy)))
const baselineDelta = sideIcons.length && railLast ? Math.abs(railLast.ink.cy - sideIcons[0].ink.cy) : null
console.log('1 BASELINE DELTA:', baselineDelta, 'px (expect 0 — align ink, not boxes)')

// ---- 2. One hit box, one radius ---------------------------------------------------------
console.log('2 rail buttons:', JSON.stringify(c.rail.map((r) => `${r.btn.w}x${r.btn.h} r${r.radius}`)))
console.log('2 sidebar buttons:', JSON.stringify(sideIcons.map((r) => `${r.btn.w}x${r.btn.h} r${r.radius}`)))
console.log('2 ink sizes — rail:', JSON.stringify(c.rail.map((r) => r.ink && `${r.ink.w}x${r.ink.h}`)),
  '· sidebar:', JSON.stringify(sideIcons.map((r) => `${r.ink.w}x${r.ink.h}`)))

// ---- 3. Nothing recedes by stacking opacity on --fg-muted -------------------------------
// The token IS the recede; multiplying it lands at 1.8–2.9:1 on the three light palettes.
console.log('3 opacities — rail:', JSON.stringify(c.rail.map((r) => r.opacity)),
  '· sidebar:', JSON.stringify(sideIcons.map((r) => r.opacity)), '(expect all "1")')
console.log('3 sidebar strokes:', JSON.stringify(sideIcons.map((r) => r.stroke)),
  '(expect currentColor — a hardcoded token cannot answer hover)')

// ---- 4. The whole cluster answers the pointer the same way ------------------------------
// Hovering each control in turn: a corner where three light up and four do nothing is not one
// cluster, it's two rows that happen to touch.
const hoverProbe = async (sel, i) => {
  const els = await p.locator(sel).all()
  const el = els[i]
  if (!el) return null
  const before = await el.evaluate((n) => { const s = getComputedStyle(n); return { bg: s.backgroundColor, color: s.color } })
  await el.hover()
  await p.waitForTimeout(220)
  const after = await el.evaluate((n) => { const s = getComputedStyle(n); return { bg: s.backgroundColor, color: s.color } })
  return { moved: before.bg !== after.bg || before.color !== after.color, before, after }
}
const railFootSel = '[data-rail-agents], [data-rail-gallery], [data-rail-open-folder], [data-rail-usage]'
for (let i = 0; i < c.rail.length; i++) {
  const r = await hoverProbe(`${railFootSel}`, i)
  console.log(`4 rail "${c.rail[i].id}" answers hover:`, r?.moved, r ? JSON.stringify(r.after) : '')
}
const sideSel = '[data-sidebar-identity]'
for (let i = 0; i < sideIcons.length; i++) {
  const els = await p.locator(`${sideSel}`).first().evaluate(() => null).then(() => null)
  const btn = p.locator('[data-sidebar-foot-btn]').nth(i)
  const n = await btn.count()
  if (!n) { console.log(`4 sidebar "${sideIcons[i].id}" — no probe hook`); continue }
  const before = await btn.evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color } })
  await btn.hover()
  await p.waitForTimeout(220)
  const after = await btn.evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color } })
  console.log(`4 sidebar "${sideIcons[i].id}" answers hover:`, before.bg !== after.bg || before.color !== after.color, JSON.stringify(after))
}

// ---- 5. The footer sits under the column it belongs to ----------------------------------
console.log('5 lane orb ink x:', c.orbInk?.x, '· sidebar footer first ink x:', sideIcons[0]?.ink?.x,
  '(expect equal — the footer is the same column)')

// ---- 6. Identity ------------------------------------------------------------------------
console.log('6 identity:', JSON.stringify(c.identity))

// ---- 7. The corner in every theme, and the ink it actually paints -----------------------
// The theme is read from localStorage at FIRST RENDER — there is no live attribute to flip —
// so each one needs its own boot. The three light palettes are the ones that matter: they are
// where a recede stacked on --fg-muted collapses, so this measures the composited ink rather
// than trusting that no opacity is left in the tree.
const THEMES = ['mission-control-dark', 'mission-control-light', 'mr-pink-dark', 'mr-pink-light', '1984-dark', '1984-light']
// WebKit returns a color-mix result as `color(srgb 0.31 0.33 0.36)` — 0-1 floats — while a plain
// token comes back as `rgb(138, 148, 160)`. Parsing both as 0-255 silently reports every mixed
// colour as near-black, which reads as a catastrophic contrast failure that isn't there. Sniff
// the form before scaling.
const chan = (c) => { const n = c.match(/[\d.]+/g).slice(0, 3).map(Number); return c.startsWith('color(') ? n : n.map((v) => v / 255) }
const lum = (c) => { const [r, g, bl] = chan(c).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl }
const ratio = (a, bg) => { const [x, y] = [lum(a), lum(bg)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
const fmt = (n) => n.toFixed(2).padEnd(6)

console.log('\n7 corner ink contrast, every palette. Both arms must paint the SAME ink (they share')
console.log('  one spec), clear 3:1 at rest, and the disabled step must recede without vanishing —')
console.log('  it is a color-mix toward the field, never an opacity over --fg-muted.')
console.log('  theme                  rail   sidebar  disabled')
for (const theme of THEMES) {
  const pg = await ctx.newPage()
  await pg.addInitScript((t) => { try { localStorage.setItem('operator.theme', t) } catch { /* quota */ } }, theme)
  await pg.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await pg.waitForTimeout(3000)
  const ink = await pg.evaluate(() => {
    const probe = document.createElement('span'); document.body.appendChild(probe)
    const at = (v) => { probe.style.color = ''; probe.style.color = v; return getComputedStyle(probe).color }
    // The disabled folder button needs a project with no path, which the fixture never has, so
    // its ink is measured from the same expression the component uses rather than off the DOM.
    const disabled = at('color-mix(in srgb, var(--fg-muted) 65%, var(--bg-sidebar))')
    const field = at('var(--bg-sidebar)')
    probe.remove()
    return {
      field, disabled,
      railInk: getComputedStyle(document.querySelector('[data-rail-gallery]')).color,
      sideInk: getComputedStyle(document.querySelector('[data-sidebar-foot-btn]')).color,
    }
  })
  const railR = ratio(ink.railInk, ink.field)
  const sideR = ratio(ink.sideInk, ink.field)
  const disR = ratio(ink.disabled, ink.field)
  const flags = [
    ink.railInk === ink.sideInk ? '' : ' <-- ARMS DIFFER',
    railR >= 3 && sideR >= 3 ? '' : ' <-- REST UNDER 3:1',
    disR >= 2 ? '' : ' <-- DISABLED VANISHING',
  ].join('')
  console.log(`  ${theme.padEnd(22)} ${fmt(railR)} ${fmt(sideR)}   ${fmt(disR)}${flags}`)
  await pg.screenshot({ path: `/tmp/operator-shots/corner-${theme}.png`, clip: { x: 0, y: 900 - 170, width: 300, height: 170 } })
  await pg.close()
}

await p.screenshot({ path: '/tmp/operator-shots/corner-full.png' })
await b.close()
