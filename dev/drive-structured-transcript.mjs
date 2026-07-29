// Structured transcript: tool calls as first-class blocks (dev/briefs/structured-transcript-build.md).
// Asserts they render as PUNCTUATION (one line per run, not a wall of cards), that consecutive
// same-tool calls coalesce, and that a subagent's calls never fold into the lead's.
//
// Run: `npx vite --port 1447` then `MOCK_PORT=1447 node dev/drive-structured-transcript.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1447
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1680, height: 950 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch {} })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.locator('[data-session-row="s-code"]').click(); await p.waitForTimeout(800)
await p.getByText('Chat', { exact: true }).first().click(); await p.waitForTimeout(1500)

const runs = await p.evaluate(() => (window.__canvasTurns ?? [])
  .filter((x) => x.kind === 'toolrun')
  .map((r) => ({ name: r.name, n: r.calls.length, caller: r.caller })))
console.log('tool runs laid out:', JSON.stringify(runs))
console.log('3 consecutive Reads coalesced into one run:', runs.some((r) => r.name === 'Read' && r.n === 3))
console.log("a subagent's Grep stayed separate:", runs.some((r) => r.name === 'Grep' && r.caller === 'subagent-research'))

// Punctuation, not cards: each run costs ONE line in the laid-out document.
const heights = await p.evaluate(() => (window.__canvasBounds ?? [])
  .filter((b) => b.kind === 'toolrun').map((b) => Math.round(b.bottom - b.top)))
console.log('height of each tool run (want ~19px, one line):', JSON.stringify(heights))
console.log('no run renders as a card:', heights.every((h) => h <= 24))
await p.screenshot({ path: '/tmp/operator-shots/structured-transcript.png' })
await b.close()
