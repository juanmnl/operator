// Assert the settings-page TEMPLATE mechanically (dev/settings-page-template.md §7).
// Contrast is checked per-palette by drive-theme-pass.mjs; this checks the thing contrast
// can't see — that every page wears the SAME tokens rather than merely similar-looking ones.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-settings-template.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
// Scope persists, so a previous run leaves the app booting inside a project.
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(600)
await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)

const PAGES = [
  ['PrefsView', 'Operator preferences', 'form'],
  ['FolderPreferencesView (project)', 'operator Claude files (.claude)', 'form'],
  ['FolderPreferencesView (global)', 'Global Claude files (~/.claude)', 'form'],
  ['AgentsHubView', 'Agents — every agent across your projects', 'grid'],
]

const snap = () => p.evaluate(() => {
  const css = (el, props) => {
    if (!el) return null
    const s = getComputedStyle(el)
    return Object.fromEntries(props.map((k) => [k, s[k]]))
  }
  const TYPE = ['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing']
  const title = document.querySelector('[data-page-title]')
  const sub = document.querySelector('[data-page-subtitle]')
  const heads = Array.from(document.querySelectorAll('[data-section-header]'))
  const descs = Array.from(document.querySelectorAll('[data-section-desc]'))
  // Header block vs the scrolling content's measure box — they must share a left edge.
  const headerLeft = title ? Math.round(title.getBoundingClientRect().left) : null
  const firstContent = heads[0] || descs[0] || document.querySelector('[data-page-tab]')
  const contentLeft = firstContent ? Math.round(firstContent.getBoundingClientRect().left) : null
  // No TEXT may stack a numeric opacity on top of --fg-muted. Scoped to the page (the
  // sidebar is not under test) and to elements that set `color: var(--fg-muted)` and own
  // their text: an earlier version matched StatusWave's SVG <circle>s, which legitimately
  // animate opacity and set FILL, not colour — 90% of the output was orbs twinkling.
  const page = document.querySelector('[data-page-title]')?.closest('div[style*="flex"]')?.parentElement
    || document.body
  const offenders = []
  for (const el of Array.from(page.querySelectorAll('*'))) {
    if (el.closest('[data-sidebar]')) continue
    const inline = el.getAttribute('style') || ''
    if (!/color:\s*var\(--fg-muted\)/.test(inline)) continue
    const o = parseFloat(getComputedStyle(el).opacity)
    if (!(o < 1 && o > 0)) continue
    // Own text only — a wrapper inherits its children's text via textContent.
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
    if (!own) continue
    offenders.push(`${el.tagName.toLowerCase()}"${own.slice(0, 30)}" @${o}`)
  }
  return {
    title: css(title, TYPE),
    subtitle: css(sub, TYPE),
    headers: heads.map((h) => css(h, TYPE)),
    descs: descs.map((d) => css(d, TYPE)),
    headerLeft, contentLeft,
    tabs: Array.from(document.querySelectorAll('[data-page-tab]')).map((t) => t.getAttribute('data-page-tab')),
    offenders,
  }
})

const seen = []
for (const [name, title, measure] of PAGES) {
  await p.locator(`button[title="${title}"]`).click()
  await p.waitForTimeout(800)
  const s = await snap()
  seen.push({ name, measure, ...s })
}

const j = (o) => JSON.stringify(o)
const first = seen[0]

console.log('\n— PAGE TITLE: identical across every page —')
for (const s of seen) {
  const same = j(s.title) === j(first.title)
  console.log(`  ${same ? '✓' : '✗'} ${s.name}  ${j(s.title)}`)
}

console.log('\n— PAGE SUBTITLE —')
for (const s of seen) {
  console.log(`  ${s.subtitle ? (j(s.subtitle) === j(first.subtitle) ? '✓' : '✗') : '—'} ${s.name}  ${s.subtitle ? j(s.subtitle) : 'ABSENT'}`)
}

console.log('\n— SECTION HEADERS: identical within and across flat pages —')
const allHeads = seen.flatMap((s) => s.headers)
console.log(`  ${new Set(allHeads.map(j)).size <= 1 ? '✓' : '✗'} ${allHeads.length} header(s), ${new Set(allHeads.map(j)).size} distinct style(s)`)
if (allHeads[0]) console.log(`    ${j(allHeads[0])}`)
const allDescs = seen.flatMap((s) => s.descs)
console.log(`  ${new Set(allDescs.map(j)).size <= 1 ? '✓' : '✗'} ${allDescs.length} desc(s), ${new Set(allDescs.map(j)).size} distinct style(s)`)

console.log('\n— TABBED vs FLAT (§4: tab name IS the section header) —')
for (const s of seen) {
  const tabbed = s.tabs.length > 0
  const ok = !tabbed || s.headers.length === 0
  console.log(`  ${ok ? '✓' : '✗'} ${s.name}: ${tabbed ? `tabbed [${s.tabs}]` : 'flat'}, ${s.headers.length} section header(s)`)
}

console.log('\n— HEADER / CONTENT SHARE A LEFT EDGE —')
for (const s of seen) {
  const d = s.headerLeft !== null && s.contentLeft !== null ? s.contentLeft - s.headerLeft : null
  console.log(`  ${d === 0 ? '✓' : '✗'} ${s.name} (${s.measure}): header ${s.headerLeft} / content ${s.contentLeft} → Δ${d}px`)
}

console.log('\n— NO opacity STACKED ON --fg-muted —')
for (const s of seen) {
  console.log(`  ${s.offenders.length === 0 ? '✓' : '✗'} ${s.name}: ${s.offenders.length ? s.offenders.join(', ') : 'clean'}`)
}

await b.close()
