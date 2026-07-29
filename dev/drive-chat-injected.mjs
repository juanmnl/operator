// Chat must not render Claude Code's plumbing as if the user typed it
// (dev/briefs/chat-injected-turns.md). The fixture ends with the four turns from the report:
// a caveat banner, the /model command, its ANSI-laden stdout, and one real "hi". Only the last
// is the user's. transcript.rs now drops injected turns before they reach chat.db; this proves
// the RENDERER guard, which is what history already on disk depends on.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-chat-injected.mjs`.
// (Port 1440 — 1433 is a bare Python server, not the app.)
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)
// The Code lane is the one with a chat fixture.
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(900)
await p.getByText('Chat', { exact: true }).first().click()
await p.waitForTimeout(1500)

// The transcript is painted on a canvas, so read the model the panel laid out rather than the
// DOM: __canvasTurns is the same array the renderer draws from.
// The stream now carries tool RUNS as well as narration entries; runs have no `.text`.
const turns = await p.evaluate(() => (window.__canvasTurns ?? []).map((t) => ({ kind: t.kind, text: (t.text ?? '').slice(0, 60) })))
const users = turns.filter((t) => t.kind === 'user')
console.log('user turns rendered:', users.length)
for (const u of users) console.log('   ', JSON.stringify(u.text))
const leaked = users.filter((u) => /^\s*<(local-command-|command-name>|command-message>|command-args>|system-reminder>|synthetic>)/.test(u.text))
console.log('injected turns leaked into chat (want 0):', leaked.length)
console.log('the real prompt survived:', users.some((u) => u.text === 'hi'))
const ansi = turns.filter((t) => /\x1b\[/.test(t.text))
console.log('turns still carrying raw ANSI (want 0):', ansi.length)
await p.screenshot({ path: '/tmp/operator-shots/chat-injected.png' })
await b.close()
