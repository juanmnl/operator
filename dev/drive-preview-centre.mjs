// THE PREVIEW STAGE — a device preset sits CENTRED, and the three things that draw over the page
// all agree with it. dev/briefs/2026-08-04-preview-centre.md
//
// The panel used to render a preset with `transformOrigin: 'top left'` inside a full-width
// wrapper, so the page was pinned left with all the slack in one gutter. But the wrapper was also
// the coordinate system for the ANNOTATION pins (percentages), the capture overlay (`inset: 0`)
// and the native INSPECT webview (a rect) — so at any preset narrower than the panel those three
// were resolving against a box that included the empty gutter. That drift is older than the
// centring; centring only makes it symmetrical.
//
// This driver measures the rendered panel, which is the only place all four can be seen agreeing.
//
//   C1. `fit` is untouched — stage == wrapper, no letterbox.
//   C2. a NARROW preset centres: equal gutters (left == right), stage width == the preset, and
//       the page still top-aligned.
//   C3. a preset WIDER than the panel is pixel-identical to before: stage == wrapper, gutter 0.
//   C4. the IFRAME's painted box == the stage, in every case. (`getBoundingClientRect` reports the
//       TRANSFORMED box, so this measures where the page actually lands, not its layout width.)
//   C5. the INSPECT rect handed to the native webview is the STAGE's, not the wrapper's — the one
//       assertion that proves the inspector lands over the page rather than the gutter.
//   C6. an annotation dropped at 25% across the PAGE stores xPct ≈ 25 — and renders back onto the
//       same page fraction after a preset switch and after a panel resize.
//
// Run: `./node_modules/.bin/vite --port 1437 --strictPort` then `node dev/drive-preview-centre.mjs`
// (the previewed page is served by this script on 1438).
import { webkit } from 'playwright'
import http from 'node:http'

const PORT = process.env.MOCK_PORT || 1437
const APP_PORT = 1438

// The page under preview. Deliberately NOT the mock app on 1437 — pointing the preview at the
// harness makes it load a second copy of Operator inside its own iframe. A plain document with
// three quarter-width bands is enough, and the bands make a mis-centred page obvious in a shot.
const PAGE = `<!doctype html><meta charset=utf-8><title>preview target</title>
<style>html,body{margin:0;height:100%;font:14px system-ui}
.b{height:33.33%;display:grid;place-items:center}
#a{background:#fde68a}#b{background:#a7f3d0}#c{background:#bfdbfe}</style>
<div class=b id=a>TOP</div><div class=b id=b>MIDDLE</div><div class=b id=c>BOTTOM</div>`

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(APP_PORT, r))

const out = []
const check = (ok, line) => { out.push(`${ok ? '  ok  ' : ' FAIL '} ${line}`); return ok }
let pass = true
/** Sub-pixel tolerance. Everything here is a layout number, so this is slack for a fractional
 *  gutter and a device-pixel rounding, not for a real offset. */
const near = (a, b, tol = 0.75) => Math.abs(a - b) <= tol

async function open({ width, height }) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ viewport: { width, height } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('operator.theme', 'mission-control-dark')
      localStorage.setItem('operator.sidebarCollapsed', '1')
    } catch { /* quota */ }
    // RECORD what the inspector is handed. `previewInspectOpen`/`Move` are noops in the mock
    // bridge, so the rect is the only observable — and it is exactly the thing C5 is about.
    window.__inspect = []
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        v.previewInspectOpen = async (url, left, top, w, h) => { window.__inspect.push({ call: 'open', url, left, top, w, h }) }
        v.previewInspectMove = (left, top, w, h) => { window.__inspect.push({ call: 'move', left, top, w, h }) }
        v.previewInspectClose = () => {}
      },
    })
  })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  await p.waitForTimeout(1200)
  // Open a live lane, then the Preview surface.
  await p.click('[data-rail-session]')
  await p.waitForTimeout(400)
  await p.click('[title="Preview view"]')
  await p.waitForTimeout(400)
  // Point it at the page this script serves — through the panel's own URL editor, which is the
  // path a person takes. Seeding the localStorage key would need the session's id.
  await p.click('[title^="Click to set the preview target"]')
  await p.fill('input[placeholder="port or URL"]', String(APP_PORT))
  await p.press('input[placeholder="port or URL"]', 'Enter')
  await p.waitForSelector('iframe[title="App preview"]', { timeout: 15000 })
  await p.waitForTimeout(900)
  return { browser, p }
}

const setPreset = async (p, label) => { await p.click(`[title="${label}"]`); await p.waitForTimeout(350) }

/** The three boxes that must agree, in viewport coordinates.
 *
 *  IMPLEMENTATION-AGNOSTIC ON PURPOSE. "The stage" falls back to the IFRAME's painted box when no
 *  `[data-preview-stage]` exists, so this driver measures the same four claims against the code
 *  before the fix as after it. A harness keyed to an element the fix introduces would "fail"
 *  beforehand by throwing, which proves only that the element is new — the pre-fix numbers are
 *  the diagnosis, and they should be readable. */
const geom = (p) => p.evaluate(() => {
  const frame = document.querySelector('iframe[title="App preview"]')
  const stage = document.querySelector('[data-preview-stage]') ?? frame
  const wrap = document.querySelector('[data-preview-stage]')?.parentElement ?? frame?.parentElement
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, h: b.height } }
  return { stage: r(stage), wrap: r(wrap), frame: r(frame), staged: !!document.querySelector('[data-preview-stage]') }
})

// ── The wide panel: fit, 375 and 768 all fit inside it ──────────────────────────────────────
{
  const { browser, p } = await open({ width: 1440, height: 900 })

  await setPreset(p, 'Fit to panel')
  let g = await geom(p)
  pass = check(near(g.stage.left, g.wrap.left) && near(g.stage.w, g.wrap.w),
    `C1 fit: stage == wrapper (${g.stage.w.toFixed(1)} wide at x ${g.stage.left.toFixed(1)}; wrapper ${g.wrap.w.toFixed(1)} at ${g.wrap.left.toFixed(1)})`) && pass
  pass = check(near(g.stage.h, g.wrap.h), `C1 fit: full height, no letterbox — ${g.stage.h.toFixed(1)} of ${g.wrap.h.toFixed(1)}`) && pass
  pass = check(near(g.frame.w, g.stage.w) && near(g.frame.left, g.stage.left), `C4 fit: iframe fills the stage`) && pass

  for (const [label, px] of [['375px wide', 375], ['768px wide', 768]]) {
    await setPreset(p, label)
    g = await geom(p)
    const gl = g.stage.left - g.wrap.left
    const gr = (g.wrap.left + g.wrap.w) - (g.stage.left + g.stage.w)
    pass = check(near(gl, gr), `C2 ${px}: gutters EQUAL — left ${gl.toFixed(1)}px, right ${gr.toFixed(1)}px`) && pass
    pass = check(near(g.stage.w, px), `C2 ${px}: stage is the preset wide — ${g.stage.w.toFixed(1)}`) && pass
    pass = check(near(g.stage.top, g.wrap.top), `C2 ${px}: still TOP-aligned — stage top == wrapper top`) && pass
    pass = check(near(g.frame.w, g.stage.w) && near(g.frame.left, g.stage.left) && near(g.frame.h, g.stage.h),
      `C4 ${px}: iframe's painted box == the stage (${g.frame.w.toFixed(1)}×${g.frame.h.toFixed(1)} at ${g.frame.left.toFixed(1)})`) && pass
  }

  // ── C5: what the inspector is handed ──────────────────────────────────────────────────────
  await setPreset(p, '375px wide')
  await p.click('[title^="Inspect elements"]')
  await p.waitForTimeout(500)
  const g375 = await geom(p)
  const opened = await p.evaluate(() => window.__inspect.filter((c) => c.call === 'open').at(-1))
  pass = check(opened && near(opened.left, g375.stage.left) && near(opened.w, g375.stage.w),
    `C5 375: inspect rect == STAGE (${opened?.w?.toFixed(1)} at ${opened?.left?.toFixed(1)}; stage ${g375.stage.w.toFixed(1)} at ${g375.stage.left.toFixed(1)}; wrapper is ${g375.wrap.w.toFixed(1)} at ${g375.wrap.left.toFixed(1)})`) && pass
  // …and it must FOLLOW a preset change, which no longer moves `box` at all.
  await setPreset(p, '768px wide')
  await p.waitForTimeout(500)
  const g768 = await geom(p)
  const moved = await p.evaluate(() => window.__inspect.at(-1))
  pass = check(moved && near(moved.w, g768.stage.w) && near(moved.left, g768.stage.left),
    `C5 768: inspect FOLLOWS the preset switch — moved to ${moved?.w?.toFixed(1)} at ${moved?.left?.toFixed(1)} (stage ${g768.stage.w.toFixed(1)} at ${g768.stage.left.toFixed(1)})`) && pass
  await p.click('[title="Stop inspecting"]')
  await p.waitForTimeout(300)

  // ── C6: an annotation is a fraction of the PAGE ───────────────────────────────────────────
  await setPreset(p, '375px wide')
  await p.click('[title="Pin/box feedback over the app"]')
  await p.waitForTimeout(300)
  const gA = await geom(p)
  // 25% across the page, 40% down — deliberately OFF-CENTRE. The stage's centre is also the
  // wrapper's centre, so a click in the middle would agree under the bug too and prove nothing.
  const target = { x: gA.stage.left + gA.stage.w * 0.25, y: gA.stage.top + gA.stage.h * 0.40 }
  await p.mouse.click(target.x, target.y)
  await p.waitForTimeout(300)
  await p.fill('textarea[placeholder="What should change here?"]', 'centre check')
  await p.press('textarea[placeholder="What should change here?"]', 'Enter')
  await p.waitForTimeout(400)
  const ann = await p.evaluate(() => {
    const k = Object.keys(localStorage).find((s) => s.startsWith('operator.preview.annotations.'))
    const list = k ? JSON.parse(localStorage.getItem(k)) : []
    return list.at(-1) ?? null
  })
  pass = check(ann && near(ann.xPct, 25, 1.5),
    `C6: a pin at 25% across the PAGE stores xPct ${ann?.xPct?.toFixed(2)} (wrapper-relative would have been ${(((gA.stage.left - gA.wrap.left) + gA.stage.w * 0.25) / gA.wrap.w * 100).toFixed(2)})`) && pass
  pass = check(ann?.viewport && near(ann.viewport.w, 375),
    `C6: the note records the PAGE's viewport — ${ann?.viewport?.w}×${ann?.viewport?.h}, device ${ann?.device}`) && pass

  // …and it renders back onto the same page fraction after a preset switch.
  await setPreset(p, '768px wide')
  const pinAt = async () => {
    const g2 = await geom(p)
    const x = await p.evaluate(() => {
      // Whichever box the pins were parented to — the stage after the fix, the wrapper before it.
      const host = document.querySelector('[data-preview-stage]')
        ?? document.querySelector('iframe[title="App preview"]')?.parentElement
      const pin = host?.querySelector(':scope > div[title]')
      return pin ? pin.getBoundingClientRect().left : null
    })
    return { x, want: g2.stage.left + g2.stage.w * 0.25, stage: g2.stage }
  }
  let r = await pinAt()
  pass = check(r.x != null && near(r.x, r.want, 1.5),
    `C6: after switching to 768 the pin is still 25% across the page — x ${r.x?.toFixed(1)} vs ${r.want.toFixed(1)}`) && pass
  // …and after a panel resize, which is the other half of "stays on that feature".
  await p.setViewportSize({ width: 1180, height: 820 })
  await p.waitForTimeout(600)
  r = await pinAt()
  pass = check(r.x != null && near(r.x, r.want, 1.5),
    `C6: after resizing the window the pin is still 25% across the page — x ${r.x?.toFixed(1)} vs ${r.want.toFixed(1)}`) && pass
  const gR = await geom(p)
  const glR = gR.stage.left - gR.wrap.left
  const grR = (gR.wrap.left + gR.wrap.w) - (gR.stage.left + gR.stage.w)
  pass = check(near(glR, grR), `C2 after resize: gutters still equal — ${glR.toFixed(1)} / ${grR.toFixed(1)}`) && pass

  await browser.close()
}

// ── C7: a note written by the OLD code lands on its page feature after migration ────────────
//
// The unit tests in `lib/annotations.test.ts` cover the arithmetic. What they cannot cover is the
// wiring: that `loadAnnotations` migrates on read, writes the result back once, and that the pin
// then renders on the page rather than where the old panel-relative percentage pointed. So this
// seeds a genuine v1 record — no `v`, `viewport` = the WRAPPER's box, as the old panel wrote it —
// and reloads the app so the real load path runs.
{
  const { browser, p } = await open({ width: 1440, height: 900 })
  await setPreset(p, '375px wide')
  const g = await geom(p)
  // How the OLD code would have stored a click 25% across a 375px page: the page was pinned to
  // the wrapper's left, so the click landed at 93.75px and was divided by the WRAPPER's width.
  const oldXPct = (0.25 * 375) / g.wrap.w * 100
  const seeded = await p.evaluate(([xPct, w, h]) => {
    // `storageKey` is `main-<sessionId>` and the panel prefixes it again — the session id is on
    // the rail's own row, so the key can be derived rather than guessed.
    const id = document.querySelector('[data-rail-session][aria-current]')?.getAttribute('data-rail-session')
      ?? document.querySelector('[data-rail-session]')?.getAttribute('data-rail-session')
    const key = `operator.preview.annotations.main-main-${id}`
    localStorage.setItem(key, JSON.stringify([{
      id: 'legacy-1', xPct, yPct: 40, note: 'from the old coordinate system',
      route: '/', viewport: { w, h }, device: '375px', createdAt: '2026-08-01T00:00:00.000Z',
    }]))
    return { key, xPct }
  }, [oldXPct, g.wrap.w, g.wrap.h])

  // Reload so the panel mounts fresh and `loadAnnotations` runs for real. The pinned port is
  // persisted, so the preview comes back up on its own.
  await p.reload({ waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  await p.waitForTimeout(1200)
  await p.click('[data-rail-session]')
  await p.waitForTimeout(400)
  await p.click('[title="Preview view"]')
  await p.waitForSelector('iframe[title="App preview"]', { timeout: 15000 })
  await p.waitForTimeout(700)
  await setPreset(p, '375px wide')
  await p.click('[title="Pin/box feedback over the app"]')
  await p.waitForTimeout(400)

  const stored = await p.evaluate((key) => JSON.parse(localStorage.getItem(key))[0], seeded.key)
  pass = check(near(stored.xPct, 25, 0.05),
    `C7: the stored note was re-based on read — ${seeded.xPct.toFixed(2)}% of the panel → ${stored.xPct?.toFixed(2)}% of the page`) && pass
  pass = check(stored.v === 2 && stored.viewport?.w === 375,
    `C7: written back once, stamped v${stored.v}, viewport restated as the page (${stored.viewport?.w}×${stored.viewport?.h})`) && pass

  const gm = await geom(p)
  const pinX = await p.evaluate(() => {
    const host = document.querySelector('[data-preview-stage]')
      ?? document.querySelector('iframe[title="App preview"]')?.parentElement
    const pin = host?.querySelector(':scope > div[title]')
    return pin ? pin.getBoundingClientRect().left : null
  })
  const want = gm.stage.left + gm.stage.w * 0.25
  const wouldHaveBeen = gm.wrap.left + gm.wrap.w * (seeded.xPct / 100)
  pass = check(pinX != null && near(pinX, want, 1.5),
    `C7: the migrated pin renders on its page feature — x ${pinX?.toFixed(1)} vs ${want.toFixed(1)} (un-migrated it would have drawn at ${wouldHaveBeen.toFixed(1)})`) && pass

  // Idempotence, against the real store: a second load must not rebase it again.
  await p.reload({ waitUntil: 'load' })
  await p.waitForTimeout(1500)
  const again = await p.evaluate((key) => JSON.parse(localStorage.getItem(key))[0], seeded.key)
  pass = check(near(again.xPct, stored.xPct, 0.001),
    `C7: a second load does NOT rebase again — still ${again.xPct?.toFixed(2)}%`) && pass
  await browser.close()
}

// ── The narrow panel: 1280 is WIDER than it, so nothing may change ──────────────────────────
{
  const { browser, p } = await open({ width: 1000, height: 800 })
  await setPreset(p, '1280px wide')
  const g = await geom(p)
  pass = check(g.wrap.w < 1280, `C3 setup: the panel (${g.wrap.w.toFixed(1)}) really is narrower than the preset`) && pass
  pass = check(near(g.stage.left, g.wrap.left) && near(g.stage.w, g.wrap.w),
    `C3 1280: stage == wrapper, gutter 0 — pixel-identical to before (${g.stage.w.toFixed(1)} at ${g.stage.left.toFixed(1)})`) && pass
  pass = check(near(g.frame.w, g.wrap.w) && near(g.frame.left, g.wrap.left),
    `C4 1280: the scaled iframe still paints edge to edge — ${g.frame.w.toFixed(1)} at ${g.frame.left.toFixed(1)}`) && pass
  pass = check(near(g.frame.h, g.wrap.h), `C3 1280: no new letterbox — painted height ${g.frame.h.toFixed(1)} of ${g.wrap.h.toFixed(1)}`) && pass
  await browser.close()
}

server.close()
console.log(out.join('\n'))
console.log(pass ? '\nPREVIEW CENTRE: all assertions pass' : '\nPREVIEW CENTRE: FAILED')
process.exit(pass ? 0 : 1)
