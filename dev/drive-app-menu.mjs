// Collapsing the sidebar — or opening the gallery — used to strand the app's own settings.
//
// The expanded Sidebar's footer carried preferences, global Claude files, the theme toggle and
// the ONLY button that installs an update. That strip is not drawn in two states: collapsed to
// the 64px SidebarRail, and at the gallery, where it animates to width 0 FOR EVERYONE — which
// made the launcher and first-launch screen the one place with no way to reach any of it.
//
// Those verbs now live under a gear at the ProjectRail's foot, which is the only strip present in
// every state, with a pip when an update is waiting.
//
// What this asserts is ACCESS IN EVERY STATE, plus the two things access alone would not catch:
// the update must be VISIBLE (pip) where it exists rather than merely reachable, and the verbs
// must not exist TWICE once the sidebar is expanded again.
//
// Run: `npx vite --port 1438` then `node dev/drive-app-menu.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1438
// All SIX palettes — the app names four themes, but each has a dark and a light face and the
// three light ones are where a receded control has historically dropped out of sight.
const THEMES = [
  ['mission-control-dark', 'dark'],
  ['mission-control-light', 'light'],
  ['mr-pink-dark', 'dark'],
  ['mr-pink-light', 'light'],
  ['1984-dark', 'dark'],
  ['1984-light', 'light'],
]

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

// Boot a page in a given theme, with or without a pending update. The update flag goes into
// localStorage BEFORE load, because the bridge's checkUpdate reads it on the launch check.
const boot = async (b, { theme, colorScheme, update }) => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme })
  await ctx.addInitScript(([t, u]) => {
    try {
      localStorage.setItem('operator.theme', t)
      if (u) localStorage.setItem('mock.update', u); else localStorage.removeItem('mock.update')
      localStorage.removeItem('operator.activeProjectId')
    } catch { /* quota */ }
  }, [theme, update ?? ''])
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(2600)
  return p
}

// Is the gear present, and does it have a pip? Read from the real DOM, not from any test state.
const gear = (p) => p.evaluate(() => {
  const btn = document.querySelector('[data-rail-app]')
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  const pip = btn.querySelector('[data-rail-app-pip]')
  const pr = pip?.getBoundingClientRect()
  return {
    present: true,
    label: btn.getAttribute('aria-label'),
    box: { w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2) },
    pip: !!pip,
    // The pip must not widen the button's painted bounds — the rail is a vertical strip and an
    // item that sits off the shared centre line reads as broken. Same invariant as the tile pip.
    pipInside: pr ? (pr.right <= r.right + 0.5 && pr.bottom <= r.bottom + 0.5) : null,
    svgViewBox: btn.querySelector('svg')?.getAttribute('viewBox'),
  }
})

// The menu's items, once opened. Keyed on role="menuitem", which is what CardMenu's rows ARE —
// a looser "fixed panel containing 'Operator'" also matches the UPDATE TOAST, whose body reads
// "Install and restart Operator." That is precisely the pending-update case this has to measure,
// so the loose selector failed on the one run that mattered.
const menu = (p) => p.evaluate(() => {
  const item = document.querySelector('[role="menuitem"]')
  const panel = item?.closest('div[style*="fixed"]') || item?.parentElement?.closest('div')
  if (!panel) return null
  return {
    title: panel.textContent.match(/Operator v[\d.a-z-]+/)?.[0] ?? null,
    items: Array.from(panel.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent.trim()).filter(Boolean),
  }
})

const b = await webkit.launch()

// ---- 1. ACCESS in all three states -------------------------------------------------------
// gallery · expanded-in-project · collapsed-in-project. The first is the state the original
// report did not mention and the one that was broken for everybody.
{
  const p = await boot(b, { theme: 'mission-control-dark', colorScheme: 'dark' })
  await p.keyboard.press('Meta+Shift+O') // to the gallery
  await p.waitForTimeout(700)
  ok('GALLERY: the gear exists', (await gear(p))?.present === true, await gear(p))

  await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
  await p.waitForTimeout(900)
  ok('EXPANDED in a project: the gear exists', (await gear(p))?.present === true)

  await p.locator('button[aria-label="Hide sidebar"]').first().click()
  await p.waitForTimeout(800)
  ok('COLLAPSED: the gear exists', (await gear(p))?.present === true)

  // ---- 2. it opens, and carries the verbs that were stranded ----------------------------
  await p.locator('[data-rail-app]').click()
  await p.waitForTimeout(400)
  const m = await menu(p)
  const has = (re) => !!m?.items.some((i) => re.test(i))
  ok('the menu opens with the app verbs', has(/preferences/i) && has(/Global Claude files/i) && has(/light mode|dark mode/i), m)
  ok('and it names the VERSION, which also only existed in the footer', /^Operator v/.test(m?.title || ''), m?.title)

  // ---- 3. the theme toggle actually works from here --------------------------------------
  // The menu is still open from step 2, and clicking the gear again would only DISMISS it
  // (useDismiss fires on outside pointer-down first) — so the toggle is clicked in place.
  const before = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
  // CardMenu items are role="menuitem", not role="button" — locate them as what they are.
  await p.getByRole('menuitem', { name: /Switch to (light|dark) mode/ }).first().click()
  await p.waitForTimeout(600)
  const after = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ok('theme toggles from the collapsed state', before !== after, { before, after })

  await p.context().close()
}

// ---- 4. NO DUPLICATION once the sidebar is expanded --------------------------------------
// The point of moving rather than copying. Two gears a hairline apart is the thing the corner
// has twice been cleaned up to avoid.
{
  const p = await boot(b, { theme: 'mission-control-dark', colorScheme: 'dark' })
  await p.keyboard.press('Meta+Shift+O') // the harness boots INSIDE a project
  await p.waitForTimeout(700)
  await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
  await p.waitForTimeout(900)
  const dupes = await p.evaluate(() => {
    const names = Array.from(document.querySelectorAll('button'))
      .map((b) => b.getAttribute('aria-label') || '')
    return {
      prefs: names.filter((n) => /^Operator preferences$/.test(n)).length,
      globals: names.filter((n) => /Global Claude files/.test(n)).length,
      theme: names.filter((n) => /^Switch to (light|dark) mode$/.test(n)).length,
      settings: names.filter((n) => /^Settings$/.test(n)).length,
    }
  })
  ok('expanded: the app verbs exist ONCE (behind the gear), not twice',
    dupes.prefs === 0 && dupes.globals === 0 && dupes.theme === 0 && dupes.settings === 1, dupes)

  // The project-scoped control STAYS in the sidebar — the split is scope, not tidiness.
  const projectPrefs = await p.evaluate(() =>
    Array.from(document.querySelectorAll('[data-sidebar-foot-btn]')).map((b) => b.getAttribute('aria-label')))
  ok('the PROJECT-scoped Claude files control stays in the sidebar',
    projectPrefs.some((n) => /Claude files/.test(n || '')), projectPrefs)
  await p.context().close()
}

// ---- 5. the UPDATE is visible where it exists, in every state ------------------------------
{
  const p = await boot(b, { theme: 'mission-control-dark', colorScheme: 'dark', update: '0.13.2' })
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(900)
  const g1 = await gear(p)
  ok('GALLERY with an update pending: the gear wears a pip', g1?.pip === true, g1)
  ok('and the pip stays inside the button box (cannot move the strip centre)', g1?.pipInside === true, g1)

  await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
  await p.waitForTimeout(800)
  await p.locator('button[aria-label="Hide sidebar"]').first().click()
  await p.waitForTimeout(800)
  ok('COLLAPSED with an update pending: still pipped', (await gear(p))?.pip === true)

  await p.locator('[data-rail-app]').click()
  await p.waitForTimeout(400)
  const m = await menu(p)
  ok('the menu LEADS with Install', /Install update 0\.13\.2/.test(m?.items?.[0] || ''), m)
  await p.context().close()
}

// ---- 6. no pip when there is no update ----------------------------------------------------
{
  const p = await boot(b, { theme: 'mission-control-dark', colorScheme: 'dark' })
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(900)
  const g = await gear(p)
  ok('no update → no pip (an always-on dot is noise)', g?.pip === false, g)
  const m0 = await p.locator('[data-rail-app]').click().then(() => p.waitForTimeout(400)).then(() => menu(p))
  ok('and no Install item', !m0?.items.some((i) => /Install/.test(i)), m0)
  await p.context().close()
}

// ---- 7. all four themes: the gear is drawn and legible ------------------------------------
// Contrast against its own backdrop, since --fg-muted IS the recede and must not be stacked on.
for (const [theme, colorScheme] of THEMES) {
  const p = await boot(b, { theme, colorScheme, update: '0.13.2' })
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(900)
  const shot = await p.evaluate(() => {
    const btn = document.querySelector('[data-rail-app]')
    if (!btn) return null
    const lum = (c) => {
      const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ink = getComputedStyle(btn).color
    // The rail's own field is the backdrop (the button is transparent at rest).
    const bg = getComputedStyle(btn.closest('div[style*="width"]') || document.body).backgroundColor
    const back = /rgba\(0, 0, 0, 0\)/.test(bg) ? getComputedStyle(document.body).backgroundColor : bg
    const [l1, l2] = [lum(ink), lum(back)].sort((a, b) => b - a)
    const pipEl = btn.querySelector('[data-rail-app-pip]')
    return {
      ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100,
      opacity: getComputedStyle(btn).opacity,
      pipBg: pipEl ? getComputedStyle(pipEl).backgroundColor : null,
    }
  })
  ok(`${theme}: gear legible (≥3:1) and not opacity-stacked`,
    shot && shot.ratio >= 3 && shot.opacity === '1', { theme, ...shot })
  ok(`${theme}: the pip paints an accent, not a transparent`,
    !!shot?.pipBg && !/rgba\(0, 0, 0, 0\)/.test(shot.pipBg), shot?.pipBg)
  await p.context().close()
}

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
