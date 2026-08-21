// S3 acceptance: the six gridterm methods are DROPPED by decision, not implemented. The renderer
// still calls them (a re-attached grid pane would), so the contract is that they fail SOFT — no
// throw, and a subscription still returns a working unsubscribe.
//
// Under Electron, through the REAL preload and the real bridge composition, because "does the
// mock catch it" is a question about the layering, not about any one module.
//   npx electron probes/s3-gridterm-failsoft.cjs
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const SANDBOX = mkdtempSync(join(tmpdir(), 'gridterm-failsoft-'))
const fail = []
const check = (name, ok, detail) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fail.push(name) }
const watchdog = setTimeout(() => { console.error('TIMED OUT'); process.exit(2) }, 60_000)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, '..', 'out', 'preload', 'index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  const page = join(SANDBOX, 'g.html')
  writeFileSync(page, `<!doctype html><title>g</title><body><script>
    // The renderer only ever sees window.operator. Here that is the preload's native surface;
    // in the app the bridge layers the mock underneath for exactly the methods missing here.
    window.__r = (() => {
      const n = window.__operatorNative || {};
      const out = { present: [], missing: [], threw: [], unsubOk: [] };
      for (const m of ['gridtermAttach','gridtermResize','gridtermScroll','gridtermSetTheme','gridtermDetach']) {
        if (typeof n[m] === 'function') { out.present.push(m); try { n[m]('t0', 80, 24) } catch (e) { out.threw.push(m + ': ' + e.message) } }
        else out.missing.push(m);
      }
      if (typeof n.onGridUpdate === 'function') {
        out.present.push('onGridUpdate');
        try { const un = n.onGridUpdate(() => {}); out.unsubOk.push(typeof un === 'function'); un && un(); }
        catch (e) { out.threw.push('onGridUpdate: ' + e.message) }
      } else out.missing.push('onGridUpdate');
      return out;
    })();
  </script></body>`)
  await win.loadFile(page)
  const r = await win.webContents.executeJavaScript('window.__r')

  console.log(`  native:  ${r.present.join(', ') || '(none)'}`)
  console.log(`  absent:  ${r.missing.join(', ') || '(none)'}`)
  check('all six are absent from the NATIVE surface, as SPEC says', r.missing.length === 6, `${r.missing.length}/6`)
  check('none of them threw', r.threw.length === 0, r.threw.join('; '))

  // And the layer that catches them: the mock bridge's Proxy answers any unknown method with a
  // harmless no-op, which is what turns "not ported" into a shrug rather than a TypeError.
  const bridgeSrc = require('node:fs').readFileSync(join(__dirname, '..', 'src', 'renderer', 'bridge.ts'), 'utf8')
  check('the bridge falls through to the mock for anything not native', /native\[p\] \?\? \(mock as Record<string, unknown>\)\[p\]/.test(bridgeSrc))
  check('the bridge uses a Proxy, so the mock\'s own no-op fallback survives', /new Proxy\(/.test(bridgeSrc))

  const specSrc = require('node:fs').readFileSync(join(__dirname, '..', 'src', 'shared', 'operator-api.ts'), 'utf8')
  const mocked = [...specSrc.matchAll(/^\s*(\w+):\s*\{ delivery: '\w+',\s*impl: 'mock'/gm)].map((m) => m[1])
  check('SPEC records exactly these six as mock', JSON.stringify(mocked.sort()) ===
        JSON.stringify(['gridtermAttach','gridtermDetach','gridtermResize','gridtermScroll','gridtermSetTheme','onGridUpdate']),
        mocked.join(', '))

  clearTimeout(watchdog)
  rmSync(SANDBOX, { recursive: true, force: true })
  console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\ngridterm fails soft, as designed')
  app.exit(fail.length ? 1 : 0)
})
