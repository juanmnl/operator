// Drive the agent→agent BRAKES end-to-end through the real renderer
// (dev/briefs/chatter-on-by-default.md, part 2).
//
// WHAT IS REAL HERE: the whole delivery path in the app — `evaluateDelivery`, the live
// `deliveryStateRef`, the outcome records, Team → Dispatches and its labels, the toasts, the submit
// queue, and the new default-on switch. The brake decisions are the shipping code, not a model.
//
// WHAT IS MOCKED: the pty (writes are recorded, nothing is typed), the transcript tailer (this
// fires `onOrchestratorReply` directly instead of parsing JSONL), and the agents themselves — so
// hop TIMING here is the driver's, not a model's. Real per-hop latency is measured separately and
// is the number that decides whether the pair brake is reachable at all; see the RESULT.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.clear() } catch { /* quota */ } })
/** A clean app: fresh delivery state, no suspended pair, no spent hop budget. Each brake gets
 *  one, because the state is a REF that outlives everything short of a reload and a leftover
 *  suspension silently invalidates the next measurement. */
const boot = async () => {
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(3000)
  seq = 0
}

// The fixture's live lanes. s-code ↔ s-res is the pair; s-op is the third party.
const LANE = { code: { sessionId: 's-code', terminalId: 't1', role: 'code' },
               research: { sessionId: 's-res', terminalId: 't2', role: 'research' },
               operator: { sessionId: 's-op', terminalId: 't0', role: 'operator' } }
let seq = 0
await boot()
const reply = async (from, to, text) => {
  seq += 1
  await p.evaluate(([f, t, x, n]) => window.__mockReply({
    id: `r-${n}`, sessionId: f.sessionId, terminalId: f.terminalId,
    projectId: JSON.parse(localStorage.getItem('operator.projects'))[0].id,
    to: t, text: x,
  }), [LANE[from], to, text, seq])
  await p.waitForTimeout(450)
}
// The durable record is the source of truth; the chip is what the user reads.
const outcomes = () => p.evaluate(() => (JSON.parse(localStorage.getItem('operator.projects') || '[]')[0]?.dispatches ?? [])
  .filter((d) => d.replyId).map((d) => `${d.fromRoleId}>${d.toRoleId}:${d.outcome}`))
const writes = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite' && !/^\r$/.test(c.data)).length)

console.log('=== 0. the DEFAULT ===')
console.log('0 chatter key absent at boot :', await p.evaluate(() => localStorage.getItem('operator.chatterPaused')))
console.log('0 delivery is LIVE (first reply is delivered, not held):')
const w0 = await writes()
await reply('code', 'research', 'first hop')
console.log('   outcomes:', JSON.stringify(await outcomes()), '| pty writes +', (await writes()) - w0)

console.log('\n=== 1. HOP LIMIT (HOP_LIMIT = 6) ===')
// A chain with no human in it: each reply inherits the hop last delivered INTO the sender, +1.
for (let i = 2; i <= 9; i++) {
  const [from, to] = i % 2 === 0 ? ['research', 'code'] : ['code', 'research']
  await reply(from, to, `hop ${i}`)
}
const chain = await outcomes()
console.log('1 outcomes in order:', JSON.stringify(chain))
const firstBlock = chain.findIndex((o) => o.endsWith(':hop-limit'))
console.log('1 chain stops, and at hop:', firstBlock + 1, '(HOP_LIMIT = 6)')
console.log('1 the blocked message is RECORDED, not dropped:', chain.some((o) => o.endsWith(':hop-limit')))
// It IS a hard stop now. It wasn't: a block never advanced the recipient's inherited hop
// (nothing was delivered into them), so the other lane's budget was untouched and its next
// message still went — the chain alternated blocked/delivered at half rate instead of ending.
// Measured then: 1 of 3 still delivered. `exhausted` marks BOTH ends on a hop-limit block.
const after = chain.slice(firstBlock + 1)
console.log('1 after the first block:', JSON.stringify(after))
console.log('1 → still delivering after the limit:', after.filter((o) => o.endsWith(':sent')).length, 'of', after.length)
console.log('1 → THE CHAIN STOPS DEAD:', after.every((o) => o.endsWith(':hop-limit')))

console.log('\n=== 2. HUMAN RESET ===')
// FRESH APP. On the first pass this ran against the chain above and was blocked by the PAIR
// brake, not the hop budget — it looked like a failed reset and was really a dirty fixture.
await boot()
// Spend the hop budget on a THREE-lane cycle. A two-lane chain reaches 4-in-window on one
// ordered pair before it reaches hop 6, so the pair brake fires first and the reset can't be
// seen — the first two attempts at this measured the wrong brake.
const CYCLE = [['operator', 'code'], ['code', 'research'], ['research', 'operator']]
for (let i = 0; i < 9; i++) {
  const [f, t] = CYCLE[i % 3]
  await reply(f, t, `spend ${i}`)
}
const spent = await outcomes()
console.log('2 hop budget spent:', JSON.stringify(spent.slice(-4)))
console.log('2 …and it was the HOP limit that stopped it:', spent[spent.length - 1].endsWith(':hop-limit'))
// A HUMAN ADDRESSING A LANE RESTORES ITS BUDGET — the only thing that does, by design.
//
// This used to be typed into the channel composer. The channel is deleted, and the reset moved
// with it: `resetChainFor` now hangs off `dispatchToRole`, whose human-facing entry point is
// Send → on a board card. Same act by the same authority, and this is the assertion that the
// move actually preserved it — without a caller, `exhausted` has no timer and the lane would be
// mute until a restart.
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(700)
await p.locator('[data-project-card]').first().click()
await p.waitForTimeout(1200)
// Board is project home. Take a backlog card, address it to Research with the card's own
// assignee picker (a native <select>, so drive it as one), and press Send →.
const target = await p.evaluate(() => document.querySelector('[data-task-card]')?.getAttribute('data-task-card') ?? null)
const card = p.locator(`[data-task-card="${target}"]`)
await card.locator('[data-card-assignee] select').selectOption('research')
await p.waitForTimeout(500)
await card.locator('[data-card-send]').click()
await p.waitForTimeout(1200)
console.log('2 human Send → fired:', await p.evaluate(() =>
  window.__calls.filter((c) => c.fn === 'terminalWrite').length > 0))

// THE ASSERTION: research was exhausted a moment ago and could not send at all. If the reset
// survived the channel's deletion, its very next reply is delivered again.
const afterHuman = (await outcomes()).length
await reply('research', 'code', 'back to work')
const resumed = (await outcomes()).slice(afterHuman)
console.log('2 after a human Send → the lane speaks again:', JSON.stringify(resumed))
console.log('2 THE HUMAN RESET SURVIVED THE CHANNEL:', resumed.some((o) => o.endsWith(':sent')))

console.log('\n=== 3. PAIR BRAKE (4 per 60s, per ordered pair) ===')
// FRESH APP again, so the hop budget is full and the ONLY thing that can stop this burst is the
// pair brake. Sharing state with §1/§2 would leave which brake fired ambiguous.
await boot()
const pairStart = (await outcomes()).length
for (let i = 0; i < 5; i++) await reply('code', 'research', `burst ${i}`)
const burst = (await outcomes()).slice(pairStart)
console.log('3 code>research burst:', JSON.stringify(burst))
console.log('3 trips after 4 deliveries:', burst.filter((o) => o.endsWith(':sent')).length <= 4)
console.log('3 and names WHY:', burst.some((o) => o.endsWith(':pair-brake')))
// The suspension is per ORDERED pair: the reverse direction and a third party stay reachable.
const beforeOthers = (await outcomes()).length
await reply('research', 'code', 'reverse direction')
await reply('operator', 'code', 'third party')
const others = (await outcomes()).slice(beforeOthers)
console.log('3 reverse direction still reachable:', others[0]?.endsWith(':sent'))
console.log('3 a different pair still reachable :', others[1]?.endsWith(':sent'))

// The release. PAIR_SUSPEND_MS is 5 minutes of REAL time and there is no clock to inject here —
// that is the point of doing it in the app — so it is opt-in: `RELEASE=1 node dev/drive-chatter-brakes.mjs`.
if (process.env.RELEASE === '1') {
  console.log('\n=== 3b. PAIR BRAKE RELEASES (PAIR_SUSPEND_MS = 5min, real time) ===')
  const t0 = Date.now()
  let released = null
  // Poll rather than sleeping exactly 5 minutes, so the observed release time is measured.
  for (let i = 0; i < 40 && released === null; i++) {
    await p.waitForTimeout(20_000)
    const n = (await outcomes()).length
    await reply('code', 'research', `release probe ${i}`)
    const last = (await outcomes())[n]
    if (last?.endsWith(':sent')) released = Date.now() - t0
    else process.stdout.write(`   +${Math.round((Date.now() - t0) / 1000)}s still suspended\n`)
  }
  console.log('3b released after:', released === null ? 'NEVER (still suspended)' : `${Math.round(released / 1000)}s`)
  console.log('3b within a minute of the 300s constant:', released !== null && Math.abs(released / 1000 - 300) < 60)
}

console.log('\n=== 4. LEGIBILITY — is a blocked message distinguishable? ===')
// The channel folded each outcome into its reply's row and this read those chips. The board
// deliberately shows none of them (a `replyId` record is chat about work, never work), so the
// surviving surface is Team → Dispatches — which is exactly why that log had to survive the
// deletion, and why it now reads the shared outcome vocabulary instead of its own short map.
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(700)
await p.locator('[data-project-card]').first().click()
await p.waitForTimeout(900)
await p.locator('[data-toolbar-header="project"] button', { hasText: 'Team' }).click()
await p.waitForTimeout(900)
// The log starts collapsed unless something is pending; open it.
await p.locator('button', { hasText: /Dispatches · \d+/ }).first().click().catch(() => {})
await p.waitForTimeout(500)
const chips = await p.evaluate(() => Array.from(document.querySelectorAll('[data-dispatch-outcome]'))
  .map((e) => ({ label: e.getAttribute('title') || e.textContent?.trim(), color: getComputedStyle(e).color })))
const uniq = [...new Map(chips.map((c) => [c.label, c.color])).entries()]
console.log('4 outcomes in the dispatch log:'); for (const [l, c] of uniq) console.log(`   ${String(l).padEnd(34)} ${c}`)
const delivered = uniq.find(([l]) => /delivered/.test(l))
const blocked = uniq.filter(([l]) => /chain limit|sending too fast|paused/.test(l))
console.log('4 blocked rows are present:', blocked.length > 0)
console.log('4 …and NOT the same colour as delivered:', blocked.every(([, c]) => c !== delivered?.[1]))
console.log('4 …and none of them prints a raw enum string:',
  !uniq.some(([l]) => /^(hop-limit|pair-brake|paused|undelivered)$/.test(String(l))))
await p.screenshot({ path: '/tmp/operator-shots/chatter-brakes-log.png' })

await b.close()
