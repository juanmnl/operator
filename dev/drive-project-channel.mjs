// Drive the project CHANNEL — step 1, the read-only feed
// (dev/briefs/project-channel-readonly.md).
//
// It merges two stores that already existed and were never shown together: Project.dispatches
// and chat.db's OPERATOR-REPLY rows. Nothing here sends: the assertions below include that the
// composer CANNOT submit, which is the whole point of shipping this step on its own.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-project-channel.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })

// Seed a MIXED feed: dispatches spanning two days with every outcome, plus replies that have to
// interleave between them by timestamp. `projectReplies` is stubbed here because the real table
// is empty (no lane has emitted the sentinel yet) — the merge is what's under test.
await ctx.addInitScript(() => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const orig = v.loadProjects
      v.loadProjects = async () => {
        const list = (await orig()) ?? []
        return list.map((p) => (p.name !== 'operator' ? p : {
          ...p,
          dispatches: [
            { id: 'd1', at: '2026-07-29T09:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'FIRST delivered task', outcome: 'sent' },
            { id: 'd2', at: '2026-07-29T09:05:00.000Z', fromRoleId: 'operator', toRoleId: 'design', task: 'SECOND launched task', outcome: 'launched' },
            { id: 'd3', at: '2026-07-30T09:00:00.000Z', fromRoleId: 'operator', toRoleId: 'research', task: 'THIRD queued task', outcome: 'queued' },
            { id: 'd4', at: '2026-07-30T09:10:00.000Z', fromRoleId: 'research', toRoleId: 'code', task: 'FOURTH held task', outcome: 'pending-approval' },
            { id: 'd5', at: '2026-07-30T09:15:00.000Z', fromRoleId: 'qa', toRoleId: 'design', task: 'FIFTH declined task', outcome: 'rejected' },
            { id: 'd6', at: '2026-07-30T09:20:00.000Z', fromRoleId: 'operator', task: 'SIXTH unroutable task', outcome: 'unassigned' },
          ],
        }))
      }
      v.saveProjects = () => {}
      // The reply half. s-code / s-res are the mock's own session ids, so attribution resolves
      // session → roleId → Role exactly as it must in the real app.
      // Seeded history, MERGED with the bridge's own store rather than replacing it — `__mockReply`
      // writes there, and step 3's delivery outcomes fold onto rows read back from it.
      const seeded = [
        { id: 'seed-1', sessionId: 's-code', to: 'operator', text: 'REPLY between first and second', timestamp: '2026-07-29T09:02:00.000Z' },
        { id: 'seed-2', sessionId: 's-res', to: 'project', text: 'REPLY broadcast to the room', timestamp: '2026-07-30T09:12:00.000Z' },
        { id: 'seed-3', sessionId: 's-vanished', to: 'operator', text: 'REPLY from a session that is gone', timestamp: '2026-07-30T09:30:00.000Z' },
      ]
      const liveReplies = v.projectReplies
      v.projectReplies = async (pid) => [...seeded, ...((await liveReplies(pid)) ?? [])]
    },
  })
})

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
const writes = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite').length)
// The send target moved from a seven-pill radio bank to one control that opens a menu — most
// messages never change it, so it stopped costing a permanent row.
const pickTarget = async (key) => {
  await p.locator('[data-channel-send-target]').click()
  await p.waitForTimeout(150)
  await p.locator(`[data-popmenu-item="${key}"]`).click()
  await p.waitForTimeout(150)
}

// The mock's three LIVE lanes, terminal → session. Needed to confirm a submission the way the
// real transcript tailer would (`window.__mockUserTurn`, mock-bridge.ts) — without it, every
// SECOND write to the same terminal queues behind the submit queue's closed-loop confirm wait
// (up to 30s, `RESCUE_AFTER_MS` in submit-queue.ts). That is invisible in the real app, where a
// live Claude session produces a turn in well under a second, but this driver fires several
// messages at one lane inside its own assertion windows — see the result file for how much of
// the driver that silently broke before this existed.
const SESSION_OF = { t0: 's-op', t1: 's-code', t2: 's-res' }
// Confirm the LAST write to `terminalId` as a real turn. Reads the raw text back off the write
// itself (the bracketed paste's payload, wrapper stripped) rather than reconstructing whatever
// prefix/truncation the app applied — so it works for a human send and a relayed one alike, and
// for the one truncated case, without duplicating that logic here. A safe no-op when the target
// never wrote anything (idle lane, or a block).
const confirmWrite = (terminalId) => p.evaluate(({ terminalId, sessionId }) => {
  if (!sessionId) return false
  const own = window.__calls.filter((c) => c.fn === 'terminalWrite' && c.id === terminalId)
  const last = own[own.length - 1]
  if (!last) return false
  const m = /^\x1b\[200~([\s\S]*)\x1b\[201~\r$/.exec(String(last.data))
  if (!m) return false
  window.__mockUserTurn(sessionId, m[1])
  return true
}, { terminalId, sessionId: SESSION_OF[terminalId] })
// Strip the bracketed-paste wrapper off a recorded `terminalWrite` call's data, so a check reads
// what was actually SUBMITTED rather than that plus 13 bytes of ESC[200~ / ESC[201~\r overhead.
const unwrap = (data) => {
  const m = /^\x1b\[200~([\s\S]*)\x1b\[201~\r$/.exec(String(data))
  return m ? m[1] : String(data)
}

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3200)

// ---- 1. The sidebar row, with an unread count ------------------------------------------
const row = await p.evaluate(() => {
  const el = document.querySelector('[data-channel-nav]')
  return el ? { text: el.textContent?.trim(), unread: el.querySelector('[data-channel-unread]')?.textContent?.trim() } : null
})
console.log('1 sidebar row:', JSON.stringify(row), '(expect "channel" + 9 unread — nothing read yet)')

// ---- 2. Open it: the feed is time-ordered and interleaved ------------------------------
await p.locator('[data-channel-nav]').click()
await p.waitForTimeout(900)
const rows = await p.evaluate(() => Array.from(document.querySelectorAll('[data-channel-text]')).map((e) => e.textContent.trim().slice(0, 30)))
console.log('2 feed order:', JSON.stringify(rows, null, 0))
console.log('2 dispatches and replies interleaved by time:',
  rows[0].startsWith('FIRST') && rows[1].startsWith('REPLY between') && rows[2].startsWith('SECOND'), '(expect true)')
console.log('2 day separators:', await p.evaluate(() => Array.from(document.querySelectorAll('[data-channel-day]')).map((e) => e.textContent.trim())))

// ---- 3. Every outcome gets its own chip ------------------------------------------------
console.log('3 chips:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-channel-chip]')).map((e) => e.textContent.trim()))))

// ---- 4. Authorship: resolved lanes, and an unresolvable session shown verbatim ----------
console.log('4 authors:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-channel-author]')).map((e) => e.textContent.trim()))))
console.log('4 avatars are CIRCLES (lane vocabulary, not the rail\'s squares):', await p.evaluate(() => {
  const a = document.querySelector('[data-channel-avatar]')
  return a ? getComputedStyle(a).borderRadius : null
}), '(expect 50%)')

// ---- 5. A held dispatch is actionable — through the EXISTING approval handlers ----------
console.log('5 approve/decline offered only on the held row:', await p.evaluate(() => ({
  approve: Array.from(document.querySelectorAll('[data-channel-approve]')).map((b) => b.getAttribute('data-channel-approve')),
  decline: Array.from(document.querySelectorAll('[data-channel-reject]')).map((b) => b.getAttribute('data-channel-reject')),
})), '(expect [d4] only)')

// ---- 6. The composer is LIVE now (step 2) — target pills selectable, cap enforced -------
const composer = await p.evaluate(() => {
  const ta = document.querySelector('[data-channel-composer]')
  const send = document.querySelector('[data-channel-send]')
  return {
    textareaDisabled: ta?.disabled ?? null,
    sendDisabled: send?.disabled ?? null,
    note: document.querySelector('[data-channel-composer-note]')?.textContent?.trim().slice(0, 60),
    // Addressing is one control that opens a menu now, not a permanent pill bank.
    target: document.querySelector('[data-channel-send-target]')?.textContent.trim(),
  }
})
console.log('6 composer:', JSON.stringify(composer, null, 0), '(expect enabled, with a target control)')

// ---- 7. Reading it clears the unread badge ----------------------------------------------
console.log('7 unread after reading:', await p.evaluate(() =>
  document.querySelector('[data-channel-unread]')?.textContent?.trim() ?? null), '(expect null)')
console.log('7 persisted read mark:', await p.evaluate(() => localStorage.getItem('operator.channelReadAt')))

// ---- 8. Approving from the channel uses the one existing path ---------------------------
const w2 = await writes()
await p.locator('[data-channel-approve="d4"]').click()
await p.waitForTimeout(900)
console.log('8 approving delivered the held task:', await p.evaluate(() => window.__calls
  .filter((c) => c.fn === 'terminalWrite' && String(c.data ?? '').includes('FOURTH held')).length), '(expect 1)')
console.log('8 its chip is no longer held:', await p.evaluate(() => {
  const row = document.querySelector('[data-channel-row="dispatch:d4"]')
  return row?.querySelector('[data-channel-chip]')?.textContent?.trim()
}), `(writes ${w2} → ${await writes()})`)
await confirmWrite('t1') // frees Code's terminal for the sends that follow

// ---- 9. HUMAN → ONE LANE ---------------------------------------------------------------
const spawns = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalSpawn').length)
const sentFor = (needle) => p.evaluate((n) => window.__calls
  .filter((c) => c.fn === 'terminalWrite' && String(c.data ?? '').includes(n)).length, needle)
// Find a row by its text. NOT `slice(-1)`: the seeded fixture is timestamped later in the day
// than "now", so a real send sorts BEFORE it — which is the feed being correct, not broken.
const rowFor = (needle) => p.evaluate((n) => {
  const row = Array.from(document.querySelectorAll('[data-channel-row]'))
    .find((r) => (r.querySelector('[data-channel-text]')?.textContent ?? '').includes(n))
  if (!row) return null
  const head = row.querySelector('[data-channel-author]')?.parentElement
  return {
    id: row.getAttribute('data-channel-row'),
    header: head?.textContent?.trim().replace(/\s+/g, ' '),
    chip: row.querySelector('[data-channel-chip]')?.textContent?.trim(),
  }
}, needle)

// `Code` is live in the mock (t1); `Design` is idle.
await pickTarget('code')
await p.locator('[data-channel-composer]').fill('HUMANTOCODE take a look at this')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(900)
console.log('9 delivered to the live lane:', await sentFor('HUMANTOCODE'), '(expect 1)')
console.log('9 it renders as You → Code, delivered:', JSON.stringify(await rowFor('HUMANTOCODE')))
console.log('9 composer cleared:', await p.evaluate(() => document.querySelector('[data-channel-composer]').value === ''))
await confirmWrite('t1')

// ---- 10. AN IDLE TARGET IS QUEUED, NEVER LAUNCHED --------------------------------------
const spawnsBefore = await spawns()
await pickTarget('design')
await p.locator('[data-channel-composer]').fill('HUMANTOIDLE nice work earlier')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(900)
console.log('10 NOTHING was spawned for the idle lane:', (await spawns()) === spawnsBefore, `(spawns ${spawnsBefore} → ${await spawns()})`)
console.log('10 nothing was written to a pty for it:', await sentFor('HUMANTOIDLE'), '(expect 0)')
console.log('10 recorded as queued, not delivered:', JSON.stringify(await rowFor('HUMANTOIDLE')))
console.log('10 and it says who will get it later:', await p.evaluate(() =>
  document.querySelector('[data-channel-composer-note]')?.textContent?.trim().slice(0, 90)))

// ---- 11. THE CAP: refused, never truncated ---------------------------------------------
const w = await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite').length)
await pickTarget('code')
await p.locator('[data-channel-composer]').fill('CAPTEST' + 'x'.repeat(2000))
await p.waitForTimeout(400)
console.log('11 send is disabled over cap:', await p.evaluate(() => document.querySelector('[data-channel-send]').disabled), '(expect true)')
console.log('11 the counter shows the overrun:', await p.evaluate(() => document.querySelector('[data-channel-count]')?.textContent?.trim()))
console.log('11 the note explains the refusal:', await p.evaluate(() =>
  document.querySelector('[data-channel-composer-note]')?.textContent?.trim().slice(0, 70)))
// ⌘↵ must not bypass the composer's own check.
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(700)
console.log('11 ⌘↵ did NOT send it:', (await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite').length)) === w, '(expect true)')
console.log('11 the draft was NOT truncated:', await p.evaluate(() => document.querySelector('[data-channel-composer]').value.length), '(expect 2007)')

// ---- 12. FAN-OUT collapses to one row --------------------------------------------------
await p.locator('[data-channel-composer]').fill('')
await pickTarget('everyone')
await p.locator('[data-channel-composer]').fill('HUMANTOALL standup in five')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(1100)
console.log('12 written once per LIVE lane:', await sentFor('HUMANTOALL'))
console.log('12 collapsed into a single row:', JSON.stringify(await rowFor('HUMANTOALL')))
console.log('12 …exactly ONE row for the fan-out:', await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-channel-row]'))
    .filter((r) => (r.querySelector('[data-channel-text]')?.textContent ?? '').includes('HUMANTOALL')).length), '(expect 1)')
console.log('12 idle lanes were skipped, not started:', (await spawns()) === spawnsBefore, '(expect true)')
for (const t of ['t0', 't1', 't2']) await confirmWrite(t) // frees every lane the fan-out touched

await p.screenshot({ path: '/tmp/operator-shots/project-channel-send.png' })

// ========================================================================================
// STEP 3 — AGENT → AGENT. Every group below is a guardrail, not a feature.
// ========================================================================================

// Fire a reply the way the tailer does: persist the row, then emit. `n` keeps every id unique so
// the seen-set and the durable replyId guard don't eat the second one.
let replyN = 0
// role → the terminal a delivery INTO that role writes to, so a reply can confirm its own send.
const ROLE_TERMINAL = { operator: 't0', code: 't1', research: 't2' }
const laneReply = async (fromSession, fromTerminal, to, text) => {
  await p.evaluate(({ s, t, to, text, id }) => window.__mockReply({
    id, sessionId: s, terminalId: t, projectId: window.__projectId, to, text,
  }), { s: fromSession, t: fromTerminal, to, text, id: `lr-${++replyN}` })
  await p.waitForTimeout(700)
  await confirmWrite(ROLE_TERMINAL[to]) // no-op on a block; otherwise frees `to`'s terminal
}
// The scoped project's id, so a fired reply lands in the channel being watched.
await p.evaluate(() => {
  window.__projectId = JSON.parse(localStorage.getItem('operator.projects') ?? '[]')
    .find((x) => x.name === 'operator')?.id
})
const chipFor = (needle) => p.evaluate((n) => {
  const row = Array.from(document.querySelectorAll('[data-channel-row]'))
    .find((r) => (r.querySelector('[data-channel-text]')?.textContent ?? '').includes(n))
  return row?.querySelector('[data-channel-chip]')?.textContent?.trim() ?? null
}, needle)
const toggle = () => p.locator('[data-chatter-toggle]')

// ---- 13. THE REST STATE IS LIVE BY DEFAULT ----------------------------------------------
// c0c392c ("Agent↔agent delivery ships ON, and the brakes proved in the app") flipped this from
// paused to live. Asserted explicitly rather than assumed — see chatterPausedFrom in
// lib/agent-delivery.ts, whose whole job is this one mapping — so the next flip of the default
// fails ONE assertion here instead of cascading through every phase below it.
console.log('13 switch label at rest:', (await toggle().textContent())?.trim(), '(expect "Agent↔agent live" — c0c392c shipped this default ON)')
console.log('13 aria-pressed:', await toggle().getAttribute('aria-pressed'), '(expect true)')
console.log('13 nothing persisted yet — this is the default, not a stored choice:', await p.evaluate(() => localStorage.getItem('operator.chatterPaused')), '(expect null)')
await laneReply('s-code', 't1', 'research', 'RESTMSG can you profile this')
console.log('13 delivered at rest, no toggle touched:', await sentFor('RESTMSG'), '(expect 1)')
const rawDataFor = async (needle) => p.evaluate((n) => {
  const c = window.__calls.filter((x) => x.fn === 'terminalWrite' && String(x.data ?? '').includes(n))
  return c.length ? { id: c[0].id, data: String(c[0].data) } : null
}, needle)
console.log('13 prefixed as relayed, not as its own thought:', await rawDataFor('RESTMSG').then((r) => r && unwrap(r.data).slice(0, 34)), '(expect "[Operator · message from Code] ")')
console.log('13 chip:', await chipFor('RESTMSG'), '(expect "posted · delivered")')

// ---- 14. TURN IT OFF: THE PAUSED PATH, FROM A KNOWN STATE --------------------------------
// The kill switch itself still needs coverage — flipped explicitly from the live state phase 13
// just proved, rather than assumed from wherever the driver happened to start.
await toggle().click()
await p.waitForTimeout(300)
console.log('14 label flips:', (await toggle().textContent())?.trim(), '(expect "Agent↔agent paused")')
console.log('14 aria-pressed:', await toggle().getAttribute('aria-pressed'), '(expect false)')
console.log('14 persisted:', await p.evaluate(() => localStorage.getItem('operator.chatterPaused')), '(expect "1")')
await laneReply('s-code', 't1', 'research', 'PAUSEDMSG can you profile this')
console.log('14 NOT typed into the addressee:', await sentFor('PAUSEDMSG'), '(expect 0)')
console.log('14 …and the channel says why:', await chipFor('PAUSEDMSG'), '(expect "posted · agent↔agent paused")')

// ---- 15. HUMAN → LANE STILL WORKS WHILE PAUSED --------------------------------------------
// The switch halts agent→agent ONLY. If it also silenced the person, it would be a mute button.
// Real, not drift: sendChannelMessage (DashboardView.tsx) never reads chatterPaused at all — it's
// a wholly separate path from the agent-reply subscription that evaluateDelivery gates. Confirmed
// by reading both call sites, not just by this assertion passing.
await pickTarget('code')
await p.locator('[data-channel-composer]').fill('WHILEPAUSED you there?')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(800)
console.log('15 human→lane unaffected by the kill switch:', await sentFor('WHILEPAUSED'), '(expect 1)')
await confirmWrite('t1')

// ---- 16. TURN IT BACK ON, FROM A KNOWN STATE ----------------------------------------------
// Also what re-establishes LIVE for the brake coverage below — the hop/pair/length tests need
// delivery ON, same as they do for real once c0c392c's default is what a fresh lane sees.
await toggle().click()
await p.waitForTimeout(300)
console.log('16 label flips back:', (await toggle().textContent())?.trim(), '(expect "Agent↔agent live")')
console.log('16 persisted:', await p.evaluate(() => localStorage.getItem('operator.chatterPaused')), '(expect "0")')
await laneReply('s-code', 't1', 'research', 'LIVEMSG the contract changed')
console.log('16 delivered exactly once:', await sentFor('LIVEMSG'), '(expect 1)')
const liveMsgWrite = await rawDataFor('LIVEMSG')
console.log('16 prefixed as relayed, not as its own thought:', liveMsgWrite && unwrap(liveMsgWrite.data).slice(0, 34), '(expect "[Operator · message from Code] ")')
console.log('16 to the RIGHT lane:', liveMsgWrite?.id ?? null, '(expect t2 = Research)')
console.log('16 chip:', await chipFor('LIVEMSG'), '(expect "posted · delivered")')

// ---- 17. NEVER DELIVERS TO A LANE THAT ISN'T RUNNING ---------------------------------------
const spawnsBefore3 = await spawns()
await laneReply('s-code', 't1', 'design', 'IDLETARGET here is the spec')
console.log('17 nothing written:', await sentFor('IDLETARGET'), '(expect 0)')
console.log('17 nothing spawned:', (await spawns()) === spawnsBefore3, `(spawns ${spawnsBefore3} → ${await spawns()})`)
console.log('17 chip:', await chipFor('IDLETARGET'), '(expect "posted · queued · behind current task")')

// ---- 18. THE HOP BUDGET — a ping-pong terminates -------------------------------------------
// Two lanes each answering the other, which is what two cooperative agents DO. If this section
// can run forever, the feature is unshippable; the loop below is bounded at 12 so a regression
// fails the driver instead of hanging it.
// Code ↔ Operator, deliberately NOT Code ↔ Research: phases 13 and 16 already put two real
// deliveries through that pair (RESTMSG, LIVEMSG) to prove the rest state and the re-enable, and
// the pair brake (group 19) counts every delivery in the last 60s regardless of which test sent
// it. Sharing a pair with this loop would trip THAT brake a hop early and call it a hop-limit
// failure — a false negative from cross-phase pollution, not the budget being wrong.
await pickTarget('operator')
await p.locator('[data-channel-composer]').fill('RESETCHAIN starting fresh')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(800)
await confirmWrite('t0')
const hopTexts = []
for (let i = 1; i <= 12; i++) {
  const text = `PINGPONG${i} and another thing`
  hopTexts.push(text)
  const [s, t, to] = i % 2 === 1 ? ['s-code', 't1', 'operator'] : ['s-op', 't0', 'code']
  await laneReply(s, t, to, text)
  const chip = await chipFor(text)
  if (chip && !chip.includes('delivered')) { console.log(`18 chain STOPPED at hop ${i}: ${chip}`); break }
}
const hopDelivered = []
for (const t of hopTexts) if (await sentFor(t)) hopDelivered.push(t)
console.log('18 deliveries before the brake:', hopDelivered.length, '(expect 5 — hop 6 is the limit)')
console.log('18 the LAST one was refused, not delivered:', await sentFor(hopTexts[hopTexts.length - 1]), '(expect 0)')

// ---- 19. THE PAIR BRAKE — same ordered pair, too fast --------------------------------------
// A distinct pair (Research → Operator), and reset first so the HOP budget can't be what stops it.
await pickTarget('research')
await p.locator('[data-channel-composer]').fill('RESETPAIR go ahead')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(800)
await confirmWrite('t2')
const pairTexts = []
for (let i = 1; i <= 6; i++) {
  const text = `BURST${i} status?`
  pairTexts.push(text)
  await laneReply('s-res', 't2', 'operator', text)
  const chip = await chipFor(text)
  if (chip && !chip.includes('delivered')) { console.log(`19 pair SUSPENDED on message ${i}: ${chip}`); break }
}
let pairDelivered = 0
for (const t of pairTexts) if (await sentFor(t)) pairDelivered++
console.log('19 deliveries before suspension:', pairDelivered, '(expect 4 in the 60s window)')
// …and it is PER PAIR: an unrelated pair still gets through while that one is suspended.
await laneReply('s-op', 't0', 'code', 'OTHERPAIR unaffected')
console.log('19 a different pair still delivers:', await sentFor('OTHERPAIR'), '(expect 1)')

// ---- 20. THE LENGTH CAP — trimmed, never sent whole -----------------------------------------
await laneReply('s-op', 't0', 'code', 'LONGMSG ' + 'y'.repeat(3000))
const longRaw = await rawDataFor('LONGMSG')
const longWrite = longRaw && { len: unwrap(longRaw.data).length, tail: unwrap(longRaw.data).slice(-70) }
// 2000 (DELIVER_MAX_CHARS, agent-delivery.ts) + 35 (deliveryPrefix('Operator').length) = 2035.
console.log('20 a 3008-char reply was TRIMMED:', JSON.stringify(longWrite), '(expect len 2035 — the 2000-char content cap + the 35-char relay prefix — and a "truncated" pointer)')

// ---- 21. Turning it back off halts delivery again --------------------------------------------
await toggle().click()
await p.waitForTimeout(300)
await laneReply('s-op', 't0', 'code', 'AFTEROFF one more')
console.log('21 paused again:', (await toggle().textContent())?.trim(), '· delivered:', await sentFor('AFTEROFF'), '(expect 0)')

await p.screenshot({ path: '/tmp/operator-shots/project-channel-agent-delivery.png' })
await b.close()
