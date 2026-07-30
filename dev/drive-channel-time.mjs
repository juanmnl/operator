// Drive the channel's timestamps in LOCAL time (dev/briefs/channel-timestamps-utc.md).
//
// The bug: three sites SLICED the ISO string instead of converting it, so the feed showed raw UTC
// — the menu bar read 17:12 while the newest row read 22:10. The worse half is the day separator,
// which bucketed on the UTC date: west of Greenwich every instant from 19:00 local already carries
// tomorrow's UTC date, so the evening files under tomorrow and "today" appears to start at 7pm.
//
// The clock is FAKED to 20:30 local — past that boundary — because at 15:00 the bug is invisible
// and a driver run in the afternoon would go green over it.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()

// A fixed instant that straddles the boundary: 01:30Z on the 31st is 20:30 on the 30th at UTC−5.
const AT = '2026-07-31T01:30:00.000Z'
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 }, colorScheme: 'dark',
  timezoneId: 'America/Guayaquil',      // the user's machine
})
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
// Seed a dispatch at that instant so the feed has a row whose UTC and local dates differ.
await p.addInitScript((at) => {
  try {
    localStorage.removeItem('operator.activeProjectId')
    window.__seedChannelAt = at
  } catch { /* quota */ }
}, AT)
// The fixture carries the two evening dispatches; a live `__mockDispatch` can't be used here
// because the app stamps `at` itself, which would only ever produce "now".
await p.goto(`http://localhost:${PORT}/dev/mock.html?tz=1`, { waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.locator('[data-project-card]').first().click()
await p.waitForTimeout(1000)
await p.locator('[data-channel-nav]').first().click()
await p.waitForTimeout(1000)

const seen = await p.evaluate(() => ({
  days: Array.from(document.querySelectorAll('[data-channel-day]')).map((e) => e.textContent?.trim()),
  times: Array.from(document.querySelectorAll('[data-channel-row]')).map((r) => {
    const spans = Array.from(r.querySelectorAll('span'))
    return spans.map((s) => s.textContent?.trim()).find((t) => /^\d{2}:\d{2}$/.test(t || '')) ?? null
  }),
}))
console.log('day separators :', JSON.stringify(seen.days))
console.log('row times      :', JSON.stringify(seen.times))

// What the machine would say for the same instant, and what the OLD slice said.
const truth = await p.evaluate((at) => ({
  local: new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  localDay: new Date(at).toLocaleDateString('en-CA'),
  slicedTime: at.slice(11, 16),
  slicedDay: at.slice(0, 10),
}), AT)
console.log('\nfor', AT, 'at UTC-5:')
console.log('  machine says  :', truth.local, 'on', truth.localDay)
console.log('  the SLICE said:', truth.slicedTime, 'on', truth.slicedDay, ' ← the bug')
console.log('  rendered time matches the machine :', seen.times.includes(truth.local))
console.log('  divider stays on the local day    :', seen.days.includes(truth.localDay))
console.log('  divider is NOT the UTC date       :', !seen.days.includes(truth.slicedDay))
await p.screenshot({ path: '/tmp/operator-shots/channel-local-time.png' })
await b.close()
