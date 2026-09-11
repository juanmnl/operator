// BADGE BLOCK — can previewed content badge Operator's Dock tile, and does the preload stop it?
//
//   npx electron probes/badge-block.cjs                  (baseline: no preload)
//   node scripts/build-main.mjs && npx electron probes/badge-block.cjs --app-preloads
//
// Electron binds Chromium's BadgeService straight to `app.setBadgeCount`, so any frame in the
// process can set the app badge. Each scenario loads a fresh window and reads
// `app.getBadgeCount()` afterwards; a distinct number per scenario says which context got through.
//
//   frame   a cross-origin <iframe> calls navigator.setAppBadge — the Preview pane
//   top     the page itself is the top frame — the inspect WebContentsView
//   worker  a dedicated worker inside the cross-origin iframe
//   sw      a service worker registered by the cross-origin iframe
//
// With --app-preloads the windows are configured like the app's: the main preload +
// nodeIntegrationInSubFrames for `frame`/`worker`/`sw`, the inspector preload for `top`.
const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { join } = require('node:path')

const APP_PRELOADS = process.argv.includes('--app-preloads')
const OUT = join(__dirname, '..', 'out', 'preload')
const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 60_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const NUM = { frame: 3, top: 4, worker: 7, sw: 9 }

const CHILD = (mode) => `<!doctype html><meta charset="utf-8"><body><script>
  const report = (s) => console.log('[child ${mode}] ' + s)
  report('setAppBadge is ' + typeof navigator.setAppBadge + ', native=' + /native code/.test(String(navigator.setAppBadge)))
  report('__operatorNative is ' + typeof window.__operatorNative + ', __operatorPickBridge is ' + typeof window.__operatorPickBridge)
  if ('${mode}' === 'frame' || '${mode}' === 'top') {
    navigator.setAppBadge(${NUM[mode]}).then(() => report('resolved'), (e) => report('rejected ' + e))
  } else if ('${mode}' === 'worker') {
    const src = 'navigator.setAppBadge(${NUM.worker}).then(() => postMessage("resolved"), (e) => postMessage("rejected " + e))'
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    w.onmessage = (e) => report('worker ' + e.data)
  } else if ('${mode}' === 'sw') {
    navigator.serviceWorker.register('/sw.js').then(() => report('sw registered'), (e) => report('sw failed ' + e))
  }
</script>`

const SW = `self.addEventListener('install', (e) => { e.waitUntil(self.navigator.setAppBadge(${NUM.sw}).catch(() => {})) })`

function serve(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
}

async function run(mode, childPort, parentPort) {
  app.setBadgeCount(0)
  const top = mode === 'top'
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      ...(APP_PRELOADS
        ? top
          ? { preload: join(OUT, 'inspector.cjs'), nodeIntegrationInSubFrames: true }
          : { preload: join(OUT, 'index.cjs'), nodeIntegrationInSubFrames: true }
        : {}),
    },
  })
  win.webContents.on('console-message', (e) => console.log('   ', e.message))
  // `localhost` vs `127.0.0.1` on different ports: cross-origin AND cross-site, so the iframe gets
  // its own renderer process exactly as a lane's dev server does under the app's file:// page.
  const url = top ? `http://127.0.0.1:${childPort}/${mode}` : `http://127.0.0.1:${parentPort}/${mode}`
  try { await win.loadURL(url) } catch (e) { console.log(`    load failed: ${e.message}`) }
  await wait(1500)
  // The top frame must keep what the app needs from its preload.
  const bridges = await win.webContents.executeJavaScript('typeof window.__operatorNative + "/" + typeof window.__operatorPickBridge')
  console.log(`    top frame: __operatorNative/__operatorPickBridge = ${bridges}`)
  const count = app.getBadgeCount()
  win.destroy()
  return count
}

// Each scenario destroys its window before the next opens; without a listener that quits the app.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not macOS */ }
  const { session } = require('electron')
  if (APP_PRELOADS) {
    session.defaultSession.registerPreloadScript({ type: 'service-worker', id: 'probe-badge-block', filePath: join(OUT, 'service-worker.cjs') })
  }
  const child = await serve((req, res) => {
    const mode = req.url.slice(1)
    if (mode === 'sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(SW) }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(CHILD(mode))
  })
  const parent = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><body><iframe src="http://localhost:${child.port}${req.url}"></iframe>`)
  })
  console.log(`badge-block probe — ${APP_PRELOADS ? 'WITH the app preloads' : 'baseline, no preload'}`)
  const results = {}
  for (const mode of ['frame', 'top', 'worker', 'sw']) {
    const count = await run(mode, child.port, parent.port)
    results[mode] = { badge: count, badged: count === NUM[mode] }
    console.log(`${mode}: app.getBadgeCount() = ${count} → ${count === NUM[mode] ? 'BADGED' : 'not badged'}`)
  }
  app.setBadgeCount(0)
  console.log('RESULT ' + JSON.stringify(results))
  clearTimeout(watchdog)
  child.server.close(); parent.server.close()
  app.exit(0)
})
