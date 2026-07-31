// Drive the agent→agent BRAKES end-to-end through the real renderer
// (dev/briefs/chatter-on-by-default.md, part 2).
//
// WHAT IS REAL HERE: the whole delivery path in the app — `evaluateDelivery`, the live
// `deliveryStateRef`, the outcome records, the channel feed and its chips, the toasts, the submit
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
// A human addressing a lane restores its budget — the only thing that does, by design.
await p.locator('[data-channel-nav]').first().click()
await p.waitForTimeout(900)
// Addressed to ONE lane, so the reset is attributable: resetChainFor keys on the recipient.
await p.locator('[data-channel-target="research"], button', { hasText: /^Research$/ }).first().click().catch(() => {})
await p.waitForTimeout(300)
await p.locator('[data-channel-composer], textarea').first().fill('Carry on.')
await p.waitForTimeout(300)
await p.locator('button', { hasText: /^Send/ }).first().click()
await p.waitForTimeout(1500)
const beforeReset = (await outcomes()).length
await reply('research', 'operator', 'after the human spoke')
const afterReset = await outcomes()
console.log('2 outcome after a human message:', JSON.stringify(afterReset.slice(beforeReset)))
console.log('2 the budget RECOVERED (delivered again):', afterReset[afterReset.length - 1].endsWith(':sent'))

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
await p.locator('[data-channel-nav]').first().click()
await p.waitForTimeout(1000)
const chips = await p.evaluate(() => Array.from(document.querySelectorAll('[data-channel-chip]'))
  .map((e) => ({ label: e.textContent?.trim(), color: getComputedStyle(e).color })))
const uniq = [...new Map(chips.map((c) => [c.label, c.color])).entries()]
console.log('4 chips in the feed:'); for (const [l, c] of uniq) console.log(`   ${String(l).padEnd(34)} ${c}`)
const delivered = uniq.find(([l]) => /delivered/.test(l))
const blocked = uniq.filter(([l]) => /chain limit|sending too fast|paused/.test(l))
console.log('4 blocked rows are present:', blocked.length > 0)
console.log('4 …and NOT the same colour as delivered:', blocked.every(([, c]) => c !== delivered?.[1]))
await p.screenshot({ path: '/tmp/operator-shots/chatter-brakes.png' })

console.log('\n=== 5. THE KILL SWITCH still stops everything ===')
await p.locator('[data-chatter-toggle]').first().click()
await p.waitForTimeout(500)
const beforePause = (await outcomes()).length
await reply('operator', 'research', 'after pausing')
const paused = (await outcomes()).slice(beforePause)
console.log('5 toggle wrote:', await p.evaluate(() => localStorage.getItem('operator.chatterPaused')))
console.log('5 outcome while paused:', JSON.stringify(paused))
console.log('5 nothing delivered:', paused.every((o) => !o.endsWith(':sent')))
await b.close()
