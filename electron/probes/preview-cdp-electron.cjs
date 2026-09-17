// PREVIEW ELECTRON VIA CDP — can Preview show, drive and inspect another Electron app?
//
//   node scripts/build-main.mjs && node probes/build.mjs && npx electron probes/preview-cdp-electron.cjs
//
// Launches a throwaway Electron app (written to a temp dir) and answers, with the REAL
// src/main/preview-cdp.ts:
//   LAUNCH   which way of asking for a debugging port actually opens one:
//              A. ELECTRON_EXTRA_LAUNCH_ARGS=--remote-debugging-port=<p> in the environment
//              B. `electron app.cjs --remote-debugging-port=<p>` on the command line
//              C. the app's own opt-in, app.commandLine.appendSwitch reading OPERATOR_CDP_PORT
//   SHOW     targets listed, screencast frames arrive (with the app window shown and hidden)
//   INPUT    a forwarded click increments the app's counter; forwarded keys type into its input
//   INSPECT  the shared inspector: a forwarded hover + click opens the compose card, "→ Console"
//            reaches Operator as a pick through Runtime.addBinding
//   REDLINES a forwarded ⌥-click sets the anchor, reported through the binding
//   RELOAD   after Page.reload the scripts are back (addScriptToEvaluateOnNewDocument) and configured
//   SHOT     Page.captureScreenshot with a clip, outlined by the shared pipeline, and the picked
//            element's pixels are inside the outline
//   EDIT     the CSS controls' page engine over CDP: the pick selects the element, `set padding-top`
//            changes its computed style in the app and comes back as state through the binding, the
//            before/after screenshots show the element grow, and `undo` reverts it
// OPERATOR_DIR points at a temp dir, so the shot is never written under ~/.operator.
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const HOME = mkdtempSync(join(tmpdir(), 'operator-cdp-probe-'))
process.env.OPERATOR_DIR = join(HOME, 'operator-home')

const { app, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')

const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 150_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const note = (k, v) => { results[k] = v; console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`) }

const APP_JS = `
const { app, BrowserWindow } = require('electron')
if (process.env.PROBE_OPT_IN === '1' && process.env.OPERATOR_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.OPERATOR_CDP_PORT)
}
const html = \`<!doctype html><meta charset="utf-8"><title>Probe App</title>
<style>body{margin:0;font:14px system-ui;background:#fff} #target{position:absolute;left:120px;top:160px;width:180px;height:70px;background:#ff0000} #inc{position:absolute;left:20px;top:20px;width:80px;height:30px} #field{position:absolute;left:20px;top:70px;width:200px}</style>
<button id="inc" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">+</button><span id="count" style="position:absolute;left:120px;top:26px">0</span>
<input id="field"><div id="target"></div>\`
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 640, height: 420, show: process.env.PROBE_SHOW === '1', webPreferences: { sandbox: true } })
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
})
`

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
}
async function answers(port, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return true } catch { /* not yet */ }
    await wait(250)
  }
  return false
}
function launch(dir, { env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, [join(dir, 'app.cjs'), ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', OPERATOR_DIR: '', ...env }, stdio: 'ignore',
  })
  return child
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not macOS */ }
  const dir = mkdtempSync(join(HOME, 'app-'))
  writeFileSync(join(dir, 'app.cjs'), APP_JS)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe-app', main: 'app.cjs' }))
  console.log(`preview-cdp-electron — electron ${process.versions.electron}`)
  let failed = false
  const check = (name, ok, detail) => { if (!ok) failed = true; note(name, `${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`) }

  // LAUNCH
  for (const [name, opts] of [
    ['launch A ELECTRON_EXTRA_LAUNCH_ARGS', (p) => ({ env: { ELECTRON_EXTRA_LAUNCH_ARGS: `--remote-debugging-port=${p}` } })],
    ['launch B --remote-debugging-port argument', (p) => ({ args: [`--remote-debugging-port=${p}`] })],
    ['launch C appendSwitch(OPERATOR_CDP_PORT)', (p) => ({ env: { OPERATOR_CDP_PORT: String(p), PROBE_OPT_IN: '1' } })],
  ]) {
    const p = await freePort()
    const child = launch(dir, opts(p))
    const ok = await answers(p, 8000)
    note(name, ok ? `opens port ${p}` : 'no debugging port')
    child.kill()
    await wait(500)
  }

  const cdpMod = require(join(__dirname, '..', 'out', 'main', 'preview-cdp.cjs'))
  for (const show of ['1', '0']) {
    const p = await freePort()
    const child = launch(dir, { env: { OPERATOR_CDP_PORT: String(p), PROBE_OPT_IN: '1', PROBE_SHOW: show } })
    const label = show === '1' ? 'shown window' : 'hidden window'
    try {
      if (!(await answers(p, 8000))) throw new Error('no debugging port')
      await wait(800)
      const frames = [], picks = [], anchors = [], detaches = [], edits = []
      const cdp = cdpMod.createPreviewCdp({
        frame: (f) => frames.push(f), pick: (d) => picks.push(d), anchor: (a) => anchors.push(a), detached: (r) => detaches.push(r),
        edit: (d) => edits.push(JSON.parse(d)),
      })
      const targets = await cdp.listTargets(p)
      check(`${label}: targets`, targets.length === 1 && targets[0].title === 'Probe App', JSON.stringify(targets.map((t) => t.title)))
      const att = await cdp.attach(p, targets[0].id)
      check(`${label}: attach`, att.ok, att.ok ? '' : att.error)
      await wait(1500)
      check(`${label}: screencast frames`, frames.length > 0, `${frames.length} frame(s), css ${frames[0]?.cssWidth}x${frames[0]?.cssHeight}, jpeg ${frames[0] ? Math.round(frames[0].data.length * 0.75 / 1024) : 0} KB`)

      // A raw connection of our own, only to READ the app's state for the checks.
      const { CdpConnection } = require(join(__dirname, '..', 'out', 'main', 'preview-cdp.cjs'))
      const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()
      const raw = await CdpConnection.connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
      const read = async (expr) => (await raw.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value

      // INPUT
      const lags = []
      const timed = async (ev) => { const t = Date.now(); await cdp.input(ev); lags.push(Date.now() - t) }
      const click = async (x, y, modifiers = 0) => {
        await timed({ kind: 'mouse', type: 'mouseMoved', x, y, button: 'none', clickCount: 0, modifiers })
        await timed({ kind: 'mouse', type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers })
        await timed({ kind: 'mouse', type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers })
        await wait(100)
      }
      const before = frames.length
      await click(60, 35)
      check(`${label}: forwarded click`, (await read('document.getElementById("count").textContent')) === '1')
      // A change on the page must produce a new frame, or the canvas would go stale.
      await read(`(() => { let n = 0; const t = setInterval(() => { document.getElementById('count').textContent = String(++n); if (n > 20) clearInterval(t) }, 50); return true })()`)
      await wait(1500)
      check(`${label}: new frames follow page changes`, frames.length > before + 3, `${frames.length - before} frame(s) after changes`)
      await click(120, 80)
      for (const ch of 'hi') {
        await timed({ kind: 'key', type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, keyCode: ch.toUpperCase().charCodeAt(0), modifiers: 0 })
        await timed({ kind: 'key', type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), modifiers: 0 })
      }
      await wait(250)
      check(`${label}: forwarded keys`, (await read('document.getElementById("field").value')) === 'hi')
      note(`${label}: input round-trip ms`, lags)

      // INSPECT
      const tokens = { measure: '#00aa00', measureInk: '#00aa00', grid: '#ff5f56', surface: '#161b21', fg: '#eef1f3', border: '#21272f' }
      cdp.configure({ scale: 1, inspect: true, redlines: false, grid: null, tokens })
      await wait(300)
      await click(210, 195)
      const cardOpen = await read('!!document.getElementById("__op_compose")')
      await read(`(() => { const c = document.getElementById('__op_compose'); c.querySelector('textarea').value = 'smaller'; [...c.querySelectorAll('button')].find((b) => b.textContent.includes('Console')).click(); return true })()`)
      await wait(300)
      const pick = picks[0] ? JSON.parse(picks[0]) : null
      check(`${label}: inspect pick through the binding`, !!cardOpen && !!pick && pick.message === 'smaller' && !!pick.box, pick ? JSON.stringify({ tag: pick.tag, box: pick.box, target: pick.target }) : 'no pick')

      // SHOT
      if (pick?.box) {
        const shot = await cdp.shot({ project: 'probe', id: `pick-${Date.now()}`, targets: [pick.box], outline: { r: 0, g: 0, b: 255 } })
        let inside = false, detail = 'no shot'
        if (shot) {
          const img = nativeImage.createFromPath(shot.path)
          const { width, height } = img.getSize()
          const bm = img.toBitmap()
          const bbox = (test) => { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (test(bm[i + 2], bm[i + 1], bm[i])) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) } } return x1 < 0 ? null : { x0, y0, x1, y1 } }
          const red = bbox((r, g, b) => r > 200 && g < 60 && b < 60)
          const blue = bbox((r, g, b) => r === 0 && g === 0 && b === 255)
          const hover = bbox((r, g, b) => r < 40 && g > 140 && g < 200 && b < 40)
          inside = !!(red && blue && red.x0 >= blue.x0 && red.y0 >= blue.y0 && red.x1 <= blue.x1 && red.y1 <= blue.y1) && !hover
          detail = `image ${width}x${height}, element ${JSON.stringify(red)} in outline ${JSON.stringify(blue)}, hover outline in image ${!!hover}`
        }
        check(`${label}: note screenshot outlines the element`, inside, detail)
      }

      // EDIT — the pick selected the element in the page's edit engine.
      const redHeight = async (shot) => {
        if (!shot) return null
        const img = nativeImage.createFromPath(shot.path)
        const { width, height } = img.getSize()
        const bm = img.toBitmap()
        let y0 = 1e9, y1 = -1
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (bm[i + 2] > 200 && bm[i + 1] < 60 && bm[i] < 60) { y0 = Math.min(y0, y); y1 = Math.max(y1, y) } }
        return y1 < 0 ? null : y1 - y0 + 1
      }
      const lastEdit = () => edits[edits.length - 1]
      const selected = lastEdit()?.active
      check(`${label}: edit — the pick selects the element, state arrives through the binding`, !!selected && selected.box && selected.box.w === 180, selected ? JSON.stringify({ uid: selected.uid, label: selected.label, box: selected.box }) : `no edit state (${edits.length} messages)`)
      if (selected) {
        const target = 'document.getElementById("target")'
        // As AppPreviewPanel's captureEdit does: the engine hides its handles for the capture.
        const editShot = async (id, box) => {
          await cdp.editCommand({ __operatorEditCmd: 'capture', on: true })
          await wait(60)
          try { return await cdp.shot({ project: 'probe', id, targets: [box], outline: { r: 0, g: 0, b: 255 } }) }
          finally { await cdp.editCommand({ __operatorEditCmd: 'capture', on: false }) }
        }
        const before = await editShot(`pick-edit-${selected.uid}-before`, selected.box)
        const pad0 = await read(`getComputedStyle(${target}).paddingTop`)
        await cdp.editCommand({ __operatorEditCmd: 'set', uid: selected.uid, prop: 'padding-top', value: '24px' })
        await wait(250)
        const pad1 = await read(`getComputedStyle(${target}).paddingTop`)
        const stateAfter = lastEdit()?.active
        check(`${label}: edit — set padding-top changes the computed style in the app`, pad0 === '0px' && pad1 === '24px' && stateAfter?.values?.['padding-top'] === '24px',
          `computed ${pad0} → ${pad1}; state values ${JSON.stringify(stateAfter?.values)}; history ${stateAfter?.history}`)
        const after = await editShot(`pick-edit-${selected.uid}-after`, stateAfter?.box ?? selected.box)
        const h0 = await redHeight(before), h1 = await redHeight(after)
        check(`${label}: edit — before/after screenshots show the element grow by the padding`, !!(h0 && h1) && Math.abs((h1 - h0) - 48) <= 2,
          `element height in image ${h0} → ${h1} device px (24 CSS px = 48 at 2x)`)
        await cdp.editCommand({ __operatorEditCmd: 'undo', uid: selected.uid })
        await wait(250)
        const pad2 = await read(`getComputedStyle(${target}).paddingTop`)
        check(`${label}: edit — undo reverts it`, pad2 === '0px' && !lastEdit()?.active?.values?.['padding-top'], `computed ${pad2}; state values ${JSON.stringify(lastEdit()?.active?.values)}`)
      }

      // REDLINES
      cdp.configure({ scale: 1, inspect: false, redlines: true, grid: null, tokens })
      await wait(300)
      await click(210, 195, 1 /* alt */)
      await wait(300)
      check(`${label}: redline anchor through the binding`, anchors.includes(true), JSON.stringify(anchors))

      // RELOAD
      await raw.send('Page.reload')
      await wait(1500)
      const afterReload = await read('!!window.__operatorOverlay && window.__operatorOverlay.redlinesOn()')
      check(`${label}: scripts and configuration survive a reload`, afterReload === true)

      raw.close()
      cdp.detach()
    } catch (e) {
      check(`${label}: run`, false, e.message)
    } finally {
      child.kill()
      await wait(500)
    }
  }

  console.log(failed ? 'RESULT FAIL' : 'RESULT PASS')
  clearTimeout(watchdog)
  rmSync(HOME, { recursive: true, force: true })
  app.exit(failed ? 1 : 0)
})
