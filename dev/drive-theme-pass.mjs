// FOUR-THEME PASS over the project-first navigation surfaces (spec §5): the gallery
// header/cards/empty state, the scoped sidebar (live vs idle lane rows, identity header),
// and the collapsed rail badge — in every theme identity, light AND dark.
//
// Screenshots land in /tmp/operator-shots/theme-pass/. Alongside them it measures the
// contrast of the text that RECEDES most in these surfaces (muted paths, the idle lane's
// 80%-alpha name, the "idle" tag, the card footer), because a token that reads fine on the
// near-black default is exactly the kind that collapses on a light palette.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-theme-pass.mjs`.
// (Don't default the port from process.env.PORT — the app's own shell exports PORT.)
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1440
const OUT = '/tmp/operator-shots/theme-pass'
mkdirSync(OUT, { recursive: true })

const THEMES = [
  ['mission-control-dark', 'Mission Control (dark)'],
  ['mission-control-light', 'Mission Control (light) — the "Light" theme'],
  ['mr-pink-dark', 'Mr Pink (dark)'],
  ['mr-pink-light', 'Mr Pink (light)'],
  ['1984-dark', '1984 (dark)'],
  ['1984-light', '1984 (light)'],
]

// --- contrast plumbing -------------------------------------------------------------
// Text is measured against its EFFECTIVE backdrop: walk up for the first non-transparent
// background, and fold the element's own opacity + any color-mix alpha into the sample.
const PROBE = `(() => {
  const parseRGB = (s) => {
    const str = String(s)
    // WebKit serializes color-mix(... transparent) as \`color(srgb r g b / a)\` with 0–1
    // channels, NOT rgba() — the idle lane name is exactly that, so miss this form and the
    // row that matters most silently reads as "no colour".
    const cm = str.match(/color\\(srgb ([^)]+)\\)/)
    if (cm) {
      const p = cm[1].split(/[ /]+/).filter(Boolean).map(Number)
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }
    }
    const m = str.match(/rgba?\\(([^)]+)\\)/)
    if (!m) return null
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const backdrop = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const c = parseRGB(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0.99) return c
      if (c && c.a > 0) {
        const under = backdrop(n.parentElement || document.body)
        return { r: c.r * c.a + under.r * (1 - c.a), g: c.g * c.a + under.g * (1 - c.a), b: c.b * c.a + under.b * (1 - c.a), a: 1 }
      }
      n = n.parentElement
    }
    const b = parseRGB(getComputedStyle(document.body).backgroundColor)
    return b && b.a > 0 ? b : { r: 0, g: 0, b: 0, a: 1 }
  }
  const effOpacity = (el) => { let o = 1, n = el; while (n && n !== document.documentElement) { o *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement } return o }
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
  // \`meta\` = supporting text (paths, counts, tags) held to 3:1 rather than 4.5:1. Declared
  // per probe, NOT inferred from the label — a rename shouldn't silently move the goalposts.
  window.__contrast = (sel, label, meta = false) => {
    const el = document.querySelector(sel)
    if (!el) return { label, meta, missing: true }
    const fg = parseRGB(getComputedStyle(el).color)
    if (!fg) return { label, meta, missing: true }
    const bg = backdrop(el)
    const a = fg.a * effOpacity(el)
    const c = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }
    const L1 = lum(c), L2 = lum(bg)
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    return { label, meta, ratio: Math.round(ratio * 100) / 100, size: parseFloat(getComputedStyle(el).fontSize) }
  }
})()`

// Text small enough that WCAG's large-text allowance never applies — everything here is
// ≤13px, so 4.5:1 is the bar for body and 3:1 the floor for genuinely decorative meta.
const FLOOR = 4.5
const META_FLOOR = 3.0

const rows = []
const notes = []

for (const [key, label] of THEMES) {
  // One BROWSER per palette. Closing pages and contexts is not enough — the WebKit process
  // accumulates across a sweep this size and hard-crashes mid-run (no JS error, so it looks
  // like a product bug). A fresh browser per theme costs a few seconds and makes the sweep
  // deterministic, which is the whole point of a verification gate.
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: key.endsWith('light') ? 'light' : 'dark' })
  // Age one project past the 14-day line so the TIDY bar and its review sheet exist to be
  // measured. Every project in the fixture ran minutes ago, so without this the newest
  // surfaces in the gallery would be the only ones the sweep never looks at.
  await ctx.addInitScript(() => {
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true,
      get: () => real,
      set: (v) => {
        real = v
        const origLoad = v.loadProjects
        v.loadProjects = async () => ((await origLoad()) ?? []).map((p) => {
          if (p.name === 'uwazi_app') return { ...p, lastActiveAt: new Date(Date.now() - 40 * 86400000).toISOString() }
          // The channel probes need a feed with a RESOLVED lane author — its name and avatar
          // initials are drawn in the lane accent through laneTextColor, which is the one ink
          // here that comes from user data rather than a token.
          if (p.name === 'operator') return { ...p, dispatches: [
            { id: 'tp1', at: '2026-07-30T09:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'A delivered task, for the accent-ink probe.', outcome: 'sent' },
            { id: 'tp2', at: '2026-07-30T09:10:00.000Z', fromRoleId: 'research', toRoleId: 'code', task: 'A held task, for the warn chip.', outcome: 'pending-approval' },
          ] }
          return p
        })
      },
    })
  })
  // A fresh page per theme, and a fresh one again for the virgin-app steps below: this sweep
  // now walks ~10 full app boots per theme, and WebKit's renderer OOMs and hard-crashes part
  // way through if they all share one page. The crash carries no JS error, so it reads as a
  // product bug when it is really the harness outgrowing a single page.
  const newPage = async () => {
    const pg = await ctx.newPage()
    pg.on('pageerror', (e) => notes.push(`${key} PAGEERROR ${String(e).slice(0, 200)}`))
    // The theme is read from localStorage at first render — and `?empty=1` clears the whole
    // store on boot, so re-set the key after any clear() rather than merely before load.
    // This lives INSIDE newPage: a replacement page gets no init scripts from its predecessor,
    // so the virgin-app steps were silently shooting the DEFAULT palette six times over.
    await pg.addInitScript((t) => {
      const orig = Storage.prototype.clear
      Storage.prototype.clear = function () { orig.call(this); try { localStorage.setItem('operator.theme', t) } catch { /* quota */ } }
      try { localStorage.setItem('operator.theme', t) } catch { /* quota */ }
    }, key)
    return pg
  }
  let p = await newPage()

  // ---- 1. Gallery ---------------------------------------------------------------
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(2600)
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(700)
  await p.evaluate(PROBE)
  await p.screenshot({ path: `${OUT}/${key}-1-gallery.png` })

  // Structural child selectors only — a descendant match like `span:nth-child(2)` lands
  // inside the status orb (which renders its own spans) rather than on the row's name.
  const galleryProbes = await p.evaluate(() => {
    // The card tags its own parts (data-card-*), so regrouping its rows can't silently
    // re-point a probe at the wrong element the way structural nth-child selectors did.
    const withNotes = document.querySelector('[data-card-notes]')
    if (withNotes) withNotes.setAttribute('data-probe-notes', '')
    return [
      window.__contrast('h2', 'gallery title'),
      window.__contrast('[data-card-name]', 'card name'),
      window.__contrast('[data-card-path]', 'card path', true),
      window.__contrast('[data-probe-notes]', 'card description'),
      window.__contrast('[data-card-meta]', 'card footer meta', true),
    ]
  })

  // The header title and the first card must share a left edge — the header once reserved
  // traffic-light space with paddingLeft:84 while the grid was centred, so they never did.
  const align = await p.evaluate(() => {
    const h = document.querySelector('h2')?.getBoundingClientRect()
    const c = document.querySelector('[role="button"]')?.getBoundingClientRect()
    if (!h || !c) return null
    return { title: Math.round(h.left), card: Math.round(c.left), delta: Math.round(c.left - h.left), titleTop: Math.round(h.top) }
  })
  if (align) notes.push(`${key} left edges — title ${align.title} / card ${align.card} → Δ${align.delta}px (title top y=${align.titleTop}, must clear traffic lights ≈y28)`)

  // ---- 1·rail. The persistent project rail --------------------------------------
  // The tile acronym is real TEXT drawn in the project's identity colour, so it takes the
  // body floor like anything else — and it is the one ink in the app that comes from a
  // hashed value rather than a token, i.e. nobody hand-checked it against a light palette.
  // laneTextColor is what's meant to save it; this is the check that it does.
  const railProbes = await p.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('[data-rail-tile]'))
    tiles.forEach((t, i) => t.querySelector('[data-rail-initials]')?.setAttribute(`data-probe-tile-${i}`, ''))
    return tiles.map((t, i) => window.__contrast(`[data-probe-tile-${i}]`, `rail tile acronym #${i + 1}`))
  })
  // The tints themselves, so their separability on a light field can be eyeballed against the
  // screenshot rather than guessed at.
  const railInk = await p.evaluate(() => Array.from(document.querySelectorAll('[data-rail-tile]')).map((t) => {
    const s = getComputedStyle(t)
    return `${t.getAttribute('data-rail-accent')}→${t.querySelector('[data-rail-initials]')?.textContent} bg${s.backgroundColor.replace(/\s+/g, '')}`
  }))
  if (railInk.length) notes.push(`${key} rail tiles — ${railInk.join('  ')}`)
  await p.screenshot({ path: `${OUT}/${key}-1r-project-rail.png`, clip: { x: 0, y: 0, width: 60, height: 900 } })

  // ---- 1a. The tidy bar and its review sheet ------------------------------------
  // Both are muted ink on a new backdrop (the bar on --overlay-subtle, the sheet's rows on
  // --bg-sidebar), which is precisely the combination that survives the near-black default
  // and collapses on a light palette.
  const tidyProbes = await p.evaluate(() => [
    window.__contrast('[data-tidy-bar] > span', 'tidy bar text', true),
    window.__contrast('[data-tidy-review]', 'tidy bar · Review'),
  ])
  await p.locator('[data-tidy-review]').click()
  await p.waitForTimeout(400)
  await p.evaluate(PROBE)
  const sheetProbes = await p.evaluate(() => {
    const row = document.querySelector('[data-tidy-row]')
    const spans = row ? Array.from(row.children) : []
    spans[1]?.setAttribute('data-probe-tidy-name', '')
    spans[2]?.setAttribute('data-probe-tidy-path', '')
    return [
      window.__contrast('[data-probe-tidy-name]', 'tidy row name'),
      window.__contrast('[data-probe-tidy-path]', 'tidy row path', true),
      window.__contrast('[data-tidy-count]', 'tidy footer count', true),
      window.__contrast('[data-tidy-shelve]', 'tidy shelve button'),
    ]
  })
  await p.screenshot({ path: `${OUT}/${key}-1b-tidy-review.png` })
  // Cancel by CLICK, not Escape: a missed keypress leaves the scrim up and everything after
  // this step times out on an invisible overlay — which reads as a product bug, not a flake.
  await p.locator('[data-tidy-review-sheet] button', { hasText: 'Cancel' }).click()
  await p.waitForTimeout(300)

  // Card hover — the only state change on a card, and the one that must not touch the border.
  // Scoped to [data-project-card]: the Previous rows below are role="button" too.
  const card = p.locator('[data-project-card]').first()
  await card.hover()
  await p.waitForTimeout(250)
  const hoverBorder = await p.evaluate(() => {
    const el = document.querySelector('[data-project-card]')
    const s = getComputedStyle(el)
    return { border: s.borderTopColor, bg: s.backgroundColor }
  })
  await p.screenshot({ path: `${OUT}/${key}-2-gallery-hover.png` })

  // ---- 1b. The PREVIOUS shelf ---------------------------------------------------
  // Archive one project so the section headers and their rows exist to be measured. This is
  // the surface most at risk on a light palette: a row has no card border to sit on, so its
  // 80%-of-fg name and mono meta are carrying the whole hierarchy on their own.
  await p.locator('button[aria-label="uwazi_app actions"]').first().click()
  await p.waitForTimeout(250)
  await p.getByText('Archive project', { exact: true }).first().click()
  await p.waitForTimeout(450)
  await p.locator('[data-shelf-toggle]').click()
  await p.waitForTimeout(350)
  const shelfProbes = await p.evaluate(() => [
    window.__contrast('[data-shelf-label]', 'shelf header · active', true),
    window.__contrast('[data-shelf-toggle]', 'shelf header · previous', true),
    window.__contrast('[data-previous-name]', 'previous row name'),
    window.__contrast('[data-previous-path]', 'previous row path', true),
    window.__contrast('[data-previous-ran]', 'previous row last-ran', true),
  ])
  await p.screenshot({ path: `${OUT}/${key}-2b-gallery-shelf.png` })
  // Hovering a row must change the BACKGROUND only — it is radiused, so a colour-changing
  // border would re-rasterize it (the WKWebView freeze rule).
  await p.locator('[data-previous-row]').first().hover()
  await p.waitForTimeout(250)
  const rowHover = await p.evaluate(() => {
    const s = getComputedStyle(document.querySelector('[data-previous-row]'))
    const r = getComputedStyle(document.querySelector('[data-previous-restore]'))
    return { border: s.borderTopWidth, bg: s.backgroundColor, restoreOpacity: r.opacity }
  })
  await p.screenshot({ path: `${OUT}/${key}-2c-gallery-shelf-hover.png` })
  // Put it back before moving on, so the later steps see the fixture in its normal state
  // (and so a re-run isn't measuring a store the previous pass shelved).
  await p.locator('[data-previous-restore]').first().click()
  await p.waitForTimeout(400)

  // ---- 2. Scoped sidebar --------------------------------------------------------
  await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
  await p.waitForTimeout(900)
  await p.evaluate(PROBE)
  await p.screenshot({ path: `${OUT}/${key}-3-sidebar.png` })

  const sidebarProbes = await p.evaluate(() => {
    // Only lane rows with NO live session render a LaneRow; the live ones render a
    // SessionItem instead, so pick the first row that actually has the idle markup.
    const idle = Array.from(document.querySelectorAll('[data-lane-row]'))
      .find((el) => el.textContent?.trim().endsWith('idle'))
    if (idle) idle.setAttribute('data-idle-lane', '')
    return [
      window.__contrast('[data-idle-lane] > div > span:nth-child(2)', 'idle lane name'),
      window.__contrast('[data-idle-lane] > div > span:nth-child(3)', 'idle lane "idle" tag', true),
      window.__contrast('[data-session-row] [data-accent-orb] + div > span:first-child', 'live lane name'),
      window.__contrast('.drag-region > div:nth-child(2)', 'sidebar project path', true),
    ]
  })
  // The sidebar's own crop, so lane rows are legible in the contact sheet.
  await p.screenshot({ path: `${OUT}/${key}-3b-sidebar-crop.png`, clip: { x: 0, y: 0, width: 240, height: 900 } })

  // ---- 2·channel. The project channel's own ink -----------------------------------
  // The author name and the avatar initials are drawn in the LANE ACCENT through
  // laneTextColor — the one place in this view where the colour comes from user data rather
  // than a token, which is exactly what collapses on a light palette without the blend.
  await p.locator('[data-channel-nav]').first().click()
  await p.waitForTimeout(900)
  await p.evaluate(PROBE)
  await p.locator('[data-channel-row]').first().hover().catch(() => {})
  await p.waitForTimeout(250)
  const channelProbes = await p.evaluate(() => {
    // Probe a row whose author RESOLVED to a lane (those carry the accent ink); an unresolved
    // author is drawn in --fg-muted and is not the interesting case.
    const rows = Array.from(document.querySelectorAll('[data-channel-row]')) // feed rows only now
    const withAccent = rows.find((r) => (r.querySelector('[data-channel-author]')?.getAttribute('style') || '').includes('lane-ink-blend'))
    if (withAccent) withAccent.setAttribute('data-probe-channel', '')
    // The held row carries the warn tone — also accent-derived, so also worth measuring.
    const held = rows.find((r) => r.querySelector('[data-channel-approve]'))
    if (held) held.setAttribute('data-probe-held', '')
    return [
      window.__contrast('[data-probe-channel] [data-channel-author]', 'channel author name'),
      window.__contrast('[data-probe-channel] [data-channel-avatar]', 'channel avatar initials'),
      window.__contrast('[data-probe-channel] [data-channel-text]', 'channel message body'),
      window.__contrast('[data-probe-channel] [data-channel-chip]', 'channel chip · delivered', true),
      window.__contrast('[data-probe-held] [data-channel-chip]', 'channel chip · held', true),
      window.__contrast('[data-channel-composer-note]', 'channel composer note', true),
      // The feed's first interactive furniture. It is hidden by OPACITY at rest, and __contrast
      // folds effective opacity into the sample — so measured cold it reads a flat 1.00:1, which
      // is the probe seeing fg == bg, not a contrast failure. It is hovered by the driver just
      // above, i.e. measured in the state a reader actually sees. Forcing `style.opacity` here
      // instead does NOT work: this feed re-renders on every session:update and React puts the
      // prop straight back.
      window.__contrast('[data-channel-copy]', 'channel copy action', true),
      // The agent↔agent kill switch, in BOTH states: paused is --fg-muted, live is
      // --color-warning at 9px — a token that had never been measured at meta size.
      window.__contrast('[data-chatter-toggle]', 'chatter switch · paused', true),
    ]
  })
  // Flip it and measure the live label too, then flip back so the sweep leaves no state behind.
  // A DOM .click() rather than a real one: this sweep's fixture puts an overlay over the header,
  // and the probe only needs the STATE, not a hit-test (the channel driver covers the real click).
  const flip = () => p.evaluate(() => document.querySelector('[data-chatter-toggle]')?.click())
  await flip()
  await p.waitForTimeout(250)
  channelProbes.push(await p.evaluate(() => window.__contrast('[data-chatter-toggle]', 'chatter switch · live', true)))
  await flip()
  await p.waitForTimeout(250)
  await p.screenshot({ path: `${OUT}/${key}-3d-channel.png` })
  // Back to the roster for the steps below.
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(700)
  await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
  await p.waitForTimeout(800)

  // ---- 2b. The roster board: only live lanes are cards, idle lanes are compact rows ----
  await p.locator('button[aria-label="Open the roster"]').click()
  await p.waitForTimeout(800)
  await p.evaluate(PROBE)
  const rosterProbes = await p.evaluate(() => {
    // The UNSELECTED options inside a live RoleCard: model pills, effort pills, and the
    // worktree toggle. These are the controls that carried `--fg-muted × 0.4` — the third
    // recurrence of the stacked-fade bug — so they get probed every pass now. They're
    // functional labels you have to read to choose, so they're held to the body floor, not
    // the meta one. Tagged by text/state rather than nth-child, which re-points silently.
    const card = document.querySelector('[data-role-card]')
    const btns = Array.from(card?.querySelectorAll('button') ?? [])
    const tag = (el, attr) => { if (el) el.setAttribute(attr, ''); return !!el }
    tag(btns.find((b) => b.textContent?.trim() === 'Haiku'), 'data-probe-model')      // never the pick in fixtures
    tag(btns.find((b) => b.textContent?.trim() === 'Low'), 'data-probe-effort')
    tag(btns.find((b) => b.getAttribute('aria-pressed') === 'false'), 'data-probe-worktree')
    return [
      window.__contrast('[data-roster-row] [data-lane-name]', 'ready row name'),
      window.__contrast('[data-lane-config]', 'ready row model/effort', true),
      window.__contrast('[data-probe-model]', 'roster model pill (off)'),
      window.__contrast('[data-probe-effort]', 'roster effort pill (off)'),
      window.__contrast('[data-probe-worktree]', 'roster worktree (off)'),
    ]
  })
  for (const r of rosterProbes) rows.push({ theme: key, ...r })
  await p.screenshot({ path: `${OUT}/${key}-3c-roster.png` })

  // ---- 2c. Chat liveness: the status line's ink on every palette -------------------
  // These sit at the foot of the reading surface and are the only always-muted text there,
  // so they are exactly where the stacked-opacity failure would reappear.
  await p.locator('[data-session-row="s-code"]').click().catch(() => {})
  await p.waitForTimeout(500)
  await p.getByText('Chat', { exact: true }).first().click().catch(() => {})
  await p.waitForTimeout(900)
  await p.evaluate(() => window.__mockPhase?.('s-code', { status: 'active', phase: 'running', lastToolName: 'Edit' }))
  await p.waitForTimeout(1400) // the elapsed clock is suppressed under 1s — wait it out
  await p.evaluate(PROBE)
  const chatProbes = await p.evaluate(() => [
    window.__contrast('[data-chat-status-label]', 'chat status label'),
    window.__contrast('[data-chat-status-elapsed]', 'chat status elapsed', true),
    // §2 moved the stop into the composer's orb — one stop control, so probe that instead.
    window.__contrast('[data-composer-action]', 'composer orb (stop)'),
  ])
  for (const r of chatProbes) rows.push({ theme: key, ...r })
  await p.screenshot({ path: `${OUT}/${key}-2c-chat-signals.png` })
  // Back to the roster view the later steps expect.
  await p.locator('button[aria-label="Open the roster"]').click().catch(() => {})
  await p.waitForTimeout(700)

  // ---- 3. Sidebar header — IDENTITY ONLY -----------------------------------------
  // The switcher popover it used to open is gone (project navigation moved to the rail's
  // foot), so what's probed here is the header's own ink: the project name and its path.
  const headerProbes = await p.evaluate(() => [
    window.__contrast('[data-sidebar-project-name]', 'sidebar project name'),
    window.__contrast('[data-sidebar-identity]', 'sidebar version', true),
  ])
  for (const r of headerProbes) rows.push({ theme: key, ...r })

  // ---- 3b. The bottom-left corner's ICONS ----------------------------------------
  // These went unmeasured for their whole life, and not by oversight: `__contrast` reads an
  // element's `color`, and both strips' icons used to paint with a hardcoded `stroke="var(
  // --fg-muted)"` instead — so there was nothing for it to read, and the `opacity: 0.85` the
  // sidebar footer stacked on top of that token was invisible to the one harness whose job is
  // to catch exactly that. Both rows now set `color` and draw with `currentColor`, which is
  // what makes them probeable at all.
  const cornerProbes = await p.evaluate(() => {
    const side = document.querySelector('[data-sidebar-foot-btn]')
    if (side) side.setAttribute('data-probe-side-foot', '')
    const rail = document.querySelector('[data-rail-gallery]')
    if (rail) rail.setAttribute('data-probe-rail-foot', '')
    return [
      window.__contrast('[data-probe-rail-foot]', 'rail foot icon', true),
      window.__contrast('[data-probe-side-foot]', 'sidebar footer icon', true),
    ]
  })
  for (const r of cornerProbes) rows.push({ theme: key, ...r })

  // ---- 4. Collapsed rail --------------------------------------------------------
  await p.keyboard.press('Meta+b')
  await p.waitForTimeout(800)
  await p.screenshot({ path: `${OUT}/${key}-5-rail.png`, clip: { x: 0, y: 0, width: 120, height: 900 } })
  await p.keyboard.press('Meta+b')
  await p.waitForTimeout(500)

  // ---- 4b. SETTINGS SWEEP (spec §7) ------------------------------------------------
  // The four pages that wear PageShell. Probes the template's own tokens by their tags, so
  // a page that re-declares type inline shows up as a different number rather than passing
  // by looking similar.
  const settingsProbes = []

  // PrefsView — the flat page: the only one carrying section headers + descriptions.
  await p.locator('button[title="Operator preferences"]').click()
  await p.waitForTimeout(700)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => [
    window.__contrast('[data-page-title]', 'prefs · pageTitle'),
    window.__contrast('[data-page-subtitle]', 'prefs · pageSubtitle', true),
    window.__contrast('[data-section-header]', 'prefs · sectionHeader'),
    window.__contrast('[data-section-desc]', 'prefs · sectionDesc', true),
  ]))
  await p.screenshot({ path: `${OUT}/${key}-8-prefs.png` })

  // FolderPreferencesView — the tabbed page. Its General tab is where the de-facto field
  // labels live (the exported `fieldLabel` token is not actually consumed anywhere).
  await p.locator('button[title="operator Claude files (.claude)"]').click()
  await p.waitForTimeout(800)
  await p.locator('[data-page-tab="General"]').click()
  await p.waitForTimeout(600)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => {
    document.querySelector('label')?.setAttribute('data-probe-field', '')
    return [
      window.__contrast('[data-page-title]', 'folderPrefs · pageTitle'),
      window.__contrast('[data-page-subtitle]', 'folderPrefs · pageSubtitle', true),
      window.__contrast('[data-page-tab]:not([style*="--fg-muted"])', 'folderPrefs · active tab'),
      window.__contrast('[data-probe-field]', 'folderPrefs · fieldLabel'),
    ]
  }))
  await p.screenshot({ path: `${OUT}/${key}-9-folderprefs.png` })

  // AgentsHubView (grid measure) and, behind its second tab, AgentLibraryView.
  // Reached from the RAIL foot now, not the sidebar footer — the hub is cross-project, and the
  // sidebar it used to live in animates to width 0 at the gallery.
  await p.locator('[data-rail-agents]').click()
  await p.waitForTimeout(800)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => [
    window.__contrast('[data-page-title]', 'agentsHub · pageTitle'),
    window.__contrast('[data-page-subtitle]', 'agentsHub · pageSubtitle', true),
  ]))
  // The Fleet tab's character cards. The lane NAME is the one ink here that comes from user data
  // rather than a token (laneTextColor over a per-lane accent), and the loadout line is the card's
  // reason to exist at rest — the thing that replaced an em dash reading as missing data.
  settingsProbes.push(...await p.evaluate(() => {
    const live = document.querySelector('[data-agent-card][data-agent-live]')
    const idle = Array.from(document.querySelectorAll('[data-agent-card]')).find((c) => !c.hasAttribute('data-agent-live'))
    if (live) { live.children[0].children[1].setAttribute('data-probe-live-name', ''); live.children[1].setAttribute('data-probe-live-loadout', '') }
    if (idle) { idle.children[0].children[1].setAttribute('data-probe-idle-name', ''); idle.children[1].setAttribute('data-probe-idle-loadout', '') }
    const q = document.querySelector('[data-agent-queued]')
    if (q) q.setAttribute('data-probe-queued', '')
    return [
      window.__contrast('[data-probe-live-name]', 'agentCard · live name'),
      window.__contrast('[data-probe-idle-name]', 'agentCard · idle name'),
      window.__contrast('[data-probe-live-loadout]', 'agentCard · loadout', true),
      window.__contrast('[data-probe-queued]', 'agentCard · queued badge', true),
    ]
  }))
  // The DEFAULTS tab: a lane name in its accent (laneTextColor), and the option pickers — where
  // the "chosen" state is accent ink at 9.5px, the size that collapses on the light palettes.
  await p.locator('[data-page-tab="defaults"]').click()
  await p.waitForTimeout(600)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => {
    // Choose one, so the accent-ink state exists to be measured rather than assumed.
    document.querySelector('[data-default-row="operator"] [data-default-option="model:opus"]')?.click()
    return []
  }))
  await p.waitForTimeout(300)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => [
    window.__contrast('[data-default-row="operator"] [data-default-name]', 'defaults · lane name'),
    // This view now renders the SHARED Segmented, so it exposes the same hooks the roster does.
    window.__contrast('[data-segment-state="pinned"]', 'defaults · chosen option', true),
    window.__contrast('[data-segment-state="inherited"]', 'defaults · preset option', true),
    window.__contrast('[data-segment-state="off"]', 'defaults · other option', true),
    window.__contrast('[data-segmented="worktree"] [aria-checked="true"]', 'defaults · worktree toggle', true),
  ]))
  await p.screenshot({ path: `${OUT}/${key}-10-defaults.png` })

  await p.locator('[data-page-tab="library"]').click()
  await p.waitForTimeout(700)
  // The editor pane only exists once an agent is selected — an unselected library has no
  // Field labels at all, which is why this probe first read as "missing" rather than passing.
  await p.getByText('code-reviewer').first().click().catch(() => {})
  await p.waitForTimeout(600)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => {
    const lbl = document.querySelector('label')
    if (lbl) {
      lbl.setAttribute('data-probe-field', '')
      const hint = lbl.parentElement?.querySelector('p')
      if (hint) hint.setAttribute('data-probe-hint', '')
    }
    return [
      window.__contrast('[data-probe-field]', 'agentLibrary · fieldLabel'),
      window.__contrast('[data-probe-hint]', 'agentLibrary · field hint', true),
    ]
  }))
  await p.screenshot({ path: `${OUT}/${key}-10-agentlibrary.png` })

  // The PLAN METER's popover: percentages, reset lines, and the three threshold fills — the
  // 75%/90% colours must stay distinguishable from the normal one on the LIGHT palettes, which is
  // where accent-vs-warning collapses.
  await p.goto(`http://localhost:${PORT}/dev/mock.html?usage=high`, { waitUntil: 'load' })
  await p.waitForTimeout(2800)
  await p.locator('[data-rail-usage]').click()
  await p.waitForTimeout(600)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => [
    window.__contrast('[data-usage-row="session"] [data-usage-value]', 'planMeter · percentage'),
    window.__contrast('[data-usage-row="session"] p', 'planMeter · reset line', true),
    window.__contrast('[data-usage-updated]', 'planMeter · updated', true),
  ]))
  notes.push(`${key} plan-meter fills — ` + await p.evaluate(() =>
    Array.from(document.querySelectorAll('[data-usage-bar]'))
      .map((b) => `${b.getAttribute('data-usage-tone')} ${getComputedStyle(b).backgroundColor}`).join(' / ')))
  // Distinguishable, not merely different: compare the three fills pairwise in sRGB.
  notes.push(`${key} plan-meter fill separation — ` + await p.evaluate(() => {
    const rgb = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number)
    const cols = Array.from(document.querySelectorAll('[data-usage-bar]')).map((b) => rgb(getComputedStyle(b).backgroundColor))
    const dist = (a, c) => Math.round(Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]))
    const pairs = []
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) pairs.push(dist(cols[i], cols[j]))
    return `min pairwise ΔRGB ${Math.min(...pairs)} (want > 60)`
  }))
  await p.screenshot({ path: `${OUT}/${key}-11-planmeter.png` })
  await p.keyboard.press('Escape')

  // The roster card's own three-state segments: an INHERITED lit value must clear the body floor,
  // because it is the selected value — not decoration — and it is drawn in a different ink now.
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(2600)
  // The app may boot already scoped to a project, so go out to the gallery first and come back in.
  await p.locator('[data-rail-gallery]').click()
  await p.waitForTimeout(700)
  await p.locator('[data-project-card]').first().click()
  await p.waitForTimeout(1000)
  // PIN one value first, so the accent-ink "pinned" state exists to be measured rather than
  // assumed absent — the fixture's lanes all inherit their model.
  await p.evaluate(() => document.querySelector('[data-role-card] [data-segment-state="off"]')?.click())
  await p.waitForTimeout(400)
  await p.evaluate(PROBE)
  settingsProbes.push(...await p.evaluate(() => [
    window.__contrast('[data-segment-state="pinned"]', 'roster · pinned value', true),
    window.__contrast('[data-segment-state="inherited"]', 'roster · inherited value'),
    window.__contrast('[data-segment-state="off"]', 'roster · unselected value', true),
    // The BUTTON, not the 9px swatch beside it — a filled colour chip has no text to measure,
    // and pointing a contrast probe at one reports 1.00 and reads as a defect.
    // The tri-state box is gone; worktree is the same segmented control as model and effort, so
    // the selected option is what carries the ink.
    window.__contrast('[data-segmented="worktree"][data-segmented-origin="pinned"] [aria-checked="true"]', 'roster · worktree pinned on', true),
    window.__contrast('[data-segmented="worktree"][data-segmented-origin="inherited"] [aria-checked="true"]', 'roster · worktree inherited', true),
  ]))

  for (const r of settingsProbes) rows.push({ theme: key, ...r })

  // ---- 5. First run (virgin app) -------------------------------------------------
  await p.close()
  p = await newPage()
  await p.goto(`http://localhost:${PORT}/dev/mock.html?empty=1`, { waitUntil: 'load' })
  await p.waitForTimeout(2200)
  await p.screenshot({ path: `${OUT}/${key}-6-empty.png` })

  // ---- 6. "Folder gone" card variant ---------------------------------------------
  await p.goto(`http://localhost:${PORT}/dev/mock.html?lost=1`, { waitUntil: 'load' })
  await p.waitForTimeout(2400)
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(700)
  await p.evaluate(PROBE)
  const lostProbes = await p.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-project-card]'))
    const el = cards.find((c) => c.textContent?.includes('folder not on record'))
    if (!el) return [{ label: 'lost card', missing: true }]
    el.setAttribute('data-lost-card', '')
    return [
      window.__contrast('[data-lost-card] [data-card-name]', 'lost card name'),
      // The chip SPAN carries the colour; its wrapper div inherits --fg, so measuring the
      // wrapper reports the card name's contrast all over again.
      window.__contrast('[data-lost-card] [data-card-chip]', 'lost card chip', true),
    ]
  })
  await p.screenshot({ path: `${OUT}/${key}-7-lost-card.png` })

  for (const r of [...railProbes, ...channelProbes, ...galleryProbes, ...tidyProbes, ...sheetProbes, ...shelfProbes, ...sidebarProbes, ...lostProbes]) rows.push({ theme: key, ...r })
  if (hoverBorder) notes.push(`${key} card hover — border ${hoverBorder.border} / bg ${hoverBorder.bg}`)
  if (rowHover) notes.push(`${key} previous-row hover — border-width ${rowHover.border} / bg ${rowHover.bg} / restore opacity ${rowHover.restoreOpacity}`)
  await ctx.close()
  await b.close()
  console.log(`✓ ${label}`)
}

// --- report ------------------------------------------------------------------------
console.log('\nCONTRAST (text : effective backdrop)')
const labels = [...new Set(rows.map((r) => r.label))]
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('label', 30) + THEMES.map(([k]) => pad(k.replace('mission-control', 'mc').replace('-dark', '·D').replace('-light', '·L'), 9)).join(''))
for (const label of labels) {
  let line = pad(label, 30)
  for (const [k] of THEMES) {
    const r = rows.find((x) => x.theme === k && x.label === label)
    line += pad(r?.missing ? '—' : r.ratio.toFixed(2), 9)
  }
  console.log(line)
}
const fails = rows.filter((r) => !r.missing && r.ratio < (r.meta ? META_FLOOR : FLOOR))
console.log(`\nBELOW FLOOR (${FLOOR} body / ${META_FLOOR} meta): ${fails.length}`)
for (const f of fails) console.log(`  ✗ ${f.theme}  ${f.label}  ${f.ratio}  (${f.size}px)`)
if (notes.length) console.log('\nNOTES\n' + notes.map((n) => '  ' + n).join('\n'))
console.log(`\nshots → ${OUT}`)
