// PREVIEW OVERLAY TOGGLE — does turning Redlines, the grid or Inspect on and off change the page?
//
//   node probes/build.mjs && npx electron probes/preview-overlay-toggle.cjs
//
// Runs the REAL `src/main/preview-inspect.ts` (bundled by probes/build.mjs) against a page in a
// preview iframe laid out the way AppPreviewPanel lays it out (Fit, and a scaled 1280 preset). The
// page is given state first — a counter clicked, an in-app route change, a scroll — then each
// overlay goes on and off. After every step the page is measured: the same document (a random id set
// at load), the same state, the same scroll, the same viewport and layout. Any change fails.
const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { join } = require('node:path')

const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 90_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 14px system-ui } #bar { display: flex; gap: 8px; padding: 8px } #col { width: 50%; height: 40px; background: #09c } .tall { height: 2400px }
@media (max-width: 767px) { #col { width: 100% } }</style>
<div id="bar"><button id="inc">+</button><span id="count">0</span></div><div id="col"></div><div class="tall"></div>
<script>
  window.__bootId = Math.random().toString(36).slice(2)
  document.getElementById('inc').addEventListener('click', () => { const c = document.getElementById('count'); c.textContent = String(Number(c.textContent) + 1) })
</script>`

const MEASURE = `(() => ({
  bootId: window.__bootId, count: document.getElementById('count').textContent, path: location.pathname,
  scrollY: Math.round(window.scrollY), innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight,
  col: document.getElementById('col').getBoundingClientRect().width,
  barTop: Math.round(document.getElementById('bar').getBoundingClientRect().top),
  htmlAttrs: [...document.documentElement.attributes].map((a) => a.name + '=' + a.value).join(' '),
  bodyAttrs: [...document.body.attributes].map((a) => a.name + '=' + a.value).join(' '),
  bodyChildren: document.body.children.length,
}))()`
const OVERLAY_STATE = `(() => {
  const host = document.querySelector('[data-operator-overlay]')
  if (!host) return { host: false }
  const cs = getComputedStyle(host)
  return { host: true, position: cs.position, pointerEvents: cs.pointerEvents, gridCols: host.shadowRoot.children[0].children.length }
})()`

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

const tokens = { measure: '#c98bff', measureInk: '#c98bff', grid: '#ff5f56', surface: '#161b21', fg: '#eef1f3', border: '#21272f' }
const grid = { preset: 'auto', columns: 12, gutter: 24, margin: 32, maxWidth: null }

async function run(port, box, preset) {
  const fitting = preset === 'fit'
  const scale = fitting ? 1 : Math.min(1, box.w / preset)
  const iframe = fitting ? 'width:100%;height:100%' : `width:${preset}px;height:${box.h / scale}px;transform:scale(${scale});transform-origin:top left`
  const html = `<!doctype html><body style="margin:0"><div style="position:absolute;top:40px;left:0;width:${box.w}px;height:${box.h}px">
    <iframe name="operator-preview" src="http://localhost:${port}/app" style="border:none;${iframe}"></iframe></div>
    <script>window.__msgs = []; window.addEventListener('message', (e) => window.__msgs.push(e.data))</script></body>`
  const path = `/host/${hosts.size}`
  hosts.set(path, html)
  const win = new BrowserWindow({ show: false, width: box.w + 40, height: box.h + 80, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadURL(`http://127.0.0.1:${port}${path}`)
  await wait(600)

  const anchors = []
  const inspect = require(join(__dirname, '..', 'out', 'main', 'preview-inspect.cjs'))
  inspect.installPreviewInspect(() => win, (a) => anchors.push(a))
  const api = inspect.previewApi
  const frame = () => win.webContents.mainFrame.frames.find((f) => f.name === 'operator-preview')

  // Give the page state the old host swap threw away.
  await frame().executeJavaScript(`document.getElementById('inc').click(); document.getElementById('inc').click(); history.pushState({}, '', '/app/deep'); window.scrollTo(0, 700)`)
  await wait(200)
  const baseline = await frame().executeJavaScript(MEASURE)

  const steps = []
  const step = async (name, fn) => {
    fn()
    await wait(400)
    const page = await frame().executeJavaScript(MEASURE)
    const overlay = await frame().executeJavaScript(OVERLAY_STATE)
    const diffs = Object.keys(baseline).filter((k) => page[k] !== baseline[k]).map((k) => `${k}: ${baseline[k]} → ${page[k]}`)
    steps.push({ name, diffs, overlay })
  }
  const on = { scale, inspect: false, redlines: false, grid: null, tokens }
  await step('open + redlines on', () => { api.open('ignored', 0, 0, 0, 0); api.configure({ ...on, redlines: true }) })
  // Redlines really draw in the page: hover an element, then ⌥-click it to anchor.
  await frame().executeJavaScript(`(() => {
    const col = document.getElementById('col'); const r = col.getBoundingClientRect()
    col.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }))
  })()`)
  await wait(200)
  const drawn = await frame().executeJavaScript(`document.querySelector('[data-operator-overlay]').shadowRoot.children[1].children.length`)
  await frame().executeJavaScript(`document.getElementById('col').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`)
  await wait(200)
  const msgs = await win.webContents.executeJavaScript('window.__msgs')
  steps.push({ name: 'redlines draw on hover, ⌥-click anchors', diffs: [], overlay: { redlineNodes: drawn, messagesToHost: msgs }, check: drawn > 0 && msgs.some((m) => m && m.__operatorPreview === 'anchor' && m.value === true) })
  await step('grid on', () => api.configure({ ...on, redlines: true, grid }))
  await step('inspect on', () => api.configure({ ...on, redlines: true, grid, inspect: true }))
  await step('all off (close)', () => api.close())
  await step('redlines on again', () => { api.open('ignored', 0, 0, 0, 0); api.configure({ ...on, redlines: true }) })
  await step('close', () => api.close())
  win.destroy()
  return { box, preset, scale: Number(scale.toFixed(4)), baseline, steps }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not macOS */ }
  const { server, port } = await serve()
  console.log(`preview-overlay-toggle — electron ${process.versions.electron}`)
  let failed = false
  for (const [box, preset] of [[{ w: 700, h: 500 }, 'fit'], [{ w: 700, h: 500 }, 1280], [{ w: 700, h: 500 }, 375]]) {
    const r = await run(port, box, preset)
    console.log(`box ${box.w}x${box.h} preset ${preset} scale ${r.scale}: baseline ${JSON.stringify(r.baseline)}`)
    for (const s of r.steps) {
      const overlayOk = 'check' in s ? s.check
        : s.name.includes('off') || s.name === 'close' || (s.overlay.host && s.overlay.position === 'fixed' && s.overlay.pointerEvents === 'none')
      if (s.diffs.length || !overlayOk) failed = true
      console.log(`   ${s.name}: ${s.diffs.length ? 'CHANGED — ' + s.diffs.join('; ') : 'page unchanged'}; overlay ${JSON.stringify(s.overlay)}`)
    }
  }
  console.log(failed ? 'RESULT FAIL' : 'RESULT PASS')
  clearTimeout(watchdog)
  server.close()
  app.exit(failed ? 1 : 0)
})
