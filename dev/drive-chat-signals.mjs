// Chat liveness + interrupt (dev/briefs/chat-signals-and-interrupt.md). The complaint this
// answers: "in chat, there's no visual feedback when the agent is thinking, using tools, etc."
// Drives every phase through the mock's __mockPhase lever and asserts what the reading surface
// says, whether it animates, and that the composer's send becomes a stop.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-chat-signals.mjs`.
// (Port 1440 — 1433 is a bare Python server, not the app.)
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(800)
await p.getByText('Chat', { exact: true }).first().click()
await p.waitForTimeout(1200)

const setPhase = async (patch) => {
  await p.evaluate((x) => window.__mockPhase('s-code', x), patch)
  await p.waitForTimeout(700)
}
const readLine = () => p.evaluate(() => {
  const row = document.querySelector('[data-chat-status]')
  if (!row) return { present: false }
  // Motion lives in the StatusWave dots, applied as a CSS `animation` per dot (not SMIL).
  const animating = Array.from(row.querySelectorAll('circle'))
    .some((c) => (getComputedStyle(c).animationName || 'none') !== 'none')
  return {
    present: true,
    kind: row.getAttribute('data-chat-status'),
    label: row.querySelector('[data-chat-status-label]')?.textContent?.trim(),
    elapsed: row.querySelector('[data-chat-status-elapsed]')?.textContent?.trim() ?? null,
    stop: !!row.querySelector('[data-chat-stop]'),
    animating,
  }
})
const composer = () => p.evaluate(() => document.querySelector('[data-composer-action]')?.getAttribute('data-composer-action'))

for (const [name, patch] of [
  ['running (tool)', { status: 'active', phase: 'running', lastToolName: 'Edit' }],
  ['running (no tool)', { status: 'active', phase: 'running', lastToolName: null }],
  ['running + subagents', { status: 'active', phase: 'running', lastToolName: 'Task', activeSubagents: 2 }],
  ['compacting', { status: 'active', phase: 'compacting', lastToolName: null, activeSubagents: 0 }],
  ['waiting', { status: 'active', phase: 'waiting', lastToolName: null }],
  ['idle', { status: 'active', phase: 'idle', lastToolName: null }],
  ['ended', { status: 'ended', phase: 'idle' }],
]) {
  await setPhase(patch)
  const r = await readLine()
  console.log(`${name.padEnd(20)} ${JSON.stringify(r)}  composer=${await composer()}`)
}

// Interrupt: the composer's stop writes a bare ESC — Claude Code's own interrupt, not a kill.
await setPhase({ status: 'active', phase: 'running', lastToolName: 'Bash' })
const before = await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite').length)
await p.locator('[data-composer-action="stop"]').click()
await p.waitForTimeout(500)
const writes = await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite').map((c) => c.data))
console.log('\ninterrupt wrote:', JSON.stringify(writes.slice(before)), '(want ["\\u001b"])')
console.log('no kill was issued:', (await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalKill').length)) === 0)

// Thinking: real blocks are signature-only (326 transcripts, 17,682 blocks, all empty), and
// transcript.rs already drops empty ones before they become narration. The fixture now matches,
// so the reading surface must show NO thought block at all — not an empty disclosure.
const thoughts = () => p.evaluate(() => (window.__canvasTurns ?? []).filter((t) => t.kind === 'thinking').length)
console.log('thought blocks rendered (want 0 — they are always empty in reality):', await thoughts())

// Jump-to-latest appears only off the live edge, and carries the signal.
await setPhase({ status: 'active', phase: 'running', lastToolName: 'Edit' })
// Return to the live edge first — the control must be ABSENT there.
await p.evaluate(() => {
  const sc = Array.from(document.querySelectorAll('div')).find((d) => /auto/.test(getComputedStyle(d).overflow) && d.scrollHeight > d.clientHeight)
  if (sc) sc.scrollTop = sc.scrollHeight
})
await p.waitForTimeout(600)
console.log('jump control at the live edge (want false):', (await p.locator('[data-jump-latest]').count()) > 0)
await p.evaluate(() => {
  const sc = Array.from(document.querySelectorAll('div')).find((d) => /auto/.test(getComputedStyle(d).overflow) && d.scrollHeight > d.clientHeight)
  if (sc) sc.scrollTop = 0
})
await p.waitForTimeout(600)
const jump = await p.evaluate(() => {
  const el = document.querySelector('[data-jump-latest]')
  return el ? el.textContent?.replace(/\s+/g, ' ').trim() : null
})
console.log('jump control scrolled away:', JSON.stringify(jump), '(doubles as the running indicator)')
await p.screenshot({ path: '/tmp/operator-shots/chat-signals.png' })
await b.close()
