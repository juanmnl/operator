// PREVIEW ZOOM ISOLATION — does scaling the inspect view's page leak into Operator's own window?
//
//   npx electron probes/preview-zoom-isolation.cjs
//
// The inspect WebContentsView shares the default session with the main window, and Chromium keys
// zoom by HOST, ignoring the port. In the dev build the renderer is http://localhost:1420 and a
// lane's dev server is http://localhost:5173, so `setZoomFactor` on the preview may zoom the app.
// Each scenario opens a window on one localhost port and a view on another, scales the view to
// lay a 1280px page out in a 640px box, and reports:
//
//   window zoom   the MAIN window's zoom factor afterwards (1 = isolated)
//   fresh zoom    a NEW window on a third localhost port afterwards (1 = nothing persisted)
//   innerWidth    the view page's CSS viewport width (1280 = laid out at the preset)
//   box width     getBoundingClientRect of a 100px-wide element (100 = CSS px intact)
//   clientX       where a mouse event at view x=320 lands in the page (640 = input mapped)
//
// Scenarios: `zoom` (webContents.setZoomFactor, what f6a314b ships) and `emulation`
// (webContents.enableDeviceEmulation with viewSize + scale).
const { app, BrowserWindow, WebContentsView } = require('electron')
const { createServer } = require('node:http')

const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 60_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<div id="box" style="width:100px;height:20px;background:#c00"></div>
<script>
  window.__lastX = null
  window.addEventListener('mousemove', (e) => { window.__lastX = e.clientX }, true)
</script>`

function serve() {
  return new Promise((resolve) => {
    const s = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
}

const BOX = { w: 640, h: 400 }
const PRESET = 1280
const SCALE = BOX.w / PRESET

async function run(mode, ports) {
  const win = new BrowserWindow({ show: false, width: 1000, height: 600, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadURL(`http://localhost:${ports.app}/app`)
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: BOX.w, height: BOX.h })
  await view.webContents.loadURL(`http://localhost:${ports.preview}/preview`)

  if (mode === 'zoom') {
    view.webContents.setZoomFactor(SCALE)
  } else {
    view.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width: PRESET, height: Math.round(BOX.h / SCALE) },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: PRESET, height: Math.round(BOX.h / SCALE) },
      scale: SCALE,
    })
  }
  await wait(800)

  // A hidden, unfocused window drops synthetic mouse input; focus the view and enter it first.
  view.webContents.focus()
  view.webContents.sendInputEvent({ type: 'mouseEnter', x: 320, y: 10 })
  for (let i = 0; i < 3; i++) {
    view.webContents.sendInputEvent({ type: 'mouseMove', x: 320, y: 10 + i, movementX: 0, movementY: 1 })
    await wait(100)
  }
  await wait(300)

  const page = await view.webContents.executeJavaScript(
    '({ innerWidth: window.innerWidth, box: document.getElementById("box").getBoundingClientRect().width, clientX: window.__lastX })',
  )
  const windowZoom = win.webContents.getZoomFactor()

  const fresh = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await fresh.loadURL(`http://localhost:${ports.fresh}/fresh`)
  await wait(300)
  const freshZoom = fresh.webContents.getZoomFactor()

  // Reset the way "Fit" would, and see whether the view returns to 1:1.
  if (mode === 'zoom') view.webContents.setZoomFactor(1)
  else view.webContents.disableDeviceEmulation()
  await wait(500)
  const reset = await view.webContents.executeJavaScript('window.innerWidth')

  fresh.destroy()
  win.contentView.removeChildView(view)
  view.webContents.close()
  win.destroy()
  return {
    windowZoom: Number(windowZoom.toFixed(3)),
    freshZoom: Number(freshZoom.toFixed(3)),
    innerWidth: page.innerWidth,
    boxWidth: page.box,
    clientX: page.clientX,
    resetInnerWidth: reset,
  }
}

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not macOS */ }
  const servers = await Promise.all([serve(), serve(), serve()])
  const ports = { app: servers[0].port, preview: servers[1].port, fresh: servers[2].port }
  console.log(`preview-zoom-isolation probe — electron ${process.versions.electron}, box ${BOX.w}px, preset ${PRESET}px, scale ${SCALE}`)
  const results = {}
  for (const mode of process.argv.includes('--only-emulation') ? ['emulation'] : ['zoom', 'emulation']) {
    const r = await run(mode, ports)
    const isolated = r.windowZoom === 1 && r.freshZoom === 1
    const laidOut = r.innerWidth === PRESET && r.boxWidth === 100
    // A hidden window delivers no synthetic mouse input at all (null under BOTH scenarios on
    // electron 43.4.1), so null means "not testable here", not "mapped wrong". Check in a window.
    const input = r.clientX == null ? 'untested' : r.clientX === 320 / SCALE ? 'mapped' : 'OFF'
    const resets = r.resetInnerWidth === BOX.w
    results[mode] = { ...r, isolated, laidOut, input, resets }
    console.log(`${mode}: window zoom ${r.windowZoom}, fresh zoom ${r.freshZoom} → ${isolated ? 'ISOLATED' : 'LEAKS'}; ` +
      `innerWidth ${r.innerWidth}, box ${r.boxWidth} → ${laidOut ? 'preset layout' : 'WRONG layout'}; ` +
      `input ${input}; reset innerWidth ${r.resetInnerWidth} → ${resets ? 'resets' : 'STUCK'}`)
  }
  console.log('RESULT ' + JSON.stringify(results))
  clearTimeout(watchdog)
  for (const s of servers) s.server.close()
  app.exit(0)
})
