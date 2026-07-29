// The transcript feeds upward instead of teleporting (dev/briefs/chat-typewriter-feed.md).
// The animation is nearly free; these assertions are the actual work — every one of them is a
// trap the brief called out. Runs on a 300-turn transcript (?chat=long), because a three-turn
// fixture would pass while the real thing stutters.
//
// Run: `npx vite --port 1447` then `MOCK_PORT=1447 node dev/drive-chat-feed.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1447

const open = async (b, { reducedMotion } = {}) => {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion })
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 160)))
  await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch {} })
  await p.goto(`http://localhost:${PORT}/dev/mock.html?chat=long`, { waitUntil: 'load' })
  await p.waitForTimeout(3000)
  await p.locator('[data-session-row="s-code"]').click(); await p.waitForTimeout(800)
  await p.getByText('Chat', { exact: true }).first().click(); await p.waitForTimeout(2000)
  return p
}
const scroller = () => `Array.from(document.querySelectorAll('div')).find((d) => /auto/.test(getComputedStyle(d).overflow) && d.scrollHeight > d.clientHeight + 50)`
const pos = (p) => p.evaluate(`(() => { const el = ${scroller()}; return el ? { top: Math.round(el.scrollTop), h: el.scrollHeight, ch: el.clientHeight, fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) } : null })()`)

const b = await webkit.launch()

// --- 1. first paint lands AT the bottom, without animating there ---
let p = await open(b)
const first = await pos(p)
console.log('1 long transcript loaded:', first.h > 5000, `(doc ${first.h}px)`)
console.log('1 first paint is at the bottom, snapped:', first.fromBottom < 5, `(${first.fromBottom}px from bottom)`)

// --- 2. a turn landing while stuck: view ENDS at the bottom, stick survived (trap 1) ---
// Record every scroll position rather than sampling: a 260ms flight can start and finish
// between two waits, and "I didn't catch it moving" is not evidence that it teleported.
await p.evaluate(`(() => {
  const el = ${scroller()}
  window.__samples = []
  el.addEventListener('scroll', () => window.__samples.push(Math.round(el.scrollTop)), { passive: true })
})()`)
await p.evaluate(() => window.__mockAppend('s-code', 'A new answer arrives while the reader is at the live edge. '.repeat(6)))
await p.waitForTimeout(900) // past the ~260ms flight
const samples = await p.evaluate(() => window.__samples ?? [])
const settled = await pos(p)
// A teleport is ONE scroll event to the final position; a feed is many, advancing.
console.log('2 it FED rather than teleported:', samples.length > 3, `(${samples.length} scroll steps: ${samples.slice(0, 3).join('→')}…${samples.slice(-1)})`)
console.log('2 END STATE is the bottom (stick survived its own animation):', settled.fromBottom < 5)
console.log('2 jump-to-latest is absent, i.e. still at the live edge:', (await p.locator('[data-jump-latest]').count()) === 0)

// --- 3. a big jump does not animate (trap 3) ---
await p.evaluate(`(() => { const el = ${scroller()}; el.scrollTop = 0 })()`)
await p.waitForTimeout(600)
await p.locator('[data-jump-latest]').click()
await p.waitForTimeout(60)  // well inside a 260ms flight
const big = await pos(p)
console.log('3 a viewport-plus jump SNAPS, no slow slide:', big.fromBottom < 5, `(${big.fromBottom}px after 60ms)`)

// --- 4. user scroll during an animation wins immediately (trap 2) ---
await p.evaluate(() => window.__mockAppend('s-code', 'Another answer. '.repeat(40)))
await p.waitForTimeout(40)
await p.mouse.move(700, 400)
await p.mouse.wheel(0, -1200)         // the reader pulls away mid-flight
await p.waitForTimeout(700)
const afterUser = await pos(p)
// The property is "the app did not drag them back", i.e. they stayed off the live edge —
// not a particular pixel distance (headless wheel deltas are not the user's).
console.log('4 the user won — not dragged back to the bottom:', afterUser.fromBottom >= 80, `(${afterUser.fromBottom}px from bottom)`)
console.log('4 and stick released, so the jump control is offered:', (await p.locator('[data-jump-latest]').count()) > 0)
await p.close()

// --- 5. prefers-reduced-motion snaps (trap 5) ---
p = await open(b, { reducedMotion: 'reduce' })
await p.evaluate(() => window.__mockAppend('s-code', 'Reduced motion answer. '.repeat(20)))
await p.waitForTimeout(80)            // inside the flight window, but there should BE no flight
const rm = await pos(p)
console.log('5 reduced motion snaps straight to the bottom:', rm.fromBottom < 5, `(${rm.fromBottom}px after 80ms)`)
await b.close()
