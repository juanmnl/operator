// Measures how many terminals ONE lane switch resizes. Boots the real Vite dev
// server, loads scripts/resize-guard/harness.tsx in headless WebKit (the app's
// engine family), and prints the distinct terminal ids that reached
// `terminalResize` after a switch whose panel state differs.
//
// Expected: BEFORE the inactive-pane guard, every mounted pane (5/5) — that is the
// bug. AFTER, at most the pane becoming active (≤1).
//
//   node scripts/resize-guard/capture.mjs [--port <n>] [--expect-max <n>]
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const args = process.argv.slice(2)
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def }
const port = Number(getArg('--port', process.env.OPERATOR_DEV_PORT || '1432'))
// How many terminals may legitimately resize on a switch. Omit to only report.
const expectMax = args.includes('--expect-max') ? Number(getArg('--expect-max')) : null
// The control run: switch lane WITHOUT the panel state differing — nothing moves,
// so nothing should resize, with or without the guard.
const keepPanel = args.includes('--keep-panel')
const url = `http://localhost:${port}/scripts/resize-guard/index.html${keepPanel ? '?panel=keep' : ''}`

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(`[pageerror] ${e.stack || e.message || e}`))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__resizeDone === true', { timeout: 60000 })
  const report = await page.evaluate(() => window.__resizeReport)
  const mount = await page.evaluate(() => window.__mountReport)
  // A real OS window resize must still reach the pane you are looking at — the guard removes
  // background traffic, not the feature.
  await page.evaluate(() => window.__reset())
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.waitForTimeout(1500)
  const windowResize = await page.evaluate(() => window.__report())
  await browser.close()

  for (const e of pageErrors) console.error(e)
  console.log(`lanes mounted: ${report.lanes}`)
  console.log(`terminals sized at MOUNT (must stay ${report.lanes} — a background lane needs its real width): ${mount.terminals.length}`)
  if (mount.terminals.length < report.lanes) {
    exitCode = 1
    console.error('✗ a pane mounted inactive never got its initial size — the guard is in front of ensureInitialFit')
  }
  console.log(`terminals resized by ONE lane switch: ${report.terminals.length} (${report.terminals.join(', ') || 'none'})`)
  console.log(`terminalResize calls: ${report.calls}`)
  console.log(`terminals resized by an OS WINDOW resize: ${windowResize.terminals.length} (${windowResize.terminals.join(', ') || 'none'})`)
  if (windowResize.terminals.length < 1) {
    exitCode = 1
    console.error('✗ the ACTIVE pane no longer follows a real window resize — the guard is too wide')
  }
  if (expectMax !== null && report.terminals.length > expectMax) {
    exitCode = 1
    console.error(`✗ expected at most ${expectMax} terminal(s) to resize, got ${report.terminals.length}`)
  } else if (expectMax !== null) {
    console.log(`✓ within the expected ceiling of ${expectMax}`)
  }
} catch (err) {
  exitCode = 1
  console.error('✗ harness failed to run:', err?.message || err)
} finally {
  if (vite) vite.kill('SIGTERM')
}
process.exit(exitCode)
