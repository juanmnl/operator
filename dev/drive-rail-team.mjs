// Two fixes in the collapsed rail's navigation, driven against the real UI.
//
// 1. The rail's foot control was a SECOND "new session": same handler as the project rail's
//    `+` a few pixels away, same ⌘N, same `+` glyph, differing only in its tooltip. It now
//    opens this project's roster (Project Home → Team) and wears a roster glyph, because the
//    rail it sits in lists agents.
// 2. Clicking the tile of the project you are already in did NOTHING once you had navigated
//    into an agent — `handleOpenProject` no-ops on a re-select, and the rail tile had no other
//    way home. It now goes home from anywhere that isn't already home.
//
// Run: `npx vite --port 1440` then `node dev/drive-rail-team.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
// The harness boots INSIDE a project; ⌘⇧O is the one path back to the gallery.
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(700)

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

// Which surface is showing, and if it's Project Home, which tab is selected. Read from the
// real toolbar rather than from any test-only state, so this can't pass on a lie.
const where = () => p.evaluate(() => {
  const header = document.querySelector('[data-toolbar-header="project"]')
  // ProjectView colours the selected tab `var(--accent)` and the rest `var(--fg-muted)`.
  // Both reach the DOM as computed rgb(), while the custom property may be a hex or a
  // color-mix() — so resolve the token through a probe element and compare LIKE WITH LIKE.
  // (Comparing the raw var text against a computed colour is why this read null for every
  // tab, including the Board that was plainly selected.)
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden'
  document.body.appendChild(probe)
  const resolve = (v) => { probe.style.color = v; return getComputedStyle(probe).color }
  const accent = resolve('var(--accent)')
  document.body.removeChild(probe)
  const tabs = header ? Array.from(header.querySelectorAll('button'))
    .filter((btn) => ['Board', 'Team', 'Moodboard'].includes(btn.textContent?.trim() || ''))
    .map((btn) => ({ label: btn.textContent.trim(), on: getComputedStyle(btn).color })) : []
  return {
    projectHome: !!header,
    tab: tabs.find((t) => t.on === accent)?.label ?? null,
    tabsSeen: tabs.length,
    session: !!document.querySelector('[data-toolbar-header="session"]'),
  }
})

// Enter the project, collapse the sidebar so the rail (and its foot control) is on screen.
await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)
ok('entering a project lands on Project Home', (await where()).projectHome, await where())

// The collapsed rail is what carries the control under test.
await p.locator('button[aria-label="Hide sidebar"]').first().click()
await p.waitForTimeout(800)
const teamBtn = p.locator('[data-rail-team]')
ok('the rail has a Team control', (await teamBtn.count()) === 1)

// --- 1. the glyph is no longer a plus -------------------------------------------------
// A `+` is exactly two straight lines and no circles; the roster mark is two circles and
// two lines. Asserting on the SHAPE, not on a label, is what catches a silent revert.
const glyph = await p.evaluate(() => {
  const svg = document.querySelector('[data-rail-team] svg')
  if (!svg) return null
  return {
    circles: svg.querySelectorAll('circle').length,
    lines: svg.querySelectorAll('line').length,
    label: document.querySelector('[data-rail-team]')?.getAttribute('aria-label'),
    title: document.querySelector('[data-rail-team]')?.getAttribute('title'),
  }
})
ok('the control is a ROSTER glyph, not a plus', glyph?.circles === 2 && glyph?.lines === 2, glyph)
ok('and it is named for where it goes', glyph?.label === 'Team' && !/New session|⌘N/.test(glyph?.title || ''), glyph)

// The duplication being removed: two adjacent controls both firing the new-session flow on
// ⌘N. Exactly one may claim that chord now — the project rail's "Open folder", whose label
// is deliberately kept. Counting the CHORD, not a label, is what makes this a duplication
// check rather than a spelling check.
const chord = await p.evaluate(() =>
  Array.from(document.querySelectorAll('button'))
    .map((btn) => btn.getAttribute('title') || '')
    .filter((t) => /⌘N(?!\w)/.test(t)))
ok('exactly one control still offers ⌘N / new session', chord.length === 1, { chord })

// --- 2. the Team control actually opens the roster ------------------------------------
await teamBtn.click()
await p.waitForTimeout(900)
const afterTeam = await where()
ok('the rail control opens Project Home on the TEAM tab', afterTeam.projectHome && afterTeam.tab === 'Team', afterTeam)
ok('and the roster is really rendered', (await p.locator('[data-roster-row], [data-role-card]').count()) > 0)
await p.screenshot({ path: '/tmp/operator-shots/rail-team.png' })

// --- 3. the dead project tile -----------------------------------------------------------
// Navigate INTO an agent, then click the tile of the project you are already in.
await p.locator('[data-rail-session]').first().click()
await p.waitForTimeout(1200)
const inAgent = await where()
ok('we are inside an agent (not on Project Home)', inAgent.session && !inAgent.projectHome, inAgent)

const tile = p.locator('[data-rail-tile]').first()
const tileCount = await tile.count()
ok('the project rail shows its tile', tileCount > 0, { tileCount })
await tile.click()
await p.waitForTimeout(1000)
const afterTile = await where()
ok('clicking the CURRENT project\'s tile from inside an agent goes home', afterTile.projectHome, afterTile)
await p.screenshot({ path: '/tmp/operator-shots/rail-tile-home.png' })

// Already home → still a no-op, i.e. the "don't yank me" rule survives where it applies.
await tile.click()
await p.waitForTimeout(700)
ok('clicking it again while already home stays put', (await where()).projectHome, await where())

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nrail navigation verified')
process.exit(failed ? 1 : 0)
