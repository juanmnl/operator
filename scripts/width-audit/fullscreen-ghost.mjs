// verify:ghost — the composer-ghost regression gate.
//
// Replays real FULLSCREEN (alt-screen) Claude Code captures through the production xterm at the
// production repaint cadence, interfering mid-stream the way the app does, and diffs xterm's DOM
// against its own buffer per row. The buffer is ground truth; a buffer-clean/DOM-stale row is the
// ghost. This is the only fullscreen coverage in the repo — every other fixture here is classic
// tui, which is a scrolling log and never rewrites the composer in place.
//
// EXIT CODE IS THE POINT. Any DOM/buffer mismatch in any scenario fails the run.
//
// AND THE GATE CHECKS ITSELF. Every real scenario currently passes, which is indistinguishable
// from a comparator that has quietly stopped comparing — so the `selftest` scenario stales the
// tail rows on purpose and the run FAILS if that one comes back clean. A gate that cannot fail is
// not a gate.
//
// PREREQ: the committed fixtures (claude-fullscreen.bin, claude-fullscreen-long.bin). Refresh with
// capture-claude-fullscreen.py, which asserts the capture really is alt-screen before writing.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const port = Number(process.env.OPERATOR_DEV_PORT || '1454')
const base = `http://localhost:${port}/scripts/width-audit/fullscreen-ghost.html`
const outDir = resolve(__dirname, 'out')

// Two independent captures. One is not a sample: the first spike's conclusions rested on a single
// ~30s turn, and this is the cheapest way to stop that being true again.
const FIXTURES = ['claude-fullscreen', 'claude-fullscreen-long']

// Kept in step with SCENARIOS in fullscreen-ghost.ts. Each runs in its OWN page load: xterm pauses
// rendering for a terminal that is not intersecting the viewport, so scenarios stacked in one page
// measure each other's scroll position as much as anything else.
const SCENARIOS = [
  'baseline',
  'resize-guarded',
  'resize-forced',
  'resize-thrash',
  'hide-show',
  'hide-show-chunked-flush',
  'hide-show-late-refresh',
  'hide-show-visibility',
  'hide-show-display-none',
]
const SELFTEST = 'selftest'

const wait = (t, ms = 40000) => {
  const s = Date.now()
  return new Promise((res, rej) => {
    const k = async () => {
      try { const r = await fetch(t); if (r.ok) return res() } catch { /* not up */ }
      if (Date.now() - s > ms) return rej(new Error('no vite'))
      setTimeout(k, 250)
    }
    k()
  })
}

for (const f of FIXTURES) {
  if (existsSync(resolve(__dirname, `${f}.bin`))) continue
  console.error(`✗ missing fixture scripts/width-audit/${f}.bin`)
  console.error(`  regenerate: python3 scripts/width-audit/capture-claude-fullscreen.py ${f}`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

/** One scenario, one fixture, one page. */
async function runOne(browser, scenario, fixture, shoot) {
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  page.on('pageerror', (e) => console.error('[page]', String(e)))
  await page.goto(`${base}?scenario=${scenario}&fixture=${fixture}`, { waitUntil: 'load' })
  await page.waitForFunction('window.__ghostReady === true', { timeout: 120000 })
  const r = await page.evaluate('window.__ghost')
  if (shoot) {
    try { await page.locator('#term').screenshot({ path: resolve(outDir, `ghost-${scenario}.png`) }) } catch { /* off-frame */ }
  }
  await page.close()
  return r
}

const line = (s) => {
  const flag = s.mismatches.length ? '✗' : '✓'
  console.log(
    `  ${flag} ${s.name.padEnd(24)} ${String(s.cols).padStart(3)}x${s.rows}` +
    `  ${s.bufferGarbled} buffer-garbled  ${s.domOnlyGarbled} DOM-only-garbled` +
    `  ${s.mismatches.length} mismatches` +
    (s.syncOutputAtEnd ? '  [sync-output OPEN at end]' : ''),
  )
  for (const m of s.mismatches) {
    console.log(`      row ${m.row}`)
    console.log(`        buffer |${m.buffer}|`)
    console.log(`        dom    |${m.dom}|`)
  }
}

let vite, code = 0
try {
  vite = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    env: { ...process.env, OPERATOR_DEV_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  await wait(base)
  const browser = await webkit.launch()

  let mismatches = 0
  for (const fixture of FIXTURES) {
    console.log(`\n── fullscreen ghost · ${fixture}.bin ──`)
    for (const scenario of SCENARIOS) {
      const r = await runOne(browser, scenario, fixture, fixture === FIXTURES[0])
      line(r)
      mismatches += r.mismatches.length
    }
  }

  const self = await runOne(browser, SELFTEST, FIXTURES[0], false)
  await browser.close()
  console.log('\n── harness self-check (must FAIL: it stales 3 rows on purpose) ──')
  console.log(`  ${self.mismatches.length ? '✓' : '✗'} ${self.mismatches.length} mismatches detected`)

  console.log('')
  if (mismatches > 0) {
    console.log(`✗ ${mismatches} DOM/buffer mismatch(es).`)
    console.log('  The DOM is showing something the buffer does not say. That is the ghost.')
    code = 1
  } else if (self.mismatches.length === 0) {
    console.log('✗ the self-check passed, which means the comparator is not comparing.')
    console.log('  It blanks three row elements after the last repaint; if that reads as clean,')
    console.log('  the row scoping or the diff is broken and every green above is meaningless.')
    code = 1
  } else {
    console.log(`✓ 0 mismatches across ${SCENARIOS.length} scenarios × ${FIXTURES.length} fixtures.`)
    console.log('  The DOM matches the buffer on every row, and the self-check confirms the')
    console.log('  comparator would have caught it if it did not.')
  }
  console.log(`  screenshots: ${outDir}/ghost-*.png\n`)
} catch (e) {
  console.error('✗', e?.message || e)
  code = 1
} finally {
  if (vite) vite.kill('SIGTERM')
}
process.exit(code)
