// PREVIEW BLEED — the headless repro for "the preview iframe paints black and the terminal shows
// THROUGH it" (packaged 0.17.0, Mission Control, lane preview on localhost:1427).
//
//   npx electron probes/preview-bleed.cjs [--target http://localhost:1427] [--out <dir>]
//
// It answers two questions with pixels instead of opinion, in a window configured exactly like
// the app's (sandbox, contextIsolation, webSecurity, the same backgroundColor):
//
//   HALF A  does the framed page load and RUN? — every frame-scoped event and console line the
//           subframe produces is recorded, alongside a control page we serve ourselves that is
//           known-good (dark shell + a module script that renders).
//   HALF B  does the terminal underneath bleed through the iframe? — `capturePage()` twice, once
//           with the active pane visible (today) and once hidden (the proposed fix), then COUNT
//           the pane's selection colour inside the stage rect. A colour that cannot appear in
//           either the iframe's page or the stage is the only honest witness.
const { app, BrowserWindow, nativeImage } = require('electron')
const { createServer } = require('node:http')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const args = process.argv.slice(2)
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
// Captures are regenerable output, so they default beside the other verification PNGs
// (gitignored) rather than into the source tree.
const OUT = resolve(argOf('--out', join(__dirname, '..', '..', 'scripts', 'visual', 'out', 'preview-bleed')))
const EXTRA_TARGET = argOf('--target', null)
mkdirSync(OUT, { recursive: true })

const SANDBOX = mkdtempSync(join(tmpdir(), 'preview-bleed-'))
const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 120_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// The control page: the shape of the real one (dark color-scheme + an inline critical background
// + a module script that renders text), served from a DIFFERENT PORT so the frame is genuinely
// cross-origin and Chromium gives it its own process.
const CONTROL = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="color-scheme" content="dark">
<style>html,body{margin:0;background:#0b0d10;color:#e6e6e6;font:14px ui-monospace,monospace}</style>
</head><body><div id="app">module script did not run</div>
<script type="module">
  document.getElementById('app').textContent = 'CONTROL PAGE RENDERED'
  document.documentElement.style.background = '#123a12'
  console.log('[control] module script ran, framed=' + (window.self !== window.top))
</script></body></html>`

/** The pane's selection colour — deliberately a colour nothing else in the composite uses. */
const SELECTION = { r: 0xff, g: 0x00, b: 0xff }
const near = (p, c, tol = 12) => Math.abs(p.r - c.r) <= tol && Math.abs(p.g - c.g) <= tol && Math.abs(p.b - c.b) <= tol

/** Count what a capture is made of inside the stage rect (CSS px → device px via scaleFactor). */
function analyse(png, rect, scale) {
  const img = nativeImage.createFromBuffer(png)
  const { width: W, height: H } = img.getSize()
  const b = img.toBitmap() // BGRA
  const x0 = Math.round(rect.x * scale), y0 = Math.round(rect.y * scale)
  const x1 = Math.min(W, Math.round((rect.x + rect.width) * scale)), y1 = Math.min(H, Math.round((rect.y + rect.height) * scale))
  let total = 0, black = 0, white = 0, selection = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      const p = { b: b[i], g: b[i + 1], r: b[i + 2] }
      total++
      if (p.r < 24 && p.g < 24 && p.b < 24) black++
      else if (p.r > 235 && p.g > 235 && p.b > 235) white++
      if (near(p, SELECTION)) selection++
    }
  }
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`
  return { total, black: pct(black), white: pct(white), selectionPx: selection, bleeds: selection > 0 }
}

async function shot(win, name, rect, scale) {
  const png = (await win.webContents.capturePage()).toPNG()
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, png)
  return { file, ...analyse(png, rect, scale) }
}

app.whenReady().then(async () => {
  // Bundle the page with the same esbuild the shell builds with, so the real xterm is in there.
  const bundle = join(SANDBOX, 'page.js')
  execFileSync(join(__dirname, '..', 'node_modules', '.bin', 'esbuild'), [
    join(__dirname, 'preview-bleed-page.ts'), '--bundle', `--outfile=${bundle}`, '--format=iife',
  ], { cwd: join(__dirname, '..', '..'), stdio: ['ignore', 'ignore', 'inherit'] })
  writeFileSync(join(SANDBOX, 'page.js'), readFileSync(bundle))
  writeFileSync(join(SANDBOX, 'xterm.css'), readFileSync(join(__dirname, '..', '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css')))
  writeFileSync(join(SANDBOX, 'harness.html'),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./xterm.css">
     <style>html,body{margin:0;background:#0b0d10}</style></head>
     <body><div id="root"></div><script src="./page.js"></script></body></html>`)

  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(CONTROL) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const controlUrl = `http://127.0.0.1:${server.address().port}/`

  const targets = [{ name: 'control', url: controlUrl }]
  if (EXTRA_TARGET) targets.push({ name: 'real', url: EXTRA_TARGET })

  // ONE window, navigated per case: a second BrowserWindow loading the same file:// URL fails
  // with ERR_FAILED, and a harness that cannot load its own page proves nothing.
  const win = new BrowserWindow({
    show: false, width: 900, height: 520, backgroundColor: '#0b0d10',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  })
  let frameLog = []
  {
    // Frame-scoped, so a subframe's failure is not mistaken for the harness page's.
    win.webContents.on('did-frame-finish-load', (_e, isMain, pid, fid) => { if (!isMain) frameLog.push(`did-frame-finish-load frame=${pid}:${fid}`) })
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => frameLog.push(`did-fail-load main=${isMain} ${code} ${desc} ${url}`))
    win.webContents.on('did-frame-navigate', (_e, url, code, _s, isMain) => { if (!isMain) frameLog.push(`did-frame-navigate ${code} ${url}`) })
    win.webContents.on('console-message', (e) => {
      const fromFrame = e.frame && e.frame !== win.webContents.mainFrame
      frameLog.push(`console${fromFrame ? '(SUBFRAME)' : '(main)'}: ${e.message}`)
    })
  }

  const results = []
  for (const t of targets) {
    for (const pane of ['visible', 'hidden']) {
      frameLog = []
      await win.loadFile(join(SANDBOX, 'harness.html'), { query: { target: t.url, pane } })
      await wait(3000) // let the framed app boot and the selection land

      const scale = win.webContents.getZoomFactor() * (require('electron').screen.getPrimaryDisplay().scaleFactor || 1)
      const rect = await win.webContents.executeJavaScript(
        'JSON.parse(JSON.stringify(document.getElementById("stage").getBoundingClientRect()))')
      const r = await shot(win, `${t.name}-pane-${pane}`, rect, scale)
      results.push({ target: t.name, url: t.url, pane, ...r, frameLog })
    }
  }
  win.destroy()
  server.close()

  console.log('')
  for (const r of results) {
    console.log(`=== target=${r.target} (${r.url}) · active pane ${r.pane} ===`)
    console.log(`  stage pixels: black ${r.black} · white ${r.white} · SELECTION-COLOUR ${r.selectionPx}px → terminal bleeds: ${r.bleeds ? 'YES' : 'no'}`)
    console.log(`  capture: ${r.file}`)
    for (const l of r.frameLog) console.log(`  ${l}`)
  }
  clearTimeout(watchdog)
  app.exit(results.some((r) => r.pane === 'hidden' && r.bleeds) ? 1 : 0)
})
