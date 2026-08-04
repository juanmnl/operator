// FOUR-THEME (six-palette) PASS over the task board — components/session/TaskBoard.tsx.
//
// The board is project home, so everything on it is the first thing a user sees: the card title,
// the lane chip drawn in USER DATA (a role accent, which no theme can compensate for), the muted
// meta row, the done card's receded ink, and the held-dispatch card whose whole job is to be
// noticed. Each of those is measured for contrast in every palette, because a token that reads
// fine on the near-black default is exactly the kind that collapses on a light one.
//
// It also asserts the things a screenshot can't:
//   • the Waiting column holds the held DISPATCHES and nothing else — no delivered records, and
//     no `replyId` records (those are chat deliveries, not work, and in the real store they are
//     the MAJORITY of held ones).
//   • four columns degrade to two and then one as the container narrows, with no horizontal
//     overflow at any width.
//   • every column survives being empty, and an empty board renders the invitation instead.
//
// Run against a hand-started vite dev server:
//   npx vite --port 1438 --strictPort
//   node dev/drive-task-board.mjs
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1438
const URL = `http://localhost:${PORT}/dev/board-preview.html`
const OUT = '/tmp/operator-shots/task-board'
mkdirSync(OUT, { recursive: true })

const THEMES = [
  ['mission-control', 'dark'], ['mission-control', 'light'],
  ['mr-pink', 'dark'], ['mr-pink', 'light'],
  ['1984', 'dark'], ['1984', 'light'],
]

// Contrast plumbing, ported verbatim from drive-theme-pass.mjs — text is measured against its
// EFFECTIVE backdrop (walk up for the first opaque background, fold in element opacity and any
// color-mix alpha). WebKit serializes color-mix down to `color(srgb …)`, which the naive rgba()
// parse misses entirely, and the lane chip is exactly that form.
const PROBE = `(() => {
  const parseRGB = (s) => {
    const str = String(s)
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

// Everything on a card is ≤12.5px, so WCAG's large-text allowance never applies: 4.5:1 for text
// you must READ, 3:1 for supporting meta (counts, timestamps, tags) you only glance at.
const FLOOR = 4.5
const META_FLOOR = 3.0

const rows = []
const notes = []
const fails = []

const check = (theme, r) => {
  if (r.missing) { fails.push(`${theme} — MISSING probe "${r.label}"`); return }
  const floor = r.meta ? META_FLOOR : FLOOR
  rows.push({ theme, label: r.label, ratio: r.ratio, size: r.size, floor, ok: r.ratio >= floor })
  if (r.ratio < floor) fails.push(`${theme} — ${r.label}: ${r.ratio}:1 (< ${floor}:1) @${r.size}px`)
}

for (const [identity, mode] of THEMES) {
  const key = `${identity}-${mode}`
  // One browser per palette: WebKit accumulates across a sweep this size and hard-crashes
  // mid-run with no JS error, which reads as a product bug.
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: mode })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`${key} PAGEERROR ${String(e).slice(0, 200)}`))
  await p.goto(URL, { waitUntil: 'load' })
  await p.waitForSelector('[data-board]')
  await p.click(`[data-theme-btn="${identity}"]`)
  await p.click(`[data-mode-btn="${mode}"]`)
  await p.waitForTimeout(250)
  await p.evaluate(PROBE)

  // ---- 1. The full board -----------------------------------------------------------------
  await p.screenshot({ path: `${OUT}/${key}-1-board.png` })
  const probes = await p.evaluate(() => {
    // Tag the specific instances the probes want, so a re-ordering of the columns can't
    // silently re-point a structural selector at a different card.
    const q = (s) => document.querySelector(s)
    q('[data-board-column="backlog"] [data-card-title]')?.setAttribute('data-p-backlog-title', '')
    q('[data-board-column="running"] [data-card-title]')?.setAttribute('data-p-running-title', '')
    q('[data-board-column="running"] [data-lane-line]')?.setAttribute('data-p-lane-line', '')
    q('[data-board-column="running"] [data-card-agent]:not([data-card-agent=""]) span:last-child')?.setAttribute('data-p-agent', '')
    q('[data-board-column="running"] [data-card-time]')?.setAttribute('data-p-time', '')
    q('[data-board-column="running"] [data-child-threads]')?.setAttribute('data-p-child', '')
    q('[data-board-column="waiting"] [data-card-title]')?.setAttribute('data-p-waiting-title', '')
    q('[data-board-column="waiting"] [data-waiting-reason]')?.setAttribute('data-p-waiting-reason', '')
    q('[data-approve]')?.setAttribute('data-p-approve', '')
    q('[data-decline]')?.setAttribute('data-p-decline', '')
    q('[data-board-column="done"] [data-card-title]')?.setAttribute('data-p-done-title', '')
    q('[data-board-column="done"] [data-card-unconfirmed]')?.setAttribute('data-p-unconfirmed', '')
    q('[data-board-column="done"] [data-card-diff]')?.setAttribute('data-p-diff', '')
    // The `+479 −2` numbers themselves, not the button they sit in — they carry their own ink
    // (--add-fg/--del-fg), which is the one theme-AGNOSTIC pair in the system and therefore the
    // likeliest thing on the board to collapse on a light palette.
    const stat = q('[data-task-card="d1"] [data-card-diff]')?.querySelectorAll('span')
    stat?.[0]?.setAttribute('data-p-added', '')
    stat?.[1]?.setAttribute('data-p-removed', '')
    q('[data-card-check]')?.setAttribute('data-p-check', '')
    q('[data-board-column="backlog"] header span:nth-child(2)')?.setAttribute('data-p-col-label', '')
    return [
      window.__contrast('[data-p-col-label]', 'column label', true),
      window.__contrast('[data-board-count="running"]', 'column count', true),
      window.__contrast('[data-p-backlog-title]', 'backlog card title'),
      window.__contrast('[data-p-running-title]', 'running card title'),
      window.__contrast('[data-p-lane-line]', 'running lane activity line', true),
      window.__contrast('[data-p-agent]', 'agent chip name (lane accent ink)'),
      window.__contrast('[data-p-time]', 'card elapsed time', true),
      window.__contrast('[data-p-child]', 'child-threads row', true),
      window.__contrast('[data-p-waiting-title]', 'held dispatch task text'),
      window.__contrast('[data-p-waiting-reason]', 'held dispatch reason'),
      window.__contrast('[data-p-approve]', 'Approve button'),
      window.__contrast('[data-p-decline]', 'Decline button', true),
      window.__contrast('[data-p-done-title]', 'done card title (receded)'),
      window.__contrast('[data-p-unconfirmed]', 'unconfirmed tag', true),
      window.__contrast('[data-p-diff]', 'diff summary', true),
      window.__contrast('[data-p-added]', 'diff +added', true),
      window.__contrast('[data-p-removed]', 'diff −removed', true),
      window.__contrast('[data-p-check]', 'check chip', true),
    ]
  })
  for (const r of probes) check(key, r)

  // ---- 1b. DISABLED controls -------------------------------------------------------------
  // The sweep never probed a disabled control, which is exactly why `opacity: .45` stacked on
  // `--fg-muted` (1.69:1 on mr-pink-light) survived a full six-palette pass. A disabled control
  // still has to be READ — you have to know what the button you can't press says — so it is held
  // to the 3:1 meta floor like any other supporting text.
  const disabledProbes = await p.evaluate(() => {
    // Backlog's Send → on an unassigned task: disabled at rest, on the board's busiest column.
    const send = [...document.querySelectorAll('[data-card-send]')].find((b) => b.disabled)
    send?.setAttribute('data-p-send-disabled', '')
    return [window.__contrast('[data-p-send-disabled]', 'disabled Send → (backlog card)', true)]
  })
  for (const r of disabledProbes) check(key, r)

  // ---- 2. Empty board + empty columns ----------------------------------------------------
  await p.click('[data-scenario-btn="empty"]')
  await p.waitForTimeout(200)
  await p.screenshot({ path: `${OUT}/${key}-2-empty-board.png` })
  const hasInvite = await p.locator('[data-board-empty]').count()
  if (!hasInvite) fails.push(`${key} — empty board did not render the invitation`)
  const emptyProbe = await p.evaluate(() => {
    // THE WORST INSTANCE of the disabled defect: the empty board's Add button is the primary
    // action on a brand-new project's home screen, and it sits disabled at rest until you type.
    document.querySelector('[data-board-add-submit]')?.setAttribute('data-p-add-disabled', '')
    return [
      window.__contrast('[data-board-empty] h2', 'empty board headline'),
      window.__contrast('[data-board-empty] p', 'empty board subline', true),
      window.__contrast('[data-p-add-disabled]', 'disabled Add (empty board, at rest)', true),
    ]
  })
  for (const r of emptyProbe) check(key, r)

  // Backlog empty BESIDE a populated column — the only shape in which its own empty box, the one
  // that used to be 28px taller than everyone else's, is visible next to the others.
  await p.click('[data-scenario-btn="running-only"]')
  await p.waitForTimeout(200)
  await p.screenshot({ path: `${OUT}/${key}-3b-backlog-empty.png` })
  const backlogBoxes = await p.evaluate(() => [...document.querySelectorAll('[data-column-empty]')]
    .map((e) => ({ col: e.closest('[data-board-column]')?.getAttribute('data-board-column'), h: Math.round(e.getBoundingClientRect().height * 100) / 100 })))
  const hs = backlogBoxes.map((b) => b.h)
  if (!backlogBoxes.some((b) => b.col === 'backlog')) fails.push(`${key} — running-only did not empty the backlog column`)
  if (hs.length && Math.max(...hs) - Math.min(...hs) > 0.5) {
    fails.push(`${key} — empty boxes differ in height with backlog among them: ${JSON.stringify(backlogBoxes)}`)
  }
  if (await p.locator('[data-column-empty] button').count()) {
    fails.push(`${key} — an empty column still carries its own button; that is the 28px that made Backlog taller`)
  }

  await p.click('[data-scenario-btn="backlog-only"]')
  await p.waitForTimeout(200)
  await p.screenshot({ path: `${OUT}/${key}-3-empty-columns.png` })
  const emptyCols = await p.locator('[data-column-empty]').count()
  if (emptyCols !== 3) fails.push(`${key} — expected 3 empty columns (running/waiting/done), got ${emptyCols}`)
  // THE THREE THINGS THE COLUMN HEADS CLAIM, measured rather than eyeballed. Each was a real
  // defect: four labels on two baselines (a header sized by whichever control it carried), and
  // an empty box 28px taller in Backlog than in its neighbours (an in-box button only it had).
  const heads = await p.evaluate(() => {
    const round = (n) => Math.round(n * 100) / 100
    const cols = [...document.querySelectorAll('[data-board-column]')]
    return {
      labels: cols.map((c) => round(c.querySelector('[data-board-label]')?.getBoundingClientRect().top ?? -1)),
      headers: cols.map((c) => round(c.querySelector('header')?.getBoundingClientRect().height ?? -1)),
      boxes: [...document.querySelectorAll('[data-column-empty]')].map((e) => round(e.getBoundingClientRect().height)),
      // C2: the `+` sits inside BACKLOG's own name cluster, left of the midpoint of its header —
      // not parked on the far edge where it read as belonging to neither column.
      addAt: (() => {
        const btn = document.querySelector('[data-board-add]')
        const head = btn?.closest('header')
        if (!btn || !head) return null
        const b = btn.getBoundingClientRect(), h = head.getBoundingClientRect()
        return round((b.left - h.left) / h.width)
      })(),
    }
  })
  const spread = (xs) => Math.max(...xs) - Math.min(...xs)
  notes.push(`${key} — label tops ${JSON.stringify(heads.labels)}, header heights ${JSON.stringify(heads.headers)}, empty boxes ${JSON.stringify(heads.boxes)}, + at ${heads.addAt}`)
  if (spread(heads.labels) > 0.5) fails.push(`${key} — the four column labels are not on one baseline: ${JSON.stringify(heads.labels)}`)
  if (spread(heads.headers) > 0.5) fails.push(`${key} — column headers are different heights: ${JSON.stringify(heads.headers)}`)
  if (spread(heads.boxes) > 0.5) fails.push(`${key} — empty columns are different heights: ${JSON.stringify(heads.boxes)}`)
  if (heads.addAt === null || heads.addAt > 0.5) fails.push(`${key} — Backlog's + is at ${heads.addAt} of the header width; it belongs in the label cluster`)
  const emptyColProbe = await p.evaluate(() => {
    document.querySelector('[data-column-empty] p')?.setAttribute('data-p-empty-col', '')
    return [window.__contrast('[data-p-empty-col]', 'empty column text', true)]
  })
  for (const r of emptyColProbe) check(key, r)

  await p.click('[data-scenario-btn="full"]')
  await p.waitForTimeout(150)
  await b.close()
}

// ---- 3. Structure, once (theme-independent) ------------------------------------------------
{
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`structure PAGEERROR ${String(e).slice(0, 200)}`))
  await p.goto(URL, { waitUntil: 'load' })
  await p.waitForSelector('[data-board]')

  // Waiting = work that is stopped until a human acts. The fixture also carries a delivered
  // record, a braked REPLY delivery (the shape all three brakes actually have), and an
  // `unassigned` record whose task is already in Backlog — none may appear here.
  const waiting = await p.$$eval('[data-waiting-card]', (els) => els.map((e) => e.getAttribute('data-waiting-card')))
  const expected = ['cf5497448fb9d8e2', '11e8ab119beac2a4']
  if (JSON.stringify([...waiting].sort()) !== JSON.stringify([...expected].sort())) {
    fails.push(`waiting column = [${waiting}] — expected [${expected}] (a delivered, replyId or unassigned record leaked in)`)
  }
  notes.push(`waiting column holds ${waiting.length}: ${waiting.join(', ')}`)

  // The unroutable dispatch's work must be in BACKLOG, once, carrying its reason.
  const unrouted = await p.locator('[data-card-unrouted]').count()
  if (unrouted !== 1) fails.push(`expected exactly 1 unrouted-reason note in Backlog, got ${unrouted}`)

  // A task whose lane was deleted must say so, not "Unassigned" — on BOTH surfaces that name a
  // lane. A backlog card names it through the assignee picker (the control you'd reassign with);
  // a running or closed card names it through the agent chip. They are different elements, and
  // an earlier version of this check only looked at the chip and so passed the backlog case by
  // never testing it.
  const lostChips = await p.$$eval('[data-card-agent-lost]', (els) => els.map((e) => e.textContent.trim()))
  const lostPicker = await p.$$eval('[data-card-assignee]', (els) => els
    .map((e) => e.textContent.trim()).filter((t) => /gone/i.test(t)))
  notes.push(`deleted-lane: chips ${JSON.stringify(lostChips)}, picker ${JSON.stringify(lostPicker)}`)
  if (!lostChips.some((t) => /infra/.test(t) && /gone/i.test(t))) {
    fails.push(`a CLOSED task on a deleted lane did not name it as gone — chips read ${JSON.stringify(lostChips)}`)
  }
  if (!lostPicker.some((t) => /infra/.test(t))) {
    fails.push(`a BACKLOG task on a deleted lane did not name it as gone — picker read ${JSON.stringify(lostPicker)}`)
  }

  // Approve/decline exist ONLY on the approvable one. A brake or an undelivered record cannot be
  // approved — an Approve there would promise a recovery it can't perform.
  const approveCount = await p.locator('[data-approve]').count()
  const declineCount = await p.locator('[data-decline]').count()
  if (approveCount !== 1 || declineCount !== 1) fails.push(`expected exactly 1 approve + 1 decline, got ${approveCount}/${declineCount}`)

  // The Moss-style child row, on the parent card, from the real `activeSubagents` count.
  const child = await p.locator('[data-child-threads]').first()
  const childText = (await child.count()) ? (await child.innerText()).replace(/\s+/g, ' ').trim() : '(none)'
  if (!childText.includes('2 active child threads')) fails.push(`child-threads row read "${childText}"`)
  notes.push(`child-threads row: "${childText}"`)

  // The done column counts abandoned separately rather than folding it into "done".
  const unconf = await p.locator('[data-board-unconfirmed]').innerText().catch(() => '')
  notes.push(`done header suffix: "${unconf.trim()}"`)
  // Case-insensitive: the label is uppercased in CSS, so innerText comes back "· 2 UNCONFIRMED".
  if (!/2\s+unconfirmed/i.test(unconf)) fails.push(`done header did not name the unconfirmed count (read "${unconf}")`)

  // ---- Done column: capped mount + Clear -------------------------------------------------
  await p.click('[data-scenario-btn="done-heavy"]')
  await p.waitForTimeout(400)
  const doneMounted = await p.locator('[data-board-column="done"] [data-task-card]').count()
  const doneCount = Number(await p.locator('[data-board-count="done"]').innerText())
  notes.push(`done-heavy: ${doneCount} closed tasks, ${doneMounted} cards mounted`)
  if (doneCount < 200) fails.push(`done-heavy fixture only produced ${doneCount} closed tasks`)
  if (doneMounted > 25) fails.push(`Done mounted ${doneMounted} cards for ${doneCount} closed tasks — the cap is not holding`)
  if (!(await p.locator('[data-board-done-more]').count())) fails.push('no "show more" control for the un-rendered closed tasks')
  await p.click('[data-board-done-more]')
  await p.waitForTimeout(250)
  const afterMore = await p.locator('[data-board-column="done"] [data-task-card]').count()
  if (afterMore <= doneMounted) fails.push(`"show more" did not mount more cards (${doneMounted} → ${afterMore})`)
  notes.push(`show-more: ${doneMounted} → ${afterMore} cards`)
  // Clear is a capability TaskQueue had; it must be present and must state the count it will take.
  if (!(await p.locator('[data-board-clear]').count())) fails.push('Done column has no Clear control')
  await p.click('[data-board-clear]')
  await p.waitForTimeout(150)
  const confirmText = await p.locator('[data-board-clear-confirm]').innerText().catch(() => '')
  notes.push(`clear confirm reads: "${confirmText.trim()}"`)
  if (!confirmText.includes(String(doneCount))) {
    fails.push(`clear confirm must state the full count (${doneCount}); it reads "${confirmText.trim()}"`)
  }
  await p.click('[data-scenario-btn="full"]')
  await p.waitForTimeout(300)

  // A 3-line clamp on a paragraph-length task — the real store's queued text runs to ~700 chars.
  const clamp = await p.evaluate(() => {
    // The LONGEST title, not the first card — backlog sorts oldest-first, so which card leads is
    // fixture order, and pinning the clamp to it made the check stop exercising long text the
    // moment another task was added.
    const el = [...document.querySelectorAll('[data-board-column="backlog"] [data-card-title]')]
      .sort((a, b) => b.textContent.length - a.textContent.length)[0]
    if (!el) return null
    const lh = parseFloat(getComputedStyle(el).lineHeight)
    return { h: Math.round(el.getBoundingClientRect().height), lines: Math.round(el.getBoundingClientRect().height / lh), chars: el.textContent.length }
  })
  notes.push(`longest backlog title: ${clamp?.chars} chars → ${clamp?.lines} rendered lines (${clamp?.h}px)`)
  if (!clamp || clamp.lines > 3) fails.push(`backlog title clamp failed: ${clamp?.lines} lines`)

  // ---- 4. Responsive: 4 → 2 → 1, and never a horizontal overflow ------------------------
  for (const [label, w] of [['fill-1440', null], ['900', 900], ['560', 560]]) {
    await p.click(`[data-width-btn="${w ?? 'fill'}"]`)
    await p.waitForTimeout(250)
    const shape = await p.evaluate(() => {
      const grid = document.querySelector('[data-board] > div')
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
      const host = document.querySelector('[data-board-host]')
      return { cols, overflowX: Math.round(host.scrollWidth - host.clientWidth) }
    })
    const want = w === null ? 4 : w === 900 ? 2 : 1
    notes.push(`width ${label} → ${shape.cols} columns (overflow-x ${shape.overflowX}px)`)
    if (shape.cols !== want) fails.push(`width ${label}: ${shape.cols} columns, expected ${want}`)
    if (shape.overflowX > 1) fails.push(`width ${label}: horizontal overflow ${shape.overflowX}px`)
    // STACKED CLIP GUARD. When the board stacks, each section's row must fit its content — a row
    // shorter than what it holds does not clip, it draws the next column straight over this one,
    // which is how the single-column layout first shipped from this harness looking broken.
    if (want === 1) {
      const clipped = await p.$$eval('[data-board-column]', (els) => els
        .map((e) => ({ k: e.getAttribute('data-board-column'), h: Math.round(e.getBoundingClientRect().height), c: e.scrollHeight }))
        .filter((s) => s.c - s.h > 1))
      if (clipped.length) fails.push(`width ${label}: stacked sections shorter than their content — ${clipped.map((c) => `${c.k} ${c.h}<${c.c}`).join(', ')}`)
    }
    await p.screenshot({ path: `${OUT}/4-responsive-${label}.png` })
  }

  // ---- 5. Dismissing a held card: the transition, not the prop ---------------------------
  // Seven `undelivered` cards accumulated in a real project because this branch rendered no
  // control at all, and the handler would have refused one anyway — so the assertion has to be
  // that the RECORD MOVES, not that a button is on screen. The harness runs the app's own
  // `canDismissDispatch` guard, so a regression in that predicate fails here.
  await p.click('[data-width-btn="fill"]')
  await p.waitForTimeout(200)
  {
    const UNDELIVERED = '11e8ab119beac2a4' // the `sent · never started` record
    const PENDING = 'cf5497448fb9d8e2' // the held one — Decline must keep working
    const card = p.locator(`[data-waiting-card="${UNDELIVERED}"]`)
    // Approve stays absent: the bytes already went, and nothing retries them.
    if (await card.locator('[data-approve]').count()) {
      fails.push('the undelivered card grew an Approve — there is nothing to approve, and it does not retry')
    }
    const dismiss = card.locator(`[data-dismiss="${UNDELIVERED}"]`)
    if (!(await dismiss.count())) fails.push('the undelivered card has no Dismiss — it can never be cleared')
    // The word, never a glyph: `✕` on a live card has meant "delete the lane" in this app.
    const label = (await dismiss.innerText().catch(() => '')).trim()
    if (label !== 'Dismiss') fails.push(`the undelivered card's clear control reads "${label}", expected "Dismiss"`)
    // The "where did it go" line is its own row, so it is never truncated by the buttons.
    const where = card.locator('[data-undelivered-where]')
    if (!(await where.count())) fails.push('the undelivered card stopped saying where the task ended up')
    else {
      const trunc = await where.evaluate((e) => e.scrollWidth - e.clientWidth)
      if (trunc > 1) fails.push(`"${(await where.innerText()).trim()}" is clipped by ${trunc}px`)
    }
    const order = await card.locator('button').evaluateAll((els) => els.map((e) => e.textContent.trim()))
    notes.push(`undelivered card footer buttons: ${JSON.stringify(order)}`)
    if (order[order.length - 1] !== 'Dismiss') fails.push(`Dismiss must sit last in the footer; order was ${JSON.stringify(order)}`)

    await dismiss.click()
    await p.waitForTimeout(250)
    // (a) it leaves the column — `rejected` is not in WAITING_OUTCOMES.
    if (await card.count()) fails.push('a dismissed undelivered card stayed in the Waiting column')
    // (b) …and is still readable in the log, as declined. Dismiss is not delete: the record is
    // evidence about a delivery bug that is still open.
    const row = p.locator(`[data-dispatch-row="${UNDELIVERED}"]`)
    if (!(await row.count())) {
      fails.push('the dismissed record vanished from the dispatch log — it was deleted, not declined')
    } else {
      const outcome = (await row.locator('[data-dispatch-outcome]').innerText()).trim()
      notes.push(`dismissed undelivered → log reads "${outcome}"`)
      if (!/declined/i.test(outcome)) fails.push(`dismissed record logs as "${outcome}", expected "declined"`)
    }

    // The shared guard must not have cost the path it was extracted from: Decline on the held
    // card is the same handler, and it still has to land the same transition.
    await p.click(`[data-decline="${PENDING}"]`)
    await p.waitForTimeout(250)
    if (await p.locator(`[data-waiting-card="${PENDING}"]`).count()) {
      fails.push('a declined pending-approval card stayed in the Waiting column')
    }
    const pendingOutcome = await p.locator(`[data-dispatch-row="${PENDING}"] [data-dispatch-outcome]`).innerText().catch(() => '')
    if (!/declined/i.test(pendingOutcome)) fails.push(`declined pending record logs as "${pendingOutcome}", expected "declined"`)
    const emptyNow = await p.locator('[data-board-column="waiting"] [data-column-empty]').count()
    notes.push(`after both dismissals, Waiting is ${emptyNow ? 'empty' : 'still holding cards'}`)
    await p.screenshot({ path: `${OUT}/5-dismissed.png` })
  }
  await b.close()
}

// ---- Report --------------------------------------------------------------------------------
const worst = new Map()
for (const r of rows) {
  const prev = worst.get(r.label)
  if (!prev || r.ratio < prev.ratio) worst.set(r.label, r)
}
console.log('\nCONTRAST — worst palette per probe (floor 4.5:1 body / 3.0:1 meta)')
console.log('─'.repeat(84))
for (const [label, r] of worst) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(38)} ${String(r.ratio).padStart(6)}:1  @${r.size}px  (worst: ${r.theme})`)
}
console.log('\nNOTES')
for (const n of notes) console.log(`  · ${n}`)
console.log(`\nShots → ${OUT}`)
if (fails.length) {
  console.log(`\n${fails.length} FAILURE(S)`)
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nAll checks passed.')
