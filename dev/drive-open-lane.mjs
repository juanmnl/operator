// "Open lane →" on a Waiting card must always go somewhere.
//
// The button appears on a dispatch that is sitting unread in a lane's composer. Its handler
// resolved the lane's live terminal and focused it — and stopped there, with no else. So on a
// lane that is NOT running it silently did nothing, which is the exact state the card is about:
// `never started` is printed two lines above the button. A lane that isn't running has no
// terminal to focus, so it now falls through to the roster, where such a lane is launched.
//
// Run: `npx vite --port 1440` then `node dev/drive-open-lane.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(700)

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const where = () => p.evaluate(() => {
  const header = document.querySelector('[data-toolbar-header="project"]')
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden'
  document.body.appendChild(probe)
  probe.style.color = 'var(--accent)'
  const accent = getComputedStyle(probe).color
  document.body.removeChild(probe)
  const tabs = header ? Array.from(header.querySelectorAll('button'))
    .filter((btn) => ['Board', 'Team', 'Moodboard'].includes(btn.textContent?.trim() || ''))
    .map((btn) => ({ label: btn.textContent.trim(), on: getComputedStyle(btn).color })) : []
  return {
    projectHome: !!header,
    tab: tabs.find((t) => t.on === accent)?.label ?? null,
    session: !!document.querySelector('[data-toolbar-header="session"]'),
  }
})

await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(1000)
ok('the board is showing', (await where()).tab === 'Board', await where())

// The fixture: a dispatch stranded in a lane that never started.
const card = p.locator('[data-waiting-card]')
ok('the stranded dispatch renders a Waiting card', (await card.count()) > 0, { cards: await card.count() })
ok('and it says the work never started',
  /never started|Sitting in the lane/.test((await card.first().innerText().catch(() => '')) || ''))

// The lane it targets must genuinely NOT be live, or this drives the case that already worked.
const btn = p.locator('[data-open-lane]')
const target = await btn.first().getAttribute('data-open-lane')
const live = await p.evaluate((id) => !!document.querySelector(`[data-role-card="${id}"]`), target)
ok(`the target lane (${target}) is not running`, !live, { target, live })

ok('the card offers Open lane', (await btn.count()) > 0)
await btn.first().click()
await p.waitForTimeout(1000)
const after = await where()
ok('Open lane on a NON-running lane lands on the roster', after.projectHome && after.tab === 'Team', after)
ok('and the roster is really rendered', (await p.locator('[data-roster-row], [data-role-card]').count()) > 0)
await p.screenshot({ path: '/tmp/operator-shots/open-lane-idle.png' })

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nOpen lane always goes somewhere')
process.exit(failed ? 1 : 0)
