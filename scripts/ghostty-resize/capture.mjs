// Drives the ghostty resize-stress harness in headless WebKit and reports any
// errors it captured. Boots the real Vite dev server (so ghostty-web's WASM loads
// exactly as in the app), loads the harness, waits for window.__ghosttyDone, and
// prints window.__ghosttyErrors. Exits non-zero if any error was recorded.
//
//   node scripts/ghostty-resize/capture.mjs [--port <n>]
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const args = process.argv.slice(2)
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def }
const port = Number(getArg('--port', process.env.OPERATOR_DEV_PORT || '1422'))
const url = `http://localhost:${port}/scripts/ghostty-resize/index.html`

function waitForServer(targetUrl, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((res, rej) => {
    const tick = async () => {
      try { const r = await fetch(targetUrl); if (r.ok) return res() } catch { /* not up */ }
      if (Date.now() - start > timeoutMs) return rej(new Error(`Vite not ready at ${targetUrl}`))
      setTimeout(tick, 250)
    }
    tick()
  })
}

let vite
let exitCode = 0
try {
  vite = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    env: { ...process.env, OPERATOR_DEV_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))

  await waitForServer(url)

  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  const pageErrors = []
  // Phase 6 injects faults on purpose to prove the loop-death mechanism — ignore those.
  const INJECTED = 'injected mid-resize render fault'
  page.on('pageerror', (e) => { const s = `${e.stack || e.message || e}`; if (!s.includes(INJECTED)) pageErrors.push(`[pageerror] ${s}`) })
  page.on('crash', () => pageErrors.push('[PAGE CRASHED]'))

  await page.goto(url, { waitUntil: 'load' })
  try {
    await page.waitForFunction('window.__ghosttyDone === true', { timeout: 60000 })
  } catch {
    const phase = await page.evaluate(() => window.__ghosttyPhase).catch(() => 'unknown')
    pageErrors.push(`[TIMEOUT] harness never finished; last phase = ${phase} (likely a hard crash/freeze)`)
  }

  const harnessErrors = await page.evaluate(() => window.__ghosttyErrors || []).catch(() => ['<could not read errors — page dead>'])
  const frames = await page.evaluate(() => ({
    wrapped: window.__wrappedFrames,
    unwrapped: window.__unwrappedFrames,
  })).catch(() => ({}))
  await browser.close()

  const all = [...harnessErrors, ...pageErrors]
  if (all.length) {
    exitCode = 1
    console.error(`✗ ${all.length} error(s) during resize stress:\n`)
    for (const e of all) console.error('  ' + e.replace(/\n/g, '\n  ') + '\n')
  } else {
    console.log('✓ no errors — resize stress survived clean')
  }

  // Render-loop death/fix proof. wrapped should keep rendering (~24 frames in 400ms);
  // unwrapped should flatline (~0) after a single injected throw.
  console.log(`render-loop frames after one injected throw — wrapped(fix): ${frames.wrapped}, unwrapped(today): ${frames.unwrapped}`)
  if (typeof frames.wrapped === 'number' && typeof frames.unwrapped === 'number') {
    if (frames.unwrapped > 3) {
      exitCode = 1
      console.error('✗ expected the UNWRAPPED loop to die (≈0 frames) — mechanism not reproduced')
    } else if (frames.wrapped < 5) {
      exitCode = 1
      console.error('✗ expected the WRAPPED loop to survive (many frames) — fix did not hold')
    } else {
      console.log('✓ mechanism reproduced (unwrapped loop dies) AND fix holds (wrapped loop survives)')
    }
  }
} catch (err) {
  exitCode = 1
  console.error('✗ harness failed to run:', err?.message || err)
} finally {
  if (vite) vite.kill('SIGTERM')
}
process.exit(exitCode)
