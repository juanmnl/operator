// Drive the channel's AUTHOR axis (dev/briefs/channel-author-uuid.md).
//
// Every lane reply was authored by a raw session uuid — generic initials, no accent — while
// Operator's own dispatches resolved fine. `?author=1` seeds two replies carrying the CLAUDE
// session ids verbatim from chat.db, from lanes that are NOT in the live run: the only thing that
// can name them is the durable saved-session store, which is exactly what was missing.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.clear() } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html?author=1`, { waitUntil: 'load' })
await p.waitForTimeout(3200)
await p.locator('[data-channel-nav]').first().click()
await p.waitForTimeout(1200)

const rows = await p.evaluate(() => Array.from(document.querySelectorAll('[data-channel-row]')).map((r) => ({
  author: r.querySelector('[data-channel-author]')?.textContent?.trim() ?? null,
  color: r.querySelector('[data-channel-author]') ? getComputedStyle(r.querySelector('[data-channel-author]')).color : null,
  initials: r.querySelector('[data-channel-avatar]')?.textContent?.trim() ?? null,
})))
console.log('channel rows:')
for (const r of rows) console.log(`   ${String(r.initials).padEnd(4)} ${String(r.author).padEnd(16)} ${r.color}`)

const uuidish = /[0-9a-f]{8}-[0-9a-f]{4}/i
console.log('\nno author is a uuid          :', rows.every((r) => !uuidish.test(r.author || '')))
console.log('no author is an id fragment  :', rows.every((r) => !/^[0-9a-f]{6,}$/i.test(r.author || '')))
console.log('the two ENDED lanes are named:', rows.some((r) => r.author === 'Design') && rows.some((r) => r.author === 'Code'))
console.log('…in their own lane colours   :', new Set(rows.filter((r) => ['Design', 'Code'].includes(r.author)).map((r) => r.color)).size === 2)
console.log('initials are the lane\'s, not the hash\'s:', rows.filter((r) => r.author === 'Design').every((r) => r.initials === 'DE'))
await p.screenshot({ path: '/tmp/operator-shots/channel-author.png' })
await b.close()
