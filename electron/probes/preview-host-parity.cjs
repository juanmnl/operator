// PREVIEW HOST PARITY — does the page lay out the same in the iframe and in the native inspect view?
//
//   npx electron probes/preview-host-parity.cjs
//
// Plain preview renders the page in an <iframe> inside the stage (AppPreviewPanel). Inspect,
// Redlines and the in-page grid render it in a WebContentsView laid over the same stage rect, with
// device emulation for scaled presets (preview-inspect.ts `scalePage`). For each stage case this
// builds both, the way the app does, and reports what the PAGE sees in each: its viewport, its
// scrollbar-less client width, devicePixelRatio, which media queries match, and the width of a
// fluid element, and the app state the user had built up in the iframe (a document id, a counter, an
// in-app route, the scroll position). Any difference is a change the user sees when toggling an
// overlay. This reproduces the host swap as it shipped at 0ab91b0; the fix removed the view
// (see preview-overlay-toggle.cjs for the fixed path).
const { app, BrowserWindow, WebContentsView } = require('electron')
const { createServer } = require('node:http')

const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 90_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; font: 14px system-ui }
  #fluid { width: 100%; height: 20px; background: #0a0 }
  #tall { height: 3000px }
  #mq::after { content: 'wide' }
  @media (max-width: 767px) { #mq::after { content: 'narrow' } }
  @media (min-resolution: 2dppx) { #dpr::after { content: 'hidpi' } }
</style>
<div id="fluid"></div><div id="mq"></div><div id="dpr"></div><div id="tall"></div>
<script>window.__bootId = Math.random().toString(36).slice(2); window.__count = 0</script>`

const MEASURE = `(() => ({
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
  dpr: window.devicePixelRatio,
  fluid: document.getElementById('fluid').getBoundingClientRect().width,
  mq: getComputedStyle(document.getElementById('mq'), '::after').content,
  hidpi: getComputedStyle(document.getElementById('dpr'), '::after').content,
  screenW: screen.width,
  bootId: window.__bootId, count: window.__count, path: location.pathname, scrollY: Math.round(window.scrollY),
}))()`

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

/** Copied from preview-inspect.ts `scalePage` AT 0ab91b0 — the thing under test. */
function scalePageAsShipped(v, scale) {
  const { width, height } = v.getBounds()
  if (!(scale > 0) || scale >= 1 || width <= 0 || height <= 0) { v.webContents.disableDeviceEmulation(); return }
  const size = { width: Math.round(width / scale), height: Math.round(height / scale) }
  v.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: size, scale })
}

/** The stage the renderer derives for a wrapper box and a preset (AppPreviewPanel). */
function stageFor(box, preset) {
  const fitting = preset === 'fit' || box.w === 0
  const scale = fitting ? 1 : Math.min(1, box.w / preset)
  const stageW = fitting ? box.w : Math.min(preset, box.w)
  const gutter = fitting ? 0 : Math.max(0, (box.w - stageW) / 2)
  const iframe = fitting ? 'width:100%;height:100%' : `width:${preset}px;height:${box.h / scale}px;transform:scale(${scale});transform-origin:top left`
  return { fitting, scale, stageW, gutter, iframe }
}

async function run(box, preset, url, pageUrl, scaler) {
  const st = stageFor(box, preset)
  const TOP = 57.5 // a fractional toolbar height, as the real bar can be
  const html = `<!doctype html><body style="margin:0;background:#222">
    <div id="wrap" style="position:absolute;left:0;top:${TOP}px;width:${box.w}px;height:${box.h}px;overflow:hidden">
      <div id="stage" style="position:absolute;top:0;left:${st.gutter}px;width:${st.fitting ? '100%' : st.stageW + 'px'};height:100%;background:#fff">
        <iframe src="${pageUrl}" style="border:none;${st.iframe}"></iframe>
      </div>
    </div></body>`
  const win = new BrowserWindow({ show: false, width: box.w + 40, height: box.h + 120, webPreferences: { contextIsolation: true, sandbox: true } })
  const hostPath = `/host/${hosts.size}`
  hosts.set(hostPath, html)
  await win.loadURL(new URL(hostPath, url).toString())
  await wait(700)
  const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f !== win.webContents.mainFrame)
  const inIframe = await frame.executeJavaScript(MEASURE)
  // What the user had done in the iframe before turning an overlay on.
  await frame.executeJavaScript(`window.__count = 3; history.pushState({}, '', '/page/deep'); window.scrollTo(0, 600)`)
  await wait(150)
  Object.assign(inIframe, await frame.executeJavaScript('({ bootId: window.__bootId, count: window.__count, path: location.pathname, scrollY: Math.round(window.scrollY) })'))
  const rect = await win.webContents.executeJavaScript('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()')

  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } })
  win.contentView.addChildView(view)
  // Same rounding as preview-inspect.ts `move`.
  view.setBounds({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) })
  // The app's order: `open` starts the load, then the renderer's `configure` scales the page.
  const loading = view.webContents.loadURL(pageUrl)
  await wait(50)
  scaler(view, st.scale)
  await loading
  await wait(700)
  const inView = await view.webContents.executeJavaScript(MEASURE)
  win.contentView.removeChildView(view)
  view.webContents.close()
  win.destroy()
  const keys = ['innerWidth', 'innerHeight', 'clientWidth', 'clientHeight', 'dpr', 'fluid', 'mq', 'hidpi', 'screenW', 'bootId', 'count', 'path', 'scrollY']
  const diffs = keys.filter((k) => inIframe[k] !== inView[k]).map((k) => `${k}: iframe ${inIframe[k]} vs view ${inView[k]}`)
  return { box, preset, scale: Number(st.scale.toFixed(4)), stage: rect, inIframe, inView, diffs }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not macOS */ }
  const { server, port } = await serve()
  const url = `http://127.0.0.1:${port}/`
  // The page under test on a different origin from the host page, as in the app.
  const pageUrl = `http://localhost:${port}/page`
  const cases = [
    [{ w: 700, h: 500 }, 'fit'],
    [{ w: 701, h: 500.5 }, 'fit'],
    [{ w: 700, h: 500 }, 375],
    [{ w: 700, h: 500 }, 768],
    [{ w: 700, h: 500 }, 1280],
    [{ w: 723, h: 511 }, 1440],
  ]
  const which = process.argv.includes('--fixed') ? 'fixed' : 'shipped'
  let scaler = scalePageAsShipped
  if (which === 'fixed') scaler = require(process.env.FIXED_SCALER).scaler
  console.log(`preview-host-parity — electron ${process.versions.electron}, scaler ${which}`)
  const results = []
  for (const [box, preset] of cases) {
    const r = await run(box, preset, url, pageUrl, scaler)
    results.push(r)
    console.log(`box ${box.w}x${box.h} preset ${preset} scale ${r.scale}: ${r.diffs.length ? 'DIFFERS — ' + r.diffs.join('; ') : 'identical'}`)
    console.log(`   iframe ${JSON.stringify(r.inIframe)}`)
    console.log(`   view   ${JSON.stringify(r.inView)}`)
  }
  console.log('RESULT ' + JSON.stringify(results.map((r) => ({ box: r.box, preset: r.preset, diffs: r.diffs }))))
  clearTimeout(watchdog)
  server.close()
  app.exit(0)
})
