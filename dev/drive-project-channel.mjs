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
      v.projectReplies = async () => ([
        { sessionId: 's-code', to: 'operator', text: 'REPLY between first and second', timestamp: '2026-07-29T09:02:00.000Z' },
        { sessionId: 's-res', to: 'project', text: 'REPLY broadcast to the room', timestamp: '2026-07-30T09:12:00.000Z' },
        { sessionId: 's-vanished', to: 'operator', text: 'REPLY from a session that is gone', timestamp: '2026-07-30T09:30:00.000Z' },
      ])
    },
  })
})

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
const writes = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite').length)

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
    pills: Array.from(document.querySelectorAll('[data-channel-pill]')).map((e) => e.textContent.trim()),
  }
})
console.log('6 composer:', JSON.stringify(composer, null, 0), '(expect enabled, with target pills)')

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
await p.locator('[data-channel-pill="Code"]').click()
await p.locator('[data-channel-composer]').fill('HUMANTOCODE take a look at this')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(900)
console.log('9 delivered to the live lane:', await sentFor('HUMANTOCODE'), '(expect 1)')
console.log('9 it renders as You → Code, delivered:', JSON.stringify(await rowFor('HUMANTOCODE')))
console.log('9 composer cleared:', await p.evaluate(() => document.querySelector('[data-channel-composer]').value === ''))

// ---- 10. AN IDLE TARGET IS QUEUED, NEVER LAUNCHED --------------------------------------
const spawnsBefore = await spawns()
await p.locator('[data-channel-pill="Design"]').click()
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
await p.locator('[data-channel-pill="Code"]').click()
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
await p.locator('[data-channel-pill="everyone"]').click()
await p.locator('[data-channel-composer]').fill('HUMANTOALL standup in five')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(1100)
console.log('12 written once per LIVE lane:', await sentFor('HUMANTOALL'))
console.log('12 collapsed into a single row:', JSON.stringify(await rowFor('HUMANTOALL')))
console.log('12 …exactly ONE row for the fan-out:', await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-channel-row]'))
    .filter((r) => (r.querySelector('[data-channel-text]')?.textContent ?? '').includes('HUMANTOALL')).length), '(expect 1)')
console.log('12 idle lanes were skipped, not started:', (await spawns()) === spawnsBefore, '(expect true)')

await p.screenshot({ path: '/tmp/operator-shots/project-channel-send.png' })
await b.close()
