// Input-verification runner. Boots the real Vite dev server, loads the xterm
// input harness in headless WebKit (same engine family as the app's WKWebView,
// so key handling / IME behave like production), drives keyboard / IME / chord /
// paste events, and asserts the exact ordered byte stream that reaches onData.
//
//   node scripts/input/capture.mjs [--port <n>]
//
// Exits non-zero if any assertion fails (so it can gate CI / a release).
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const port = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.OPERATOR_DEV_PORT || '1421')
const url = `http://localhost:${port}/scripts/input/index.html`

function waitForServer(target, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((res, rej) => {
    const tick = async () => {
      try {
        if ((await fetch(target)).ok) return res()
      } catch { /* not up yet */ }
      if (Date.now() - start > timeoutMs) return rej(new Error(`Vite not ready at ${target}`))
      setTimeout(tick, 250)
    }
    tick()
  })
}

const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`)
  }
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
  const page = await browser.newPage({ colorScheme: 'dark' })
  page.on('pageerror', (e) => console.warn('⚠ pageerror:', String(e)))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__inputReady === true', { timeout: 15000 })
  // Focus the terminal so keystrokes land on its textarea.
  await page.locator('#term').click()

  const reset = () => page.evaluate(() => window.__inputReset())
  const recorded = () => page.evaluate(() => window.__inputRecorded.join(''))

  // 1. Plain typing — exact characters, in order.
  await reset()
  await page.keyboard.type('hello world')
  check('types plain text', await recorded(), 'hello world')

  // 2. Non-ASCII commit (multibyte UTF-8) lands as the composed character.
  await reset()
  await page.keyboard.insertText('héllo · 你好')
  check('commits non-ASCII text', await recorded(), 'héllo · 你好')

  // 3. Enter sends CR.
  await reset()
  await page.keyboard.press('Enter')
  check('Enter → CR', await recorded(), '\r')

  // 4. App chord (Cmd+K) is DECLINED — no bytes leak to the pty.
  await reset()
  await page.keyboard.press('Meta+k')
  check('Cmd+K sends nothing to pty', await recorded(), '')

  // 5. Ctrl+W is a terminal control code (werase) — NOT declined, reaches the pty.
  await reset()
  await page.keyboard.press('Control+w')
  check('Ctrl+W → ^W (0x17)', await recorded(), '\x17')

  // 6. Large paste arrives intact and in order (no drops).
  await reset()
  const big = 'AB'.repeat(3000) // 6000 chars
  await page.keyboard.insertText(big)
  check('large paste intact', await recorded(), big)

  await browser.close()
} catch (err) {
  console.error('✗ input capture failed:', err?.message || err)
  exitCode = 1
} finally {
  if (vite) vite.kill('SIGTERM')
}

if (failures.length) {
  console.error(`\n${failures.length} input assertion(s) failed.`)
  exitCode = 1
} else if (exitCode === 0) {
  console.log('\n✓ all input assertions passed')
}
process.exit(exitCode)
