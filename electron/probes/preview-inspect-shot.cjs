// PREVIEW INSPECT SHOT — does an Inspect note's screenshot outline the element that was picked?
//
//   node probes/build.mjs && npx electron probes/preview-inspect-shot.cjs
//
// Since 2026-09-17 there is no inspect view: the inspector runs inside the Preview iframe and an
// Inspect note's crop is captured from the main window over the stage, like an Annotate note. This
// runs the whole path with the real modules:
//   the inspector injected by preview-inspect.ts → a real click and "→ Console" in the page → the pick
//   the page posts to the host window → pickShotRequest (src/renderer/lib/preview-shot.ts) with the
//   stage's rect → capturePreviewShot (preview-shot-capture.ts) → the stored image.
// Then it reads the stored image back and checks that the picked element's pixels (pure red) sit
// inside the drawn outline (pure blue), and that the outline hugs them. Cases: Fit, and a 1280 preset
// scaled into a 700px stage, each with the page scrolled so the scroll offset has to be right too.
// ~/.operator is never touched: OPERATOR_DIR points at a temp directory.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const HOME = mkdtempSync(join(tmpdir(), 'operator-shot-probe-'))
process.env.OPERATOR_DIR = HOME

const { app, BrowserWindow, nativeImage } = require('electron')
const { createServer } = require('node:http')

const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 90_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; background: #fff } .tall { height: 3000px } #target { position: absolute; left: 400px; top: 600px; width: 160px; height: 60px; background: #ff0000 }</style>
<div class="tall"></div><div id="target"></div>`

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
const OUTLINE = { r: 0, g: 0, b: 255 }

/** Bounding box of the pixels matching `test` in a BGRA bitmap. */
function bbox(bitmap, width, height, test) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (test(bitmap[i + 2], bitmap[i + 1], bitmap[i])) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

async function run(port, box, preset, scrollY) {
  const fitting = preset === 'fit'
  const scale = fitting ? 1 : Math.min(1, box.w / preset)
  const stageW = fitting ? box.w : Math.min(preset, box.w)
  const iframe = fitting ? 'width:100%;height:100%' : `width:${preset}px;height:${box.h / scale}px;transform:scale(${scale});transform-origin:top left`
  const html = `<!doctype html><body style="margin:0;background:#333"><div style="position:absolute;top:57px;left:23px;width:${box.w}px;height:${box.h}px;overflow:hidden">
    <div id="stage" style="position:absolute;top:0;left:${(box.w - stageW) / 2}px;width:${fitting ? '100%' : stageW + 'px'};height:100%;background:#fff">
    <iframe name="operator-preview" src="http://localhost:${port}/app" style="border:none;${iframe}"></iframe></div></div>
    <script>window.__picks = []; window.addEventListener('message', (e) => { if (e.data && e.data.__operatorPreview === 'pick') window.__picks.push(e.data.data) })</script></body>`
  const path = `/host/${hosts.size}`
  hosts.set(path, html)
  const win = new BrowserWindow({ show: false, width: box.w + 80, height: box.h + 120, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadURL(`http://127.0.0.1:${port}${path}`)
  await wait(700)

  const inspect = require(join(__dirname, '..', 'out', 'main', 'preview-inspect.cjs'))
  const { capturePreviewShot } = require(join(__dirname, '..', 'out', 'main', 'preview-shot-capture.cjs'))
  const { pickShotRequest } = require(join(__dirname, '..', 'out', 'main', 'preview-shot-renderer.cjs'))
  inspect.installPreviewInspect(() => win, () => {})
  const api = inspect.previewApi
  const frame = () => win.webContents.mainFrame.frames.find((f) => f.name === 'operator-preview')

  await frame().executeJavaScript(`window.scrollTo(0, ${scrollY})`)
  api.open('ignored', 0, 0, 0, 0)
  api.configure({ scale, inspect: true, redlines: false, grid: null, tokens })
  await wait(400)

  // A real pick: hover and click the element (the inspector hit-tests with elementFromPoint), then
  // "→ Console" on the compose card it opens.
  await frame().executeJavaScript(`(() => {
    const r = document.getElementById('target').getBoundingClientRect()
    const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    document.getElementById('target').dispatchEvent(new MouseEvent('mousemove', at))
    document.getElementById('target').dispatchEvent(new MouseEvent('click', at))
  })()`)
  await wait(200)
  await frame().executeJavaScript(`(() => {
    const card = document.getElementById('__op_compose'); card.querySelector('textarea').value = 'make it smaller'
    ;[...card.querySelectorAll('button')].find((b) => b.textContent.includes('Console')).click()
  })()`)
  await wait(300)
  const picks = await win.webContents.executeJavaScript('window.__picks')
  if (!picks.length) throw new Error('no pick reached the host window')
  const pick = JSON.parse(picks[0])
  const stage = await win.webContents.executeJavaScript('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()')

  const req = pickShotRequest(pick, 'probe', `pick-${Date.now()}`, stage, OUTLINE)
  const shot = await capturePreviewShot(req, { window: () => win, hideInspector: () => api.hideOutline() })
  if (!shot) throw new Error('capture returned null')
  const img = nativeImage.createFromPath(shot.path)
  const { width, height } = img.getSize()
  const bitmap = img.toBitmap()
  const red = bbox(bitmap, width, height, (r, g, b) => r > 200 && g < 60 && b < 60)
  const blue = bbox(bitmap, width, height, (r, g, b) => r === 0 && g === 0 && b === 255)
  // The hover outline (#00aa00) must not be in the picture.
  const isHover = (r, g, b) => r < 40 && g > 140 && g < 200 && b < 40
  const hover = bbox(bitmap, width, height, isHover)
  // CONTROL: hover the element again and capture WITHOUT hiding, so "no hover outline" above means
  // hideInspector worked rather than that the outline was never on screen.
  await frame().executeJavaScript(`(() => {
    const r = document.getElementById('target').getBoundingClientRect()
    document.getElementById('target').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }))
  })()`)
  await wait(200)
  const control = await capturePreviewShot({ ...req, id: `pick-control-${Date.now()}`, hideInspector: false }, { window: () => win, hideInspector: async () => {} })
  const cimg = control ? nativeImage.createFromPath(control.path) : null
  const controlHover = cimg ? !!bbox(cimg.toBitmap(), cimg.getSize().width, cimg.getSize().height, isHover) : null
  win.destroy()

  const inside = !!(red && blue && red.x0 >= blue.x0 && red.y0 >= blue.y0 && red.x1 <= blue.x1 && red.y1 <= blue.y1)
  const slack = red && blue ? Math.max(red.x0 - blue.x0, red.y0 - blue.y0, blue.x1 - red.x1, blue.y1 - red.y1) : null
  // The outline is drawn one bitmap px outside the box, `thickness` px thick (≥ 2): a few px of slack.
  const hugs = slack !== null && slack <= 6
  return { preset, scale: Number(scale.toFixed(4)), scrollY, pickBox: pick.box, pickScale: pick.scale, request: req.targets[0], image: { width, height }, red, blue, hover, controlHover, inside, slack, hugs }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not macOS */ }
  const { server, port } = await serve()
  console.log(`preview-inspect-shot — electron ${process.versions.electron}`)
  let failed = false
  for (const [box, preset, scrollY] of [[{ w: 700, h: 500 }, 'fit', 350], [{ w: 700, h: 500 }, 1280, 250]]) {
    try {
      const r = await run(port, box, preset, scrollY)
      const ok = r.inside && r.hugs && !r.hover && r.controlHover === true
      if (!ok) failed = true
      console.log(`${ok ? 'PASS' : 'FAIL'} preset ${preset} scale ${r.scale} scroll ${scrollY}: element ${JSON.stringify(r.red)} inside outline ${JSON.stringify(r.blue)} (slack ${r.slack}px), hover outline in image: ${!!r.hover} (control without hiding: ${r.controlHover})`)
      console.log(`   pick box ${JSON.stringify(r.pickBox)} scale ${r.pickScale} → window target ${JSON.stringify(r.request)}, image ${r.image.width}x${r.image.height}`)
    } catch (e) {
      failed = true
      console.log(`FAIL preset ${preset}: ${e.message}`)
    }
  }
  console.log(failed ? 'RESULT FAIL' : 'RESULT PASS')
  clearTimeout(watchdog)
  server.close()
  rmSync(HOME, { recursive: true, force: true })
  app.exit(failed ? 1 : 0)
})
