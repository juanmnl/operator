// PREVIEW SCREENSHOT — is the toolbar's screenshot the page at its set size, sharp, and clean?
//
//   node probes/build.mjs && npx electron probes/preview-screenshot.cjs
//
// Hidden windows only. A host page lays out a stage and a cross-origin preview iframe the way
// AppPreviewPanel does, then the capture runs with the real modules: tileWindow / tilePlan / tileShift
// (src/shared/preview-screenshot.ts) drive the iframe's shift, captureTile + takeTiles
// (preview-screenshot-capture.ts) capture and stitch, and preview-inspect.ts `setDrawingHidden` hides
// what Operator draws in the page. Checked per case:
//   SIZE    the image is the page's CSS size times the display ratio (1280×1792 at 2x is 2560×3584)
//   SHARP   1px black/white stripes stay pure black and white (a scaled-up capture turns them grey)
//   PLACE   a red box at page (200, 300) 100×50 lands there; the blue 10×10 in the viewport's bottom
//           right corner is complete, so the whole page was captured
//   CLEAN   no inspector hover outline (#00aa00) and no stand-in overlay (#ff00ff) in the image, and
//           both are visible again afterwards; a compose card (#__op_compose) the page adds DURING the
//           capture is not in the image either
//   RASTER  the lower page is a canvas at full device resolution under 300 composited layers, all
//           cyan: every pixel of it is cyan in the image, so no tile was taken before the
//           out-of-process iframe had drawn the area the shift moved into view. NO_PAINT_WAIT=1 runs
//           without main's wait for the page's own frame (preview-inspect.ts `framePainted`), to see
//           whether this page needs it
//   ZOOM    one case runs the host at 125% (⌘+): the image is still the page at the page's own
//           position, at screen scale × 1.25 (the 1px stripes cannot stay pure there, so SHARP is
//           not checked)
// Also, for comparison: what CDP `Page.captureScreenshot` with `clip.scale` gives on the scaled case
// (the alternative the tiles replace). Nothing is written to ~/Downloads or the clipboard.
const { app, BrowserWindow, nativeImage } = require('electron')
const { createServer } = require('node:http')
const { join } = require('node:path')

const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 120_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; background: #fff }
#stripes { position: absolute; left: 0; top: 0; width: 160px; height: 120px; background: repeating-linear-gradient(90deg, #000 0 1px, #fff 1px 2px) }
#target { position: absolute; left: 200px; top: 300px; width: 100px; height: 50px; background: #ff0000 }
#corner { position: fixed; right: 0; bottom: 0; width: 10px; height: 10px; background: #0000ff; z-index: 2 }
html { overflow: hidden }
#heavy { position: absolute; left: 0; top: 400px; width: 100vw; height: calc(100vh - 420px) }
.layer { position: absolute; width: 37px; height: 23px; background: #00ffff; will-change: transform }
</style><div id="stripes"></div><div id="target"></div><canvas id="heavy"></canvas><div id="corner"></div>
<div data-operator-overlay style="position:fixed;left:20px;top:150px;width:40px;height:40px;background:#ff00ff"></div>
<script>
  // Drawn on load and again on every resize (a zoom is one): sized at script time, the canvas can
  // get the iframe's size before its layout settles, which is 0×0.
  const c = document.getElementById('heavy')
  function draw() {
    const r = c.getBoundingClientRect(), k = devicePixelRatio
    c.width = Math.round(r.width * k); c.height = Math.round(r.height * k)
    const g = c.getContext('2d')
    g.fillStyle = '#00ffff'; g.fillRect(0, 0, c.width, c.height)
    for (let i = 0; i < 20000; i++) g.fillRect((i * 7919) % c.width, (i * 104729) % c.height, 3, 3)
  }
  addEventListener('load', () => {
    const r = c.getBoundingClientRect()
    for (let i = 0; i < 300; i++) {
      const d = document.createElement('div'); d.className = 'layer'
      d.style.left = ((i * 53) % Math.max(1, r.width - 40)) + 'px'; d.style.top = (400 + (i * 97) % Math.max(1, r.height - 30)) + 'px'
      document.body.appendChild(d)
    }
    draw()
  })
  addEventListener('resize', draw)
</script>`

const hosts = new Map()
function serve() {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(req.url.startsWith('/host/') ? hosts.get(req.url) : PAGE)
    })
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
}

const tokens = { measure: '#00aa00', measureInk: '#00aa00', grid: '#ff5f56', surface: '#161b21', fg: '#eef1f3', border: '#21272f' }

function analyze(img, pageW, pageH) {
  const { width, height } = img.getSize()
  const bm = img.toBitmap()
  const k = width / pageW
  const px = (x, y) => { const i = (y * width + x) * 4; return [bm[i + 2], bm[i + 1], bm[i]] }
  let grey = 0, n = 0
  for (let y = Math.round(10 * k); y < Math.round(110 * k); y += 3) for (let x = 0; x < Math.round(150 * k); x++) { const [r] = px(x, y); n++; if (r > 40 && r < 215) grey++ }
  const box = (test) => { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, c = 0; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = px(x, y); if (test(r, g, b)) { c++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) } } return c ? { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k, c } : null }
  return {
    width, height, k,
    grey: grey / n,
    red: box((r, g, b) => r > 200 && g < 60 && b < 60),
    blue: box((r, g, b) => b > 200 && r < 60 && g < 60),
    magenta: box((r, g, b) => r > 200 && b > 200 && g < 60),
    hover: box((r, g, b) => r < 40 && g > 140 && g < 200 && b < 40),
    compose: box((r, g, b) => r > 200 && g > 120 && g < 180 && b < 40),
    // Non-cyan pixels in the canvas region, inset from its edges and the blue corner.
    raster: (() => {
      let bad = 0, all = 0
      const y0 = Math.ceil(404 * k), y1 = Math.floor((pageH - 24) * k), x0 = Math.ceil(4 * k), x1 = Math.floor((pageW - 16) * k)
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const [r, g, b] = px(x, y); all++; if (!(r < 40 && g > 200 && b > 200)) bad++ }
      const samples = []; for (const yy of [y0, Math.round((y0 + y1) / 2), y1 - 1]) samples.push(px(x0 + 10, yy).join(','))
      return { bad, all, samples }
    })(),
  }
}

async function run(port, box, preset, zoom = 1) {
  const fitting = preset === 'fit'
  const scale = fitting ? 1 : Math.min(1, box.w / preset)
  const stageW = fitting ? box.w : Math.min(preset, box.w)
  const gutter = fitting ? 0 : Math.max(0, (box.w - stageW) / 2)
  const pageBox = fitting ? { w: box.w, h: box.h } : { w: preset, h: box.h / scale }
  const iframe = fitting ? 'width:100%;height:100%' : `width:${preset}px;height:${box.h / scale}px;transform:scale(${scale});transform-origin:top left`
  // The wrapper clips like the panel's frame wrapper; the stage sits in it as AppPreviewPanel's does.
  const html = `<!doctype html><body style="margin:0;background:#333"><div style="position:absolute;top:57.5px;left:23px;width:${box.w}px;height:${box.h}px;overflow:hidden">
    <div id="stage" style="position:absolute;top:0;left:${gutter}px;width:${fitting ? '100%' : stageW + 'px'};height:100%;background:#fff">
    <iframe id="f" name="operator-preview" src="http://localhost:${port}/app" style="border:none;${iframe}"></iframe></div></div></body>`
  const path = `/host/${hosts.size}`
  hosts.set(path, html)
  const win = new BrowserWindow({ show: false, width: box.w + 80, height: box.h + 120, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadURL(`http://127.0.0.1:${port}${path}`)
  // Always set: Chromium keeps a zoom per host in the profile, so 1.25 from an earlier case or run
  // would otherwise carry over.
  win.webContents.setZoomFactor(zoom)
  await wait(700)

  const inspect = require(join(__dirname, '..', 'out', 'main', 'preview-inspect.cjs'))
  const cap = require(join(__dirname, '..', 'out', 'main', 'preview-screenshot-capture.cjs'))
  const shared = require(join(__dirname, '..', 'out', 'main', 'preview-screenshot-shared.cjs'))
  inspect.installPreviewInspect(() => win, () => {})
  const api = inspect.previewApi
  const frame = () => win.webContents.mainFrame.frames.find((f) => f.name === 'operator-preview')
  api.open('ignored', 0, 0, 0, 0)
  api.configure({ scale, inspect: true, redlines: false, grid: null, tokens })
  await wait(400)
  // Hover the red box so the inspector draws its outline: it must not be in the picture.
  await frame().executeJavaScript(`(() => {
    const t = document.getElementById('target'), r = t.getBoundingClientRect()
    t.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }))
  })()`)
  await wait(200)
  const hoverShown = await frame().executeJavaScript('[...document.querySelectorAll("[data-operator-inspector]")].some((e) => e.style.display !== "none")')

  // THE RENDERER'S LOOP (AppPreviewPanel `captureWebScreenshot`), against the host page.
  const stage = await win.webContents.executeJavaScript('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight } })()')
  const tileWin = shared.tileWindow(stage, { w: stage.vw, h: stage.vh })
  const page = shared.screenshotPageSize(pageBox)
  const tiles = shared.tilePlan(page, tileWin)
  const id = `probe-${Date.now()}`
  const t0 = Date.now()
  await api.setDrawingHidden(true)
  let ok = true
  for (const [i, t] of tiles.entries()) {
    const s = shared.tileShift(stage, tileWin, t)
    await win.webContents.executeJavaScript(`new Promise((res) => { document.getElementById('f').style.transform = 'translate(${s.x}px, ${s.y}px)'; requestAnimationFrame(() => requestAnimationFrame(() => res(1))) })`)
    // The compose card is made after the hide, as a click in the page would make it: it must stay hidden.
    if (i === 0) await frame().executeJavaScript(`(() => { const c = document.createElement('div'); c.id = '__op_compose'; c.style.cssText = 'position:fixed;left:240px;top:20px;width:60px;height:40px;background:#ff9900;z-index:9'; document.documentElement.appendChild(c) })()`)
    if (!(await cap.captureTile(win, { id, rect: { x: tileWin.x, y: tileWin.y, w: t.w, h: t.h }, at: t }, process.env.NO_PAINT_WAIT ? undefined : api.framePainted))) { ok = false; break }
  }
  await win.webContents.executeJavaScript(`document.getElementById('f').style.transform = ${JSON.stringify(fitting ? '' : `scale(${scale})`)}`)
  await api.setDrawingHidden(false)
  const ms = Date.now() - t0
  const img = ok ? cap.takeTiles(id, page) : null
  const shownAgain = await frame().executeJavaScript('[...document.querySelectorAll("[data-operator-overlay],[data-operator-inspector],#__op_compose")].every((e) => e.style.visibility === "")')
  const screenScale = await win.webContents.executeJavaScript('devicePixelRatio') / zoom

  // The alternative: CDP's clip.scale on the window, over the scaled stage.
  let cdp = null
  if (scale < 1) {
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    await api.setDrawingHidden(true)
    const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: stage.left, y: stage.top, width: stage.width, height: stage.height, scale: 1 / scale } })
    await api.setDrawingHidden(false)
    dbg.detach()
    cdp = analyze(nativeImage.createFromBuffer(Buffer.from(r.data, 'base64')), page.w, page.h)
  }
  win.destroy()
  return { preset, zoom, screenScale, scale, page, tiles: tiles.length, ms, hoverShown, shownAgain, a: img ? analyze(img, page.w, page.h) : null, cdp }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not macOS */ }
  const { server, port } = await serve()
  console.log(`preview-screenshot — electron ${process.versions.electron}`)
  let failed = false
  const near = (a, b) => Math.abs(a - b) <= 0.5
  for (const [box, preset, zoom] of [[{ w: 700, h: 500 }, 'fit', 1], [{ w: 700, h: 500 }, 375, 1], [{ w: 500, h: 700 }, 1280, 1], [{ w: 500, h: 700 }, 1280, 1.25]]) {
    try {
      const r = await run(port, box, preset, zoom)
      const a = r.a
      const dpr = r.screenScale * r.zoom
      const checks = a ? {
        size: a.width === Math.round(r.page.w * dpr) && a.height === Math.round(r.page.h * dpr) && (r.screenScale === 1 || r.screenScale === 2),
        sharp: zoom !== 1 || a.grey === 0,
        place: !!a.red && near(a.red.x, 200) && near(a.red.y, 300) && near(a.red.w, 100) && near(a.red.h, 50),
        corner: !!a.blue && near(a.blue.x, r.page.w - 10) && near(a.blue.y, r.page.h - 10) && near(a.blue.w, 10) && near(a.blue.h, 10),
        clean: !a.magenta && !a.hover && !a.compose && r.hoverShown === true,
        raster: a.raster.all > 0 && a.raster.bad === 0,
        restored: r.shownAgain === true,
      } : { captured: false }
      const pass = Object.values(checks).every(Boolean)
      if (!pass) failed = true
      console.log(`${pass ? 'PASS' : 'FAIL'} ${preset} in ${box.w}x${box.h} at zoom ${zoom} (scale ${r.scale.toFixed(4)}): page ${r.page.w}x${r.page.h}, ${r.tiles} tile(s) in ${r.ms} ms → ${a ? `${a.width}x${a.height}` : 'nothing'}`)
      console.log(`   ${JSON.stringify(checks)}`)
      if (a) console.log(`   grey ${a.grey.toFixed(3)}, red ${JSON.stringify(a.red)}, corner ${JSON.stringify(a.blue)}, magenta ${!!a.magenta}, hover ${!!a.hover}, compose ${!!a.compose}, raster ${a.raster.bad}/${a.raster.all} off ${a.raster.samples.join(' | ')}`)
      if (r.cdp) console.log(`   for comparison, CDP clip.scale: ${r.cdp.width}x${r.cdp.height}, grey ${r.cdp.grey.toFixed(3)} (stripes blurred when > 0)`)
    } catch (e) {
      failed = true
      console.log(`FAIL ${preset}: ${e.stack || e.message}`)
    }
  }
  console.log(failed ? 'RESULT FAIL' : 'RESULT PASS')
  clearTimeout(watchdog)
  server.close()
  app.exit(failed ? 1 : 0)
})
