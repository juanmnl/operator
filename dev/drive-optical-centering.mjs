// Are the initials optically centred in their disc? — dev/briefs/optical-centering.md
//
// `getBoundingClientRect` on the span gives the LINE BOX, which is the thing `place-items:
// center` already centred perfectly — measuring it is why this passed unnoticed for so long. So
// this measures painted ink the same way `drive-rail-invariant.mjs` does: screenshot, hide the
// letters with `visibility: hidden` (no reflow), screenshot again, and the pixels that changed
// are the ink. The disc stays put underneath, so its centre comes from the same frames.
//
// `SKIP_FONTS=1` aborts the Archivo/JetBrains woff2 to measure the pre-vendoring state — the
// offset is a property of the typeface, so the two are different numbers, not one number
// measured twice.
//
// Run: `./node_modules/.bin/vite --port 1436 --strictPort` then `node dev/drive-optical-centering.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1436
const SKIP_FONTS = !!process.env.SKIP_FONTS
// BEFORE reproduces the shipped behaviour by neutralising `.ink-centred` at runtime: the letters
// go back to box-centred with the trailing letter-space intact. Same page, same layout, so the
// two numbers differ by the fix and nothing else.
const BEFORE = process.env.MODE === 'before'
// Device scale MATTERS here and is not just resolution. Glyph baselines are snapped to the
// DEVICE pixel grid at raster time, so the residual offset is a different number at 1x, 2x and
// 4x — measuring at 4x buys precision but describes a display nobody has. 2x is the user's.
const DSF = Number(process.env.DSF || 2)

const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: DSF })
// The channel's feed is empty in the bare mock, and an empty feed has no avatars — which is the
// one site the complaint actually named. Same seed as drive-project-channel.mjs: two authors, so
// both a one- and a two-letter initial appear.
await ctx.addInitScript(() => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true, get: () => real,
    set: (v) => {
      real = v
      const orig = v.loadProjects
      v.loadProjects = async () => ((await orig()) ?? []).map((p) => (p.name !== 'operator' ? p : {
        ...p,
        dispatches: [
          { id: 'd1', at: '2026-07-30T09:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'A dispatch with a two-letter author', outcome: 'sent' },
          { id: 'd2', at: '2026-07-30T09:05:00.000Z', fromRoleId: 'qa', toRoleId: 'design', task: 'A dispatch from a lane whose initials are QA', outcome: 'sent' },
          { id: 'd3', at: '2026-07-30T09:10:00.000Z', fromRoleId: 'research', toRoleId: 'code', task: 'A third, so the column is long enough to look at', outcome: 'queued' },
        ],
      }))
      v.saveProjects = () => {}
    },
  })
})
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
if (SKIP_FONTS) await p.route('**/*.woff2', (r) => (/archivo|jetbrains/i.test(r.request().url()) ? r.abort() : r.continue()))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
if (BEFORE) await p.addStyleTag({ content: '.ink-centred{transform:none !important;margin-right:0 !important}' })
// MODE=noshift keeps the horizontal cancellation but drops the vertical transform, to ask
// whether the sub-pixel nudge earns its place at the device scale people actually use.
if (process.env.MODE === 'noshift') await p.addStyleTag({ content: '.ink-centred{transform:none !important}' })
await p.waitForTimeout(4500)
// The channel is where the complaint came from, and its avatars only exist once it is open.
await p.locator('[data-channel-nav]').first().click().catch(() => {})
await p.waitForTimeout(1500)

/** Ink bbox of `sel`, in CSS px relative to the clip, by hiding it and diffing. */
async function inkBox(page, clip, sel) {
  const shot = () => page.screenshot({ clip, animations: 'disabled' })
  const before = await shot()
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return false
    el.dataset.prevVis = el.style.visibility
    el.style.visibility = 'hidden'
    return true
  }, sel)
  if (!ok) return null
  const after = await shot()
  await page.evaluate((s) => {
    const el = document.querySelector(s)
    el.style.visibility = el.dataset.prevVis || ''
    delete el.dataset.prevVis
  }, sel)
  return page.evaluate(async ([a, c, cssW]) => {
    const load = (s) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + s })
    const [A, B] = await Promise.all([load(a), load(c)])
    const cw = A.width, ch = A.height
    const px = (im) => { const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0); return x.getImageData(0, 0, cw, ch).data }
    const da = px(A), db = px(B)
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, n = 0
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 6) {
        n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
    if (!n) return null
    const s = cw / cssW
    return { left: minX / s, right: (maxX + 1) / s, top: minY / s, bottom: (maxY + 1) / s }
  }, [before.toString('base64'), after.toString('base64'), clip.width])
}

// disc = the element that draws the circle/tile; letters = the span to hide.
const SITES = [
  // The letters selector must name ONLY the letters. A selector LIST here returns whichever
  // match comes first in document order — which is the avatar itself, its own ancestor — so the
  // whole disc got hidden and the "ink" measured was the circle. Before and after read the same
  // and looked like the fix had not applied.
  { key: 'channel avatar', disc: '[data-channel-avatar]', letters: '[data-channel-avatar] > .ink-centred' },
  { key: 'rail tile', disc: '[data-rail-tile]', letters: '[data-rail-initials]' },
]

console.log(`${BEFORE ? 'BEFORE — box-centred (.ink-centred neutralised)' : 'AFTER  — ink-centred'}`
  + `${SKIP_FONTS ? '   Archivo BLOCKED (the fallback the app shipped in)' : '   Archivo loaded'}`)
console.log(`device scale: ${DSF}x   (baselines snap to the device grid, so this changes the answer)`)
console.log(`nudge in use: ${await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink-nudge').trim() || '(stylesheet literal)')}`)
console.log('\n' + 'SITE'.padEnd(18) + 'TEXT   DISC CENTRE      INK CENTRE       Δx      Δy')
console.log('-'.repeat(76))

let worst = 0
for (const s of SITES) {
  const info = await p.evaluate(([d, l]) => {
    const disc = document.querySelector(d)
    if (!disc) return null
    const r = disc.getBoundingClientRect()
    const el = document.querySelector(l)
    const lb = el?.getBoundingClientRect()
    const cs = el && getComputedStyle(el)
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      text: (el?.textContent || '').trim(),
      // The LINE BOX — the thing `place-items: center` centres, and the thing that is already
      // correct. If this is off-centre too, the defect is placement, not baseline.
      box: lb && { top: lb.top - r.top, h: lb.height, centreY: (lb.top + lb.height / 2) - (r.top + r.height / 2) },
      font: cs && `${cs.fontSize}/${cs.lineHeight} ${cs.fontWeight}`,
    }
  }, [s.disc, s.letters])
  if (!info) { console.log(s.key.padEnd(18) + '(absent in this fixture)'); continue }
  // Clip generously around the disc so a nudge can't push ink outside the frame.
  const clip = { x: info.rect.x - 6, y: info.rect.y - 6, width: info.rect.w + 12, height: info.rect.h + 12 }
  const ink = await inkBox(p, clip, s.letters)
  if (!ink) { console.log(s.key.padEnd(18) + '(letters paint nothing)'); continue }
  const dc = { x: 6 + info.rect.w / 2, y: 6 + info.rect.h / 2 }
  const ic = { x: (ink.left + ink.right) / 2, y: (ink.top + ink.bottom) / 2 }
  const dx = ic.x - dc.x, dy = ic.y - dc.y
  worst = Math.max(worst, Math.abs(dx), Math.abs(dy))
  console.log(
    s.key.padEnd(18) + `"${info.text}"`.padEnd(7) +
    `${dc.x.toFixed(2)}, ${dc.y.toFixed(2)}`.padEnd(16) +
    `${ic.x.toFixed(2)}, ${ic.y.toFixed(2)}`.padEnd(17) +
    `${dx >= 0 ? '+' : ''}${dx.toFixed(2)}`.padStart(6) + '  ' +
    `${dy >= 0 ? '+' : ''}${dy.toFixed(2)}`.padStart(6) +
    (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3 ? '  ◀' : ''),
  )
  console.log(`  ${' '.repeat(16)}font ${info.font}   line box h ${info.box?.h?.toFixed(2)} `
    + `offset from disc centre ${info.box?.centreY >= 0 ? '+' : ''}${info.box?.centreY?.toFixed(2)}`
    + `   ink within box: top +${(ink.top - (6 + info.box.top)).toFixed(2)} bottom -${((6 + info.box.top + info.box.h) - ink.bottom).toFixed(2)}`
    + `  h ${(ink.bottom - ink.top).toFixed(2)}`)
}
console.log('-'.repeat(76))
console.log(`worst |Δ| ${worst.toFixed(2)}px   (Δy positive = ink sits LOW, negative = ink sits HIGH)`)

// A column of avatars at 4x — the complaint is optical and the number is the check, not the goal.
const av = await p.evaluate(() => {
  const els = [...document.querySelectorAll('[data-channel-avatar]')]
  if (!els.length) return null
  const first = els[0].getBoundingClientRect(), last = els[Math.min(3, els.length - 1)].getBoundingClientRect()
  return { x: first.left - 8, y: first.top - 8, width: 40, height: last.bottom - first.top + 16 }
})
if (av) await p.screenshot({ path: `/tmp/operator-shots/optical-${BEFORE ? 'before' : 'after'}${SKIP_FONTS ? '-fallback' : ''}.png`, clip: av })
await b.close()
