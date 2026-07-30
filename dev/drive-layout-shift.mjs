// Assert that NOTHING moves horizontally when a view gains a scrollbar.
//
// The bug: styles.css gives ::-webkit-scrollbar an explicit width, which in WebKit converts it
// from an overlay scrollbar (zero layout cost) to a CLASSIC one that eats 6px of the scroller's
// content box. A centred measure box then re-centres 3px to the left the moment its page grows
// past the fold — the whole page appears to jump.
//
// Each view is measured twice at the same width: once at a viewport tall enough that nothing
// scrolls, once short enough that everything does. Every probed left edge must be identical
// across the pair. That single equality IS the bug; without it this regresses silently.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-layout-shift.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
// Width is settable, and worth sweeping: the shift is most visible where `maxWidth` is NOT
// the binding constraint, because then the measure box tracks the container width directly.
const W = Number(process.env.W || 1200)
const TALL = 1800
const SHORT = 360

const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: W, height: TALL }, colorScheme: 'dark' })
// Pad the store so the gallery grid is long enough to scroll in the SHORT state.
await ctx.addInitScript(() => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const orig = v.loadProjects
      v.loadProjects = async () => {
        const base = (await orig()) ?? []
        const now = Date.now()
        return [...base, ...Array.from({ length: 15 }, (_, i) => ({
          id: `pad-${i}`, path: `/Users/jane/Developer/pad-${i}`, name: `pad-${i}`,
          createdAt: new Date(now).toISOString(),
          lastActiveAt: new Date(now - (i + 1) * 3600000).toISOString(), roster: [],
        }))]
      }
      v.saveProjects = () => {}
    },
  })
})

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

const lefts = (sels) => p.evaluate((sels) => {
  const out = {}
  for (const [name, sel] of Object.entries(sels)) {
    const el = document.querySelector(sel)
    out[name] = el ? Math.round(el.getBoundingClientRect().left) : null
  }
  // Any scroller that is actually paying the 6px, so a "no shift" pass can't be vacuous:
  // if nothing scrolled in the short state the test proved nothing.
  out._paying = Array.from(document.querySelectorAll('div'))
    .filter((d) => d.offsetWidth - d.clientWidth >= 4).length
  return out
}, sels)

const results = []
async function check(label, sels, settle = 700) {
  await p.setViewportSize({ width: W, height: TALL }); await p.waitForTimeout(settle)
  const tall = await lefts(sels)
  await p.setViewportSize({ width: W, height: SHORT }); await p.waitForTimeout(settle)
  const short = await lefts(sels)
  const moved = Object.keys(sels).filter((k) => tall[k] !== null && short[k] !== null && tall[k] !== short[k])
  const missing = Object.keys(sels).filter((k) => tall[k] === null || short[k] === null)
  results.push({ label, moved, missing, tall, short })
  console.log(`${moved.length === 0 ? '✓' : '✗'} ${label}`)
  console.log(`    tall  ${JSON.stringify(tall)}`)
  console.log(`    short ${JSON.stringify(short)}`)
  if (moved.length) console.log(`    MOVED: ${moved.map((k) => `${k} ${tall[k]}→${short[k]}`).join(', ')}`)
  if (missing.length) console.log(`    (not on screen: ${missing.join(', ')})`)
  await p.setViewportSize({ width: W, height: TALL }); await p.waitForTimeout(settle)
}

// ---- 1. Gallery — header vs cards, 18 projects ----------------------------------------
await p.keyboard.press('Meta+Shift+O'); await p.waitForTimeout(800)
await check('gallery', { header: 'h2', card: '[data-project-card]', tidy: '[data-tidy-bar]' })

// ---- 2. Project Home — the centred roster column ---------------------------------------
await p.locator('[data-project-card]').first().click(); await p.waitForTimeout(1000)
await check('projectHome · roster', { roleCard: '[data-role-card]', toolbar: '.drag-region span' })

// ---- 3. PageShell — the reference implementation ---------------------------------------
await p.keyboard.press('Meta+K'); await p.waitForTimeout(400)
await p.keyboard.type('preferences'); await p.waitForTimeout(400)
await p.keyboard.press('Enter'); await p.waitForTimeout(1000)
await check('prefs · PageShell', { title: '[data-page-title]', section: '[data-section-header]' })

// ---- 4. Agents hub — PageShell header over a split pane ---------------------------------
await p.keyboard.press('Meta+K'); await p.waitForTimeout(400)
await p.keyboard.type('agents'); await p.waitForTimeout(400)
await p.keyboard.press('Enter'); await p.waitForTimeout(1000)
await check('agents hub', { title: '[data-page-title]' })

// ---- 5. Chat — the transcript and the composer share one centre line ---------------------
// They are SIBLINGS by design: the transcript scrolls, the composer doesn't. If the transcript
// ever paid for a scrollbar they would disagree by 3px forever.
await p.keyboard.press('Escape'); await p.waitForTimeout(400)
await p.locator('[data-session-row]').first().click(); await p.waitForTimeout(1000)
// The label renders uppercase via CSS; its DOM text is "Chat".
await p.getByText(/^Chat$/).first().click(); await p.waitForTimeout(1400)
// `[data-chat-status]` is the composer-side row that explicitly claims the transcript's centre
// line, so it is the honest probe for "do the two halves agree".
await check('chat · transcript vs composer', { statusRow: '[data-chat-status]', canvas: 'canvas' })
const chatAlign = await p.evaluate(() => {
  const scroller = Array.from(document.querySelectorAll('.scroll-hidden'))
    .find((d) => d.scrollHeight > d.clientHeight + 1) ?? document.querySelector('.scroll-hidden')
  return { transcriptPays: scroller ? scroller.offsetWidth - scroller.clientWidth : null }
})
console.log('    transcript scrollbar cost:', chatAlign.transcriptPays,
  '(expect 0 — .scroll-hidden, so the composer sibling can never fall out of line with it)')

const failed = results.filter((r) => r.moved.length)
console.log(`\n${failed.length === 0 ? 'NO LAYOUT SHIFT' : `SHIFTED: ${failed.map((r) => r.label).join(', ')}`}`)
const proved = results.filter((r) => r.short._paying > 0).length
console.log(`views where a scrollbar actually appeared in the short state: ${proved}/${results.length}`)
await b.close()
