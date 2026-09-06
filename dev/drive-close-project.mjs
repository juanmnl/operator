// Drive CLOSE PROJECT (dev/briefs/close-a-project.md).
//
// Two things had to be true and weren't: there was no project-wide close at all (you clicked ■ on
// every lane by hand, then Shelve, in that order), and Shelve claimed "It moves to Previous" even
// when a live lane pinned the project to Active — a success toast for a change that didn't happen.
//
// Acceptance is DURABLE STATE, not the toast: the sessions must actually be gone and `archivedAt`
// actually written, in that order, and only for this project.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

const store = () => p.evaluate(() => ({
  projects: JSON.parse(localStorage.getItem('operator.projects') || '[]')
    .map((x) => `${x.name}${x.archivedAt ? ':SHELVED' : ':active'}`),
  saved: JSON.parse(localStorage.getItem('operator.savedSessions') || '[]').map((s) => s.projectName),
  kills: window.__calls.filter((c) => c.fn === 'terminalKill').map((c) => c.args?.[0]),
}))
// REWRITTEN AGAINST THE RAIL. It used to drive the gallery card's `⋯`, which is the one surface
// that already had the verb; the rail — where you actually are when you decide to close a project
// — had no control at all and only a right-click. Driving the rail is the only way this covers the
// affordance that was missing.
const railRow = (name) => p.locator('[data-rail-project-header]').filter({ hasText: name }).first()

const openMenu = async (name) => {
  const row = railRow(name)
  await row.hover()
  await p.waitForTimeout(250)
  // THE TRIGGER IS REVEALED BY HOVER and takes no layout space at rest, so it is `display: none`
  // until the row is hovered — a click without the hover finds nothing, which is the assertion
  // below rather than a flake.
  const trigger = p.locator('[data-rail-project-menu]').first()
  await trigger.click()
  await p.waitForTimeout(500)
  return p.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], button'))
    .map((e) => e.textContent?.trim()).filter((t) => t && /Close project|Archive project|Forget project|Restore to active/.test(t)))
}

// ---- 0. The affordance itself: hidden at rest, revealed on hover, and it opens the menu ------
const atRest = await p.locator('[data-rail-project-menu]').first().isVisible().catch(() => false)
console.log('0 ⋯ takes no space at rest        :', !atRest)
await railRow('operator').hover(); await p.waitForTimeout(250)
console.log('0 …and is revealed on row hover   :', await p.locator('[data-rail-project-menu]').first().isVisible())
console.log('0 carries the dismissal hooks     :', await p.evaluate(() => {
  const t = document.querySelector('[data-rail-project-menu]')
  return !!t?.getAttribute('data-popmenu-trigger') && t?.getAttribute('aria-expanded') === 'false'
}))

// ---- 1. The menu offers CLOSE only where there is something to close --------------------
const busy = await openMenu('operator')     // 3 live lanes in the fixture
console.log('1 menu for a BUSY project :', JSON.stringify(busy))
await p.keyboard.press('Escape'); await p.waitForTimeout(300)
const quiet = await openMenu('uwazi_app')   // nothing live
console.log('1 menu for a QUIET project:', JSON.stringify(quiet))
console.log('1 Close appears only when lanes are live:',
  busy.some((t) => /^Close project/.test(t)) && !quiet.some((t) => /^Close project/.test(t)))
console.log('1 Close and Forget are separate items, Forget last:',
  busy[busy.length - 1] === 'Forget project')
await p.keyboard.press('Escape'); await p.waitForTimeout(300)

// ---- 2. Plain SHELVE on a busy project no longer claims a move --------------------------
await openMenu('operator')
await p.locator('button', { hasText: 'Archive project' }).first().click()
await p.waitForTimeout(900)
const shelveToast = await p.locator('text=/still have agents running|stays on Active|It moves to Previous/').first()
  .textContent().catch(() => null)
console.log('\n2 shelve toast on a busy project:', JSON.stringify(shelveToast))
console.log('2 does NOT claim it moved:', !/moves to Previous/.test(shelveToast || ''))
const afterShelve = await store()
console.log('2 …and indeed it is still drawn on Active:',
  (await p.locator('[data-project-card]').filter({ hasText: 'operator' }).count()) > 0)
console.log('2 sessions untouched by a plain shelve:', JSON.stringify(afterShelve.saved))
await p.screenshot({ path: '/tmp/operator-shots/close-shelve-honest.png' })

// ---- 3. CLOSE: sessions end FIRST, then the flag ----------------------------------------
const before = await store()
console.log('\n3 before — projects:', JSON.stringify(before.projects))
console.log('3 before — saved sessions:', JSON.stringify(before.saved))
await openMenu('operator')
// THE CONFIRM IS KEYED ON ACTION IDENTITY, not the label — the label counts live agents, so an
// agent exiting between the two clicks used to re-arm instead of firing. Two clicks, one action.
await p.locator('button', { hasText: /^Close project/ }).first().click()
await p.waitForTimeout(250)
const armed = await p.locator('button', { hasText: /click again/ }).count()
console.log('3 first click ARMS the confirm  :', armed === 1)
await p.locator('button', { hasText: /^Close project/ }).first().click()
// The chip must be on screen BEFORE the ptys die — that is the whole point of it.
await p.waitForTimeout(250)
console.log('3 rail says "closing…" immediately:',
  (await p.locator('[data-rail-closing]').count()) > 0)
await p.waitForTimeout(2500)
const after = await store()
console.log('3 after  — projects:', JSON.stringify(after.projects))
console.log('3 after  — saved sessions:', JSON.stringify(after.saved))
console.log('3 ptys killed by id (never a sweep):', JSON.stringify(after.kills))
const toast = await p.locator('text=/Closed .* agents? ended|Closed /').first().textContent().catch(() => null)
console.log('3 toast:', JSON.stringify(toast))
console.log('3 archivedAt IS written        :', after.projects.some((x) => x.startsWith('operator:SHELVED')))
console.log('3 this project\'s sessions gone :', !after.saved.includes('operator'))
console.log('3 OTHER projects untouched     :', after.saved.includes('el-encanto'))
await p.screenshot({ path: '/tmp/operator-shots/close-project-done.png' })

// ---- 4. …and it really appears under Previous now ---------------------------------------
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(900)
const shelves = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
console.log('\n4 gallery mentions a Previous shelf:', /previous · \d+/i.test(shelves))
console.log('4 …containing the closed project:', await p.evaluate(async () => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => /^previous · /i.test(b.textContent?.trim() || ''))
  btn?.click()
  await new Promise((r) => setTimeout(r, 600))
  return document.body.innerText.replace(/\s+/g, ' ').includes('operator')
}))
console.log('4 and it is NOT on the Active grid:', await p.evaluate(() =>
  !Array.from(document.querySelectorAll('[data-project-card]')).some((c) => /operator/.test(c.textContent || ''))))
await p.screenshot({ path: '/tmp/operator-shots/close-project-previous.png' })
await b.close()
