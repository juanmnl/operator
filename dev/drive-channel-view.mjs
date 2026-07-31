// Drive the CHANNEL FEED's readability (dev/briefs/channel-view-improvement.md — the brief file
// itself is absent; worked from the one-line task).
//
// THE FIXTURE IS THE POINT. The existing drive-project-channel.mjs seeds bodies like "FIRST
// delivered task" — 20 characters. The real store (`~/.operator/projects.json`, 332 dispatches)
// has a MEDIAN task of 520 chars, p90 1165, max 2790, and 11% carry backticks. A fixture 26x
// shorter than reality is exactly the trap in feedback_fixtures_must_match_reality: it validates
// a feed that cannot be read. Every entry below is copied from the real stores, not invented:
//
//   • a 33-long run of consecutive `operator` dispatches is the real shape (then 29, then 25) —
//     the reason grouping is needed at all
//   • two `paused` records are real: messages posted to the room that reached nobody
//   • the backticked paths and the `+` in the reply are verbatim from chat.db
//
// Run: `./node_modules/.bin/vite --port 1436 --strictPort` then `node dev/drive-channel-view.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1436
const MODE = process.argv[2] === 'before' ? 'before' : 'after'
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })

// Real bodies, real lengths. LONG is the p90-ish brief; HUGE is near the observed max.
const LONG = 'Read dev/briefs/global-agent-model-config.md and do it. Global per-role defaults for model and effort, stored in `~/.operator/role-defaults.json`, surfaced in Preferences, and inherited by every new lane unless the project overrides them. The roster row shows the inherited value in muted ink and the override in normal ink, so a lane that has been pinned reads differently from one that is merely following the default. Migration: existing projects keep their per-project settings, which continue to win. Result → dev/briefs/global-agent-model-config-RESULT.md'
const HUGE = LONG + ' ' + LONG + ' Additionally: the Preferences page needs a reset control per role, and the reset must distinguish "back to the shipped default" from "back to the global default" — they are different values once the user has edited the global. Do not collapse them into one button. Result → dev/briefs/global-agent-model-config-RESULT.md'

await ctx.addInitScript(({ LONG, HUGE }) => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const orig = v.loadProjects
      const at = (m) => `2026-07-30T${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00.000Z`
      // A run of consecutive `operator` dispatches — the real feed's dominant shape.
      const run = [
        ['design', 'Read dev/briefs/rail-foot-balance.md and do it. Bottom-left corner: ProjectRail foot + Sidebar footer row, one balance pass. Result → dev/briefs/rail-foot-balance-RESULT.md', 'sent'],
        ['code', 'Read dev/briefs/prune-seeded-idle-lanes.md and do it. One-time prune of never-launched unmodified seeded lanes from existing projects, with undo. Result → dev/briefs/prune-seeded-idle-lanes-RESULT.md', 'launched'],
        ['research', LONG, 'sent'],
        ['code', 'Second task, after the prune: read dev/briefs/worktree-default-on.md and do it. Worktree default ON for operator+research (seed AND migration of stored `role-defaults.json`). Result → dev/briefs/worktree-default-on-RESULT.md', 'sent'],
        ['design', 'Fourth, after the other three: read dev/briefs/rail-tiles-density-reorder.md and do it. Rail tiles crammed + must be drag-reorderable with persistence. Result → dev/briefs/rail-tiles-density-reorder-RESULT.md', 'sent'],
        ['qa', HUGE, 'queued'],
        ['design', 'Fifth: read dev/briefs/channel-view-improvement.md and do it. Channel feed unskimmable — unclamped bodies, no grouping, raw backticks, pause state invisible. Result → dev/briefs/channel-view-improvement-RESULT.md', 'sent'],
      ].map(([to, task, outcome], i) => ({
        id: `run${i}`, at: at(i * 3), fromRoleId: 'operator', toRoleId: to, task, outcome,
      }))
      v.loadProjects = async () => {
        const list = (await orig()) ?? []
        return list.map((p) => (p.name !== 'operator' ? p : {
          ...p,
          dispatches: [
            ...run,
            { id: 'held', at: at(24), fromRoleId: 'research', toRoleId: 'code', task: 'Spike the return path so a lane can hand a result back to Operator without a file. Needs your approval before it goes anywhere.', outcome: 'pending-approval' },
            // The two REAL paused records: posted to the room, delivered to nobody.
            { id: 'p1', at: at(30), replyId: 'r-paused-1', fromRoleId: 'operator', toRoleId: 'design', task: '', outcome: 'paused' },
            { id: 'p2', at: at(36), replyId: 'r-paused-2', fromRoleId: 'operator', toRoleId: 'design', task: '', outcome: 'paused' },
            { id: 'dv', at: at(42), replyId: 'r-ok', fromRoleId: 'code', toRoleId: 'operator', task: '', outcome: 'sent' },
          ],
        }))
      }
      v.saveProjects = () => {}
      const seeded = [
        // Verbatim from chat.db, backticks and all.
        { id: 'r-paused-1', sessionId: 's-op', to: 'design', text: 'Heads-up for your agents-hub task: Code is pruning 49 never-launched seeded lanes from existing projects — the "76 idle lanes" number will drop sharply, so design the Fleet tab for the post-prune reality, not that screenshot.', timestamp: at(30) },
        { id: 'r-paused-2', sessionId: 's-op', to: 'design', text: 'Your brief `dev/briefs/roster-config-chips-visibility.md` was AMENDED before you reached it: the funky tri-state worktree chip is now in scope on that same row, and Code is flipping worktree defaults to ON for operator+research — design for inherited-ON, not the screenshot.', timestamp: at(36) },
        { id: 'r-ok', sessionId: 's-code', to: 'operator', text: 'Seeded-lane prune shipped: 39 unused stock lanes across 9 projects go on next hydrate, one-time, with Undo — detail in `dev/briefs/prune-seeded-idle-lanes-RESULT.md`.', timestamp: at(42) },
        { id: 'r-design', sessionId: 's-design', to: 'project', text: 'Corner balance landed: rail foot + sidebar footer now one spec (26×26/r7/14px ink), baseline stagger 3px→0, all 8 controls answer hover, ink identical across 6 palettes — detail + a flagged duplicate `+` in collapsed state in `dev/briefs/rail-foot-balance-RESULT.md`', timestamp: at(48) },
      ]
      const liveReplies = v.projectReplies
      v.projectReplies = async (pid) => [...seeded, ...((await liveReplies(pid)) ?? [])]
    },
  })
}, { LONG, HUGE })

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3200)
await p.locator('[data-channel-nav]').click()
await p.waitForTimeout(900)

// ---- 1. Can a row be skimmed? -----------------------------------------------------------
// The measure is how much vertical space one entry takes. If the tallest entry is most of the
// viewport, the feed is a document, not a channel.
const heights = await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-channel-row]'))
  return {
    count: rows.length,
    tallest: Math.max(...rows.map((r) => Math.round(r.getBoundingClientRect().height))),
    total: rows.reduce((a, r) => a + Math.round(r.getBoundingClientRect().height), 0),
    viewport: Math.round(document.querySelector('.channel-scroll').getBoundingClientRect().height),
  }
})
console.log('1 rows:', heights.count, '· tallest entry:', heights.tallest, 'px · feed total:', heights.total,
  'px · viewport:', heights.viewport, 'px')
console.log('1 tallest entry as a share of the viewport:', `${Math.round((heights.tallest / heights.viewport) * 100)}%`,
  '(a single entry should never own the screen)')

// ---- 2. Grouping: how many times is one author's name repeated back to back? -------------
const authors = await p.evaluate(() => Array.from(document.querySelectorAll('[data-channel-author]')).map((e) => e.textContent.trim()))
let longestRun = 0, cur = 0, prev = null
for (const a of authors) { cur = a === prev ? cur + 1 : 1; prev = a; longestRun = Math.max(longestRun, cur) }
console.log('2 author labels rendered:', authors.length, '· longest consecutive repeat:', longestRun,
  '(the real store\'s longest same-author run is 33)')
console.log('2 avatars drawn:', await p.locator('[data-channel-avatar]').count())

// ---- 3. Raw backticks ---------------------------------------------------------------------
const ticks = await p.evaluate(() => {
  const texts = Array.from(document.querySelectorAll('[data-channel-text]')).map((e) => e.textContent)
  return { withTicks: texts.filter((t) => t.includes('`')).length, codeChips: document.querySelectorAll('[data-channel-code]').length }
})
console.log('3 bodies still showing a literal backtick:', ticks.withTicks, '(expect 0) · rendered code chips:', ticks.codeChips)

// ---- 4. Pause: is "this reached nobody" visible? ------------------------------------------
// The failure mode is not a missing chip — it is a chip QUIETER than the success it contradicts.
const tones = await p.evaluate(() => Array.from(document.querySelectorAll('[data-channel-chip]')).map((e) => ({
  label: e.textContent.trim(), color: getComputedStyle(e).color,
})))
const delivered = tones.find((t) => t.label === 'delivered' || t.label === 'posted · delivered')
const paused = tones.find((t) => t.label.includes('paused'))
const held = tones.find((t) => t.label.startsWith('held'))
console.log('4 chips:', JSON.stringify(tones.map((t) => t.label)))
console.log('4 delivered ink:', delivered?.color)
console.log('4 paused ink   :', paused?.color, paused && delivered && paused.color === delivered.color ? ' <-- SAME AS DELIVERED' : '')
console.log('4 held ink     :', held?.color, held && delivered && held.color === delivered.color ? ' <-- SAME AS DELIVERED' : '')
console.log('4 undelivered is distinguishable from delivered:',
  !!paused && !!delivered && paused.color !== delivered.color, '(expect true)')
// The feed opens scrolled to its NEWEST entry, so a notice is only real if it is on screen from
// where the reader actually lands — not merely present in the document.
const banner = await p.evaluate(() => {
  const el = document.querySelector('[data-channel-paused-banner]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const view = document.querySelector('.channel-scroll').getBoundingClientRect()
  return {
    text: el.textContent.trim().slice(0, 60),
    onScreenAtLanding: r.top >= view.top - 1 && r.bottom <= view.bottom + 1,
    resume: !!document.querySelector('[data-channel-paused-resume]'),
  }
})
console.log('4 standing notice while paused:', JSON.stringify(banner) ?? 'none')
console.log('4 …and it is visible where the reader LANDS:', banner?.onScreenAtLanding, '(expect true)')

// ---- 4b. Prose measure, target ink, actionable chips, sticky date -----------------------
const readable = await p.evaluate(() => {
  const body = document.querySelector('[data-channel-text]')
  const w = body.getBoundingClientRect().width
  // Empirical chars-per-line, not an assumed px-per-char: measure a known string in the body's
  // own computed font.
  const c = document.createElement('canvas').getContext('2d')
  const cs = getComputedStyle(body)
  c.font = `${cs.fontSize} ${cs.fontFamily}`
  const avg = c.measureText('abcdefghijklmnopqrstuvwxyz ,.-/').width / 31
  return { width: Math.round(w), charsPerLine: Math.round(w / avg) }
})
// The target moved, deliberately: 60–80 is calibrated for SUSTAINED prose, and this feed is
// scanned in bursts against a constant left edge. The cap is now a CEILING the body grows into.
console.log('\n4b prose column:', readable.width, 'px ≈', readable.charsPerLine,
  `chars/line (ceiling 900px ≈ 151; grows with the pane below that)`)

const target = await p.evaluate(() => {
  const t = document.querySelector('[data-channel-target]')
  const time = Array.from(document.querySelectorAll('[data-channel-row] span'))
    .find((s) => /^\d\d:\d\d$/.test(s.textContent.trim()))
  const g = (e) => e && { size: getComputedStyle(e).fontSize, color: getComputedStyle(e).color }
  return { target: g(t), time: g(time) }
})
console.log('4b target vs timestamp ink:', JSON.stringify(target))
console.log('4b …target is no longer identical to the timestamp:',
  JSON.stringify(target.target) !== JSON.stringify(target.time), '(expect true)')

const chips = await p.evaluate(() => Array.from(document.querySelectorAll('[data-channel-chip]')).map((e) => ({
  label: e.textContent.trim().slice(0, 26),
  actionable: e.hasAttribute('data-channel-chip-actionable'),
  bg: getComputedStyle(e).backgroundColor,
})))
console.log('4b actionable chips carry a tint:',
  JSON.stringify(chips.filter((c) => c.actionable).map((c) => c.label)))
console.log('4b …and non-actionable ones stay bare:',
  chips.filter((c) => !c.actionable).every((c) => c.bg === 'rgba(0, 0, 0, 0)'), '(expect true)')

// The date divider must survive scrolling — a static one only says the date while it happens to
// be on screen, which is exactly when you don't need it.
const stickyDate = await p.evaluate(() => {
  const sc = document.querySelector('.channel-scroll')
  sc.scrollTop = sc.scrollHeight // hard to the newest entry
  const d = document.querySelector('[data-channel-day]')
  if (!d) return null
  const r = d.getBoundingClientRect(), v = sc.getBoundingClientRect()
  return { text: d.textContent.trim(), visible: r.top >= v.top - 1 && r.bottom <= v.bottom + 1 }
})
console.log('4b date still on screen at the BOTTOM of the feed:', JSON.stringify(stickyDate), '(expect visible)')

// ---- 4c. Scroll must not drift ----------------------------------------------------------
// A live panel: expanding a body must not move what you were already reading.
const drift = await p.evaluate(async () => {
  const sc = document.querySelector('.channel-scroll')
  sc.scrollTop = Math.round(sc.scrollHeight * 0.4)
  await new Promise((r) => requestAnimationFrame(r))
  const before = sc.scrollTop
  const rows = Array.from(document.querySelectorAll('[data-channel-row]'))
  const anchor = rows.find((r) => r.getBoundingClientRect().top > sc.getBoundingClientRect().top)
  const anchorTop = anchor?.getBoundingClientRect().top
  const more = document.querySelector('[data-channel-more]')
  if (!more) return { skipped: true }
  more.click()
  await new Promise((r) => requestAnimationFrame(r))
  await new Promise((r) => setTimeout(r, 120))
  return {
    scrollTopDelta: sc.scrollTop - before,
    anchorMoved: anchor ? Math.round(anchor.getBoundingClientRect().top - anchorTop) : null,
  }
})
console.log('4c expanding a body — scrollTop delta:', drift.scrollTopDelta,
  '· the row you were reading moved:', drift.anchorMoved, 'px (expect 0 for a row ABOVE the expansion)')

// ---- 4d. The other chatter state, and the empty feed ------------------------------------
// The notice describes a PAUSE. Turning delivery on must retire it, or it becomes a permanent
// banner that contradicts the switch beside it.
const live = await (async () => {
  await p.locator('[data-chatter-toggle]').click()
  await p.waitForTimeout(800)
  const r = await p.evaluate(() => ({
    toggle: document.querySelector('[data-chatter-toggle]')?.textContent.trim(),
    banner: !!document.querySelector('[data-channel-paused-banner]'),
    rows: document.querySelectorAll('[data-channel-row]').length,
  }))
  await p.locator('[data-chatter-toggle]').click()
  await p.waitForTimeout(800)
  return r
})()
console.log('\n4d chatter LIVE:', JSON.stringify(live), '(expect banner false, rows unchanged)')

await p.screenshot({ path: `/tmp/operator-shots/channel-${MODE}.png` })
await p.evaluate(() => document.querySelector('.channel-scroll').scrollTo(0, 0))
await p.waitForTimeout(300)
await p.screenshot({ path: `/tmp/operator-shots/channel-${MODE}-top.png` })

// ---- 4d2. VERTICAL RHYTHM + DENSITY ------------------------------------------------------
// Air costs messages on screen, so the spacing pass has to be reported WITH its density cost.
// Entries-per-screen is counted at the default pane height, not inferred from the padding values.
const rhythm = await p.evaluate(() => {
  const px = (v) => Math.round(parseFloat(v) || 0)
  const sc = document.querySelector('.channel-scroll')
  const feed = document.querySelector('[data-channel-row]').parentElement
  const rowFirst = [...document.querySelectorAll('[data-channel-row]')].find((r) => !r.hasAttribute('data-channel-continuation'))
  const rowCont = document.querySelector('[data-channel-row][data-channel-continuation]')
  const day = document.querySelector('[data-channel-day]')?.parentElement
  const surf = document.querySelector('[data-channel-composer-surface]')
  const wrap = surf.parentElement
  const ta = document.querySelector('[data-channel-composer]')
  const actions = surf.lastElementChild
  const cs = (e) => getComputedStyle(e)
  // How many entries are fully on screen at rest.
  const view = sc.getBoundingClientRect()
  const visible = [...document.querySelectorAll('[data-channel-row]')]
    .filter((r) => { const b = r.getBoundingClientRect(); return b.top >= view.top - 1 && b.bottom <= view.bottom + 1 }).length
  return {
    feedTop: px(cs(feed).paddingTop), feedBottom: px(cs(feed).paddingBottom),
    rowTop: px(cs(rowFirst).paddingTop), rowBottom: px(cs(rowFirst).paddingBottom),
    contTop: rowCont ? px(cs(rowCont).paddingTop) : null,
    dayAbove: day ? px(cs(day).marginTop) : null, dayBelow: day ? px(cs(day).marginBottom) : null,
    composerAbove: px(cs(wrap).paddingTop), composerBelow: px(cs(wrap).paddingBottom),
    taBottom: px(cs(ta).paddingBottom), actionsBottom: px(cs(actions).paddingBottom),
    entriesVisible: visible, paneH: Math.round(view.height),
  }
})
console.log('\n4d2 vertical rhythm:', JSON.stringify(rhythm))

// ---- 4e. FULL-BLEED LAYOUT, at three widths ----------------------------------------------
// The 2000px case is the one that motivated this: a fixed centred column left ~1200px of dead
// page beside the conversation. What has to hold at every width is that the row BLEEDS while the
// paragraph does NOT, and that the header, the rows and the composer share one left edge.
console.log('\n4e layout at three pane widths:')
for (const w of [1000, 1440, 2100]) {
  await p.setViewportSize({ width: w, height: 900 })
  await p.waitForTimeout(500)
  const m = await p.evaluate(() => {
    const sc = document.querySelector('.channel-scroll')
    const pane = sc.getBoundingClientRect()
    const row = document.querySelector('[data-channel-row]')
    const body = document.querySelector('[data-channel-text]')
    // The header's FIRST child, not the `#` glyph. The shared-edge invariant is about where the
    // header's content begins; since the sidebar toggle landed it is the leading element and the
    // `#` sits after it, exactly as the title does in SessionToolbar.
    const hdrBox = document.querySelector('[data-toolbar-header="channel"]')
    const hdr = hdrBox ? hdrBox.firstElementChild : null
    // The composer's own outer edge. It used to BE the textarea; there is a container around it
    // now, and the shared-edge invariant is about where the composer starts, not where its text
    // does (which sits one border + one padding further in, as it did before).
    const comp = document.querySelector('[data-channel-composer-surface]')
    const cs = getComputedStyle(body)
    const c = document.createElement('canvas').getContext('2d')
    c.font = `${cs.fontSize} ${cs.fontFamily}`
    const avg = c.measureText('abcdefghijklmnopqrstuvwxyz ,.-/').width / 31
    const R = (e) => e.getBoundingClientRect()
    return {
      pane: Math.round(pane.width),
      // clientWidth, NOT the bounding rect: the scroller is `overflow-y: scroll` so it always
      // reserves a scrollbar gutter, and comparing a full-bleed row against the BORDER box makes
      // a correct row look ~6px short forever.
      content: sc.clientWidth,
      gutter: Math.round(pane.width) - sc.clientWidth,
      rowSpansPane: Math.round(R(row).width) === sc.clientWidth,
      bodyW: Math.round(R(body).width),
      chars: Math.round(R(body).width / avg),
      leftEdges: {
        header: hdr ? Math.round(R(hdr).left - pane.left) : null,
        rowContent: Math.round(R(row.firstElementChild).left - pane.left),
        composer: comp ? Math.round(R(comp).left - pane.left) : null,
      },
    }
  })
  const comp = await p.evaluate(() => {
    const sc = document.querySelector('.channel-scroll')
    const surf = document.querySelector('[data-channel-composer-surface]')
    const tgt = document.querySelector('[data-channel-send-target]')
    const snd = document.querySelector('[data-channel-send]')
    const R = (e) => e.getBoundingClientRect()
    return { w: Math.round(R(surf).width), h: Math.round(R(surf).height),
             targetToSend: Math.round(R(snd).left - R(tgt).right) }
  })
  console.log(`       composer ${String(comp.w).padStart(4)}px wide · ${comp.h}px tall · target→Send ${comp.targetToSend}px`)
  const e = m.leftEdges
  const shared = e.header === e.rowContent && e.rowContent === e.composer
  console.log(`  ${String(m.pane).padStart(4)}px pane (${m.content} content, ${m.gutter}px scrollbar) · row bleeds: ${m.rowSpansPane} · body ${m.bodyW}px = ${m.chars} chars` +
    ` · left edges h/r/c ${e.header}/${e.rowContent}/${e.composer} ${shared ? 'SHARED' : '<-- NOT SHARED'}`)
}
await p.setViewportSize({ width: 1400, height: 900 })
await p.waitForTimeout(400)

// ---- 4f. The hover action is reachable WITHOUT a pointer -------------------------------
// It is the feed's first interactive furniture. A control revealed only under a cursor is
// unreachable by keyboard, and the house rule forbids browser focus rings — so it needs both a
// real focus state and to still be in the tab order while hidden.
const focusable = await p.evaluate(() => {
  const btn = document.querySelector('[data-channel-copy]')
  if (!btn) return null
  const before = getComputedStyle(btn)
  // Hidden by OPACITY, deliberately: `visibility: hidden` would drop it from the tab order, which
  // is the bug this check exists to catch.
  const hiddenButPresent = before.opacity === '0' && btn.offsetParent !== null
  btn.focus()
  return new Promise((res) => setTimeout(() => {
  const after = getComputedStyle(btn)
  res({
    hiddenButPresent,
    visibleWhenFocused: after.visibility === 'visible',
    focusRing: after.boxShadow !== 'none',
    isActiveElement: document.activeElement === btn,
  })
  }, 80))
})
console.log('4f hover action, keyboard:', JSON.stringify(focusable))
console.log('4f …hidden at rest yet focusable, and shows a ring when focused:',
  !!focusable && focusable.hiddenButPresent && focusable.visibleWhenFocused && focusable.focusRing,
  '(expect true)')

// ---- 4g. Scroll must not drift on REFLOW ------------------------------------------------
// This pane is live and resizable — the Plan/Diff panel steals width from it — and a width change
// re-wraps every body. What the reader is looking at must not move.
const reflowBefore = await p.evaluate(async () => {
  const sc = document.querySelector('.channel-scroll')
  sc.scrollTop = Math.round(sc.scrollHeight * 0.45)
  await new Promise((r) => requestAnimationFrame(r))
  const rows = [...document.querySelectorAll('[data-channel-row]')]
  const anchor = rows.find((r) => r.getBoundingClientRect().top > sc.getBoundingClientRect().top)
  // Offset from the SCROLLER, not the viewport: the composer's height changes with width, which
  // moves the scroller's own box — a viewport-relative reading blames the anchor for that.
  return { id: anchor?.getAttribute('data-channel-row') ?? null,
           top: anchor ? Math.round(anchor.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null,
           scrollTop: Math.round(sc.scrollTop), scH: Math.round(sc.getBoundingClientRect().height),
           scrollH: sc.scrollHeight }
})
await p.setViewportSize({ width: 900, height: 900 })
await p.waitForTimeout(500)
const reflowAfter = await p.evaluate((id) => {
  const sc = document.querySelector('.channel-scroll')
  const el = document.querySelector(`[data-channel-row="${id}"]`)
  return { off: el ? Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null,
           scrollTop: Math.round(sc.scrollTop), scH: Math.round(sc.getBoundingClientRect().height),
           scrollH: sc.scrollHeight }
}, reflowBefore.id)
console.log('4g before:', JSON.stringify(reflowBefore))
console.log('4g after :', JSON.stringify(reflowAfter))
console.log('4g on a 1400 -> 900 reflow, the row you were reading moved:',
  reflowAfter?.off == null ? 'n/a' : `${reflowAfter.off - reflowBefore.top}px`)

// ---- 4h. Narrow pane — does the avatar column still earn its width? ---------------------
await p.setViewportSize({ width: 620, height: 900 })
// A generous settle: the clamped bodies are `-webkit-line-clamp` boxes, and WebKit reports a
// stale intrinsic scrollWidth for them for a frame or two after a width change. 500ms measured
// an overflow that a freshly-loaded 620px pane does not have.
await p.waitForTimeout(1400)
await p.evaluate(() => document.querySelector('.channel-scroll').scrollTop += 1)
await p.waitForTimeout(300)
console.log('4h at a 620px window:', JSON.stringify(await p.evaluate(() => {
  const sc = document.querySelector('.channel-scroll')
  const body = document.querySelector('[data-channel-text]')
  const cs = getComputedStyle(body)
  const c = document.createElement('canvas').getContext('2d')
  c.font = `${cs.fontSize} ${cs.fontFamily}`
  const avg = c.measureText('abcdefghijklmnopqrstuvwxyz ,.-/').width / 31
  return {
    content: sc.clientWidth,
    bodyW: Math.round(body.getBoundingClientRect().width),
    chars: Math.round(body.getBoundingClientRect().width / avg),
    scrollW: sc.scrollWidth,
    overflowsX: sc.scrollWidth > sc.clientWidth + 1,
    // By CONTENT, not by box: a clipped element whose TEXT overflows never shows up in a
    // bounding-rect check, which is why the first pass found "overflow with no offenders".
    offenders: (() => {
      const out = []
      sc.querySelectorAll('*').forEach((el) => {
        if (el.scrollWidth > el.clientWidth + 1) {
          out.push(([...el.attributes].map((a) => a.name).find((n) => n.startsWith('data-')) || el.tagName)
            + ` ${el.scrollWidth}>${el.clientWidth}`)
        }
      })
      return out.slice(0, 6)
    })(),
  }
})))
await p.setViewportSize({ width: 1400, height: 900 })
await p.waitForTimeout(400)


// ---- 5. Every palette --------------------------------------------------------------------
// The three light palettes are where a tint or a mixed ink collapses, so the new surfaces —
// the inline code chip, the warn chips, the paused banner — are measured rather than assumed.
// WebKit hands back color-mix as `color(srgb ...)` floats and plain tokens as rgb() 0-255;
// parsing both as 0-255 reports every mixed colour as near-black.
const THEMES = ['mission-control-dark', 'mission-control-light', 'mr-pink-dark', 'mr-pink-light', '1984-dark', '1984-light']
const chan = (c) => { const n = c.match(/[\d.]+/g).slice(0, 3).map(Number); return c.startsWith('color(') ? n : n.map((v) => v / 255) }
const lum = (c) => { const [r, g, bl] = chan(c).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl }
const ratio = (a, bg) => { const [x, y] = [lum(a), lum(bg)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
// A code chip and the banner are BOTH translucent washes over the feed, so the ink has to be
// measured against the composite, not against the token.
const over = (fg, bg) => { const f = chan(fg), b2 = chan(bg); const a = (fg.match(/[\d.]+/g) || []).length > 3 ? Number(fg.match(/[\d.]+/g)[3]) : 1; return `color(srgb ${f.map((v, i) => v * a + b2[i] * (1 - a)).join(' ')})` }

console.log('\n5 new surfaces, every palette (3:1 floor for chips, 4.5:1 for the banner sentence):')
console.log('  theme                  code   warn   banner')
for (const theme of THEMES) {
  const pg = await ctx.newPage()
  await pg.addInitScript((t) => { try { localStorage.setItem('operator.theme', t) } catch { /* quota */ } }, theme)
  await pg.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await pg.waitForTimeout(3200)
  await pg.locator('[data-channel-nav]').click()
  await pg.waitForTimeout(900)
  const m = await pg.evaluate(() => {
    const code = document.querySelector('[data-channel-code]')
    const warn = Array.from(document.querySelectorAll('[data-channel-chip]')).find((e) => e.textContent.includes('held') || e.textContent.includes('paused'))
    const ban = document.querySelector('[data-channel-paused-banner]')
    // The scroller paints nothing of its own — the field comes from the panel behind it — so
    // reading backgroundColor off it yields transparent, and substituting a guess turns every
    // light palette into a false failure. Resolve the token itself.
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    probe.style.color = 'var(--bg-terminal)'
    const feedBg = getComputedStyle(probe).color
    probe.remove()
    return {
      feedBg,
      codeInk: code ? getComputedStyle(code).color : null,
      codeBg: code ? getComputedStyle(code).backgroundColor : null,
      warnInk: warn ? getComputedStyle(warn).color : null,
      banInk: ban ? getComputedStyle(ban.querySelector('span')).color : null,
      banBg: ban ? getComputedStyle(ban).backgroundColor : null,
    }
  })
  const feed = m.feedBg
  const codeR = m.codeInk ? ratio(m.codeInk, over(m.codeBg, feed)) : NaN
  const warnR = m.warnInk ? ratio(m.warnInk, feed) : NaN
  const banR = m.banInk ? ratio(m.banInk, over(m.banBg, feed)) : NaN
  const bad = [codeR < 3 && 'code', warnR < 3 && 'warn', banR < 4.5 && 'banner'].filter(Boolean)
  console.log(`  ${theme.padEnd(22)} ${codeR.toFixed(2).padEnd(6)} ${warnR.toFixed(2).padEnd(6)} ${banR.toFixed(2).padEnd(6)}` +
    (bad.length ? `  <-- UNDER FLOOR: ${bad.join(', ')}` : ''))
  await pg.screenshot({ path: `/tmp/operator-shots/channel-${theme}.png` })
  await pg.close()
}

await b.close()
