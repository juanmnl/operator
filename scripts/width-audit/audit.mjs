// Width-audit runner. Boots the real Vite dev server, loads the width-audit page
// in headless WebKit (same engine family as the app's WKWebView), and prints where
// xterm's cell-width disagrees with Claude Code's string-width. Each mismatch is a
// glyph that drifts Claude's cursor math → scrollback overprint.
//   node scripts/width-audit/audit.mjs [--port <n>]
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const args = process.argv.slice(2)
const port = Number((args.indexOf('--port') >= 0 && args[args.indexOf('--port') + 1]) || process.env.OPERATOR_DEV_PORT || '1421')
const url = `http://localhost:${port}/scripts/width-audit/index.html`

function waitForServer(target, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((res, rej) => {
    const tick = async () => {
      try { const r = await fetch(target); if (r.ok) return res() } catch { /* not up */ }
      if (Date.now() - start > timeoutMs) return rej(new Error(`Vite not ready at ${target}`))
      setTimeout(tick, 250)
    }
    tick()
  })
}

let vite, exitCode = 0
try {
  vite = spawn('npm', ['run', 'dev'], { cwd: repoRoot, env: { ...process.env, OPERATOR_DEV_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  await waitForServer(url)

  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  page.on('pageerror', (e) => console.error('[page error]', String(e)))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__auditReady === true', { timeout: 20000 })
  const A = await page.evaluate('window.__widthAudit')
  await browser.close()
  const pad = (s, n) => String(s).padEnd(n)

  console.log(`\n── Width audit: xterm (15-graphemes) vs Claude string-width (cols=${A.cols}) ──\n`)

  console.log(`1) Per-glyph width — ${A.rows.length} tested, ${A.glyphMismatches.length} mismatch(es)`)
  for (const m of A.glyphMismatches) console.log(`   ✗ ${pad(m.s, 4)}${pad(m.cp, 24)}xterm=${m.xterm} claude=${m.claude}  ${m.group}·${m.label}`)
  if (!A.glyphMismatches.length) console.log('   ✓ clean')

  console.log(`\n2) stripOrnaments substitution (glyph → 2 spaces) — ${A.ornamentMismatches.length} width-changing`)
  for (const o of A.ornamentMismatches) console.log(`   ✗ ${pad(o.s, 4)}${pad(o.cp, 12)}before=${o.before} after=${o.after}  (2-space sub ${o.after > o.before ? 'WIDENS' : 'NARROWS'})`)
  if (!A.ornamentMismatches.length) console.log('   ✓ all stripped glyphs are width-2 → substitution is width-safe')

  console.log(`\n3) Wrap-row parity — ${A.lineMismatches.length} mismatch(es) of ${A.lineChecks.length} line-variants`)
  for (const l of A.lineChecks) {
    const bad = l.xtermRows !== l.claudeRows
    console.log(`   ${bad ? '✗' : '✓'} ${pad(l.label, 20)}${pad(l.variant, 10)}w=${pad(l.claudeW, 5)}xtermRows=${l.xtermRows} claudeRows=${l.claudeRows}`)
  }
  console.log('')
} catch (err) {
  console.error('✗ width audit failed:', err?.message || err)
  exitCode = 1
} finally {
  if (vite) vite.kill('SIGTERM')
}
process.exit(exitCode)
