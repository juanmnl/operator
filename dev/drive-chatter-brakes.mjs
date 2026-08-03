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

// ARMED. Every check below is an assertion with an exit code behind it, not a printed boolean.
// It used to be the latter throughout — so deleting `resetChainFor` from DashboardView made it
// print `THE HUMAN RESET SURVIVED THE CHANNEL: false` and exit 0. This is the one behaviour in
// the delivery path with no unit test and the worst failure mode (a lane silently mute until
// restart), and it was the only driver in the change left unable to report a regression.
let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => { console.log('ERR', String(e).slice(0, 200)); failed++ })
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
ok('the chatter key is absent at boot (untouched install)',
  (await p.evaluate(() => localStorage.getItem('operator.chatterPaused'))) === null)
const w0 = await writes()
await reply('code', 'research', 'first hop')
const first = await outcomes()
ok('delivery is LIVE — the first reply is DELIVERED, not held',
  first.length === 1 && first[0].endsWith(':sent'), first)
ok('…and it reached the pty', (await writes()) - w0 === 1)

console.log('\n=== 1. HOP LIMIT (HOP_LIMIT = 6) ===')
// A chain with no human in it: each reply inherits the hop last delivered INTO the sender, +1.
for (let i = 2; i <= 9; i++) {
  const [from, to] = i % 2 === 0 ? ['research', 'code'] : ['code', 'research']
  await reply(from, to, `hop ${i}`)
}
const chain = await outcomes()
console.log('1 outcomes in order:', JSON.stringify(chain))
const firstBlock = chain.findIndex((o) => o.endsWith(':hop-limit'))
ok('the chain stops at HOP_LIMIT', firstBlock + 1 === 6, { stoppedAtHop: firstBlock + 1 })
ok('the blocked message is RECORDED, not dropped', chain.some((o) => o.endsWith(':hop-limit')))
// It IS a hard stop now. It wasn't: a block never advanced the recipient's inherited hop
// (nothing was delivered into them), so the other lane's budget was untouched and its next
// message still went — the chain alternated blocked/delivered at half rate instead of ending.
// Measured then: 1 of 3 still delivered. `exhausted` marks BOTH ends on a hop-limit block.
const after = chain.slice(firstBlock + 1)
console.log('1 after the first block:', JSON.stringify(after))
ok('THE CHAIN STOPS DEAD — every later hop blocks, not just the first',
  after.length > 0 && after.every((o) => o.endsWith(':hop-limit')),
  { checked: after.length, stillDelivering: after.filter((o) => o.endsWith(':sent')).length })

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
ok('the hop budget is spent before the reset is attempted',
  spent.length > 0 && spent[spent.length - 1].endsWith(':hop-limit'), spent.slice(-2))
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
ok('(precondition) a backlog card to send from', !!target, target)
const card = p.locator(`[data-task-card="${target}"]`)
await card.locator('[data-card-assignee] select').selectOption('research')
await p.waitForTimeout(500)
// DELTA, not a cumulative count. This read `…length > 0` over the whole run, which is true from
// §0 onward regardless of what the button did — so the step could silently stop clicking
// anything and the check would still pass.
await card.locator('[data-card-send]').click()
// The check is the TASK REACHING `running`, not a pty-write count. `sendProjectTask` only marks
// a task running on its LIVE-LANE branch — the same branch that calls `dispatchToRole`, which is
// where `resetChainFor` now lives. So this asserts the reset's host actually executed, which a
// cumulative `terminalWrite` count never did (it was true from §0 onward whatever the button
// did), and a delta of it could not either: the submit queue is serialized per terminal and this
// lane has a dozen replies ahead of it, so the write lands whenever it lands.
let ranStatus = null
for (let i = 0; i < 20 && ranStatus !== 'running'; i++) {
  await p.waitForTimeout(250)
  ranStatus = await p.evaluate((id) => (JSON.parse(localStorage.getItem('operator.projects') || '[]')[0]?.tasks ?? [])
    .find((t) => t.id === id)?.status ?? null, target)
}
ok('the human Send → ran the live-lane path that hosts the reset', ranStatus === 'running',
  { taskStatus: ranStatus })

// THE ASSERTION: research was exhausted a moment ago and could not send at all. If the reset
// survived the channel's deletion, its very next reply is delivered again.
const afterHuman = (await outcomes()).length
await reply('research', 'code', 'back to work')
const resumed = (await outcomes()).slice(afterHuman)
ok('THE HUMAN RESET SURVIVED THE CHANNEL — the exhausted lane speaks again',
  resumed.length > 0 && resumed.some((o) => o.endsWith(':sent')), resumed)

console.log('\n=== 3. PAIR BRAKE (4 per 60s, per ordered pair) ===')
// FRESH APP again, so the hop budget is full and the ONLY thing that can stop this burst is the
// pair brake. Sharing state with §1/§2 would leave which brake fired ambiguous.
await boot()
const pairStart = (await outcomes()).length
for (let i = 0; i < 5; i++) await reply('code', 'research', `burst ${i}`)
const burst = (await outcomes()).slice(pairStart)
console.log('3 code>research burst:', JSON.stringify(burst))
ok('the pair brake trips after at most PAIR_MAX_IN_WINDOW deliveries',
  burst.filter((o) => o.endsWith(':sent')).length <= 4, burst)
ok('…and the record names WHY', burst.some((o) => o.endsWith(':pair-brake')))
// The suspension is per ORDERED pair: the reverse direction and a third party stay reachable.
const beforeOthers = (await outcomes()).length
await reply('research', 'code', 'reverse direction')
await reply('operator', 'code', 'third party')
const others = (await outcomes()).slice(beforeOthers)
ok('the brake is per ORDERED PAIR — the reverse direction still delivers', !!others[0]?.endsWith(':sent'))
ok('…and a different pair still delivers', !!others[1]?.endsWith(':sent'))

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
  ok('the pair suspension RELEASES, within a minute of the 300s constant',
    released !== null && Math.abs(released / 1000 - 300) < 60,
    released === null ? 'NEVER (still suspended)' : `${Math.round(released / 1000)}s`)
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
// BOTH SIDES MUST EXIST before comparing them. This was `blocked.every(([, c]) => c !== delivered?.[1])`
// with `blocked.length > 0` merely LOGGED beside it — so with an empty log, `delivered?.[1]` is
// undefined, every colour compares unequal, and the check passed by finding nothing at all.
ok('(precondition) the log rendered both a delivered row and a blocked one',
  !!delivered && blocked.length > 0, { delivered: delivered?.[0], blocked: blocked.map(([l]) => l) })
ok('a blocked outcome is NOT the same colour as a delivered one',
  !!delivered && blocked.length > 0 && blocked.every(([, c]) => c !== delivered[1]),
  { delivered: delivered?.[1], blocked: blocked.map(([, c]) => c) })
ok('no outcome prints a raw enum string',
  !uniq.some(([l]) => /^(hop-limit|pair-brake|paused|undelivered|queued)$/.test(String(l))))
// F5/F6: the outcome recorded when a reply is addressed to a lane that isn't running. It used to
// render in the muted ink (its tone had no branch) AND read "queued · behind current task", while
// the agent was told by REPLY_PROTOCOL that the message was dropped. Both are fixed; this is the
// guard. Produce one and look at what it says and how it is drawn.
await p.evaluate(() => window.__mockKillLane?.('t2'))
const qBefore = (await outcomes()).length
await reply('code', 'design', 'to a lane that is not running')
const queued = (await outcomes()).slice(qBefore)
if (queued.some((o) => o.endsWith(':queued'))) {
  await p.locator('[data-rail-gallery]').click(); await p.waitForTimeout(600)
  await p.locator('[data-project-card]').first().click(); await p.waitForTimeout(800)
  await p.locator('[data-toolbar-header="project"] button', { hasText: 'Team' }).click(); await p.waitForTimeout(800)
  await p.locator('button', { hasText: /Dispatches · \d+/ }).first().click().catch(() => {})
  await p.waitForTimeout(400)
  const all = await p.evaluate(() => Array.from(document.querySelectorAll('[data-dispatch-outcome]'))
    .map((e) => ({ label: e.getAttribute('title') || e.textContent?.trim(), color: getComputedStyle(e).color })))
  const q = all.find((c) => /lane wasn/.test(String(c.label)))
  // Compared against the TOKEN, not against a sibling row. Comparing to a `declined` row read as
  // a pass whenever the log happened to contain no such row — `!dead || …` — which is the same
  // find-nothing-and-pass shape as §4's original colour check. --fg-muted is what `progress`
  // wrongly fell through to, so that is the thing to be unequal to.
  const mutedInk = await p.evaluate(() => {
    const s = document.createElement('span')
    s.style.color = 'var(--fg-muted)'
    document.body.appendChild(s)
    const c = getComputedStyle(s).color
    s.remove()
    return c
  })
  ok('(precondition) the idle-lane outcome rendered', !!q, q)
  ok('it is not drawn in the muted ink of an outcome nothing is waiting on',
    !!q && q.color !== mutedInk, { row: q?.color, muted: mutedInk })
  ok('…and it says the message was NOT delivered, not that it is queued behind something',
    !!q && !/behind current task/.test(String(q.label)), q?.label)
} else {
  console.log('   (no queued outcome produced in this run — the progress-tone check did not run)')
}
await p.screenshot({ path: '/tmp/operator-shots/chatter-brakes-log.png' })

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
