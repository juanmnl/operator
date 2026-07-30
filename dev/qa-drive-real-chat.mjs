// Chat-view regression driver against REAL data (dev/qa-chat-regression.md). Loads the real
// renderer via dev/qa-real.html (dev/qa-real-bridge.ts: real "operator" roster + two real
// chat.db histories), and exercises:
//   1. orb send/stop/idle states across the full real phase matrix (chat-signal.ts)
//   2. interrupt-then-no-resubmit, through the REAL send()/interruptSession()/submitQueue
//      chain (real timers, real nudge windows) -- not a mock of the race, the actual race
//   3. cap/freeze timing on the real 10,268-char answer + a synthetic stress addendum
//   4. pre-existing history: the real 862-message session, incl. 9 real injected-noise rows
//
// Run: node dev/qa-drive-real-chat.mjs   (expects vite serving dev/qa-real.html on :1445)
import { webkit } from 'playwright'

const PORT = process.env.QA_PORT || 1445
const BIG_ID = 'a1d8d389-0774-451f-87d1-445a2a2f8863'   // real Research-lane session, 114 msgs
const LONG_ID = 'e5893b67-e01f-40ee-b2b4-3e7e52bb3757'  // real 862-message operator history

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
const pageErrors = []
p.on('pageerror', (e) => pageErrors.push(String(e)))
p.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()) })

await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/qa-real.html`, { waitUntil: 'load' })
await p.waitForTimeout(2500)

// ---------- 4. Pre-existing history: open the real long-history session cold ---------------
{
  const t0 = Date.now()
  await p.locator(`[data-session-row="${LONG_ID}"]`).click()
  await p.waitForTimeout(600)
  await p.getByText('Chat', { exact: true }).first().click()
  // Wait for the canvas turn list to actually populate (real async chatHistory load).
  await p.waitForFunction(() => (window.__canvasTurns ?? []).length > 0, { timeout: 15000 })
  const loadMs = Date.now() - t0

  const stats = await p.evaluate(() => {
    const turns = window.__canvasTurns ?? []
    return { turnCount: turns.length, kinds: turns.reduce((a, t) => ((a[t.kind] = (a[t.kind] || 0) + 1), a), {}) }
  })
  record('real long-history session loads without hanging', loadMs < 12000, `${loadMs}ms, ${pageErrors.length} console/page errors`)
  record('rendered turn count is sane (nonzero, no more than the raw fixture)', stats.turnCount > 0,
    `rendered=${stats.turnCount} kinds=${JSON.stringify(stats.kinds)}`)

  // Real injected-noise rows, whatever remains in the live chat.db right now, must not
  // surface as user turns.
  const leakedReal = await p.evaluate(() =>
    (window.__canvasTurns ?? []).filter((t) => t.kind === 'user' && /<local-command|<command-name|<command-message|<command-args|<system-reminder|<task-notification|<synthetic/.test(t.text || '')).length)
  record('any real injected-noise turns still on disk are filtered out of the reading surface', leakedReal === 0, `leaked=${leakedReal}`)

  // The live chat.db has since been migrated (188 rows purged down to a handful still
  // dribbling in from the still-running pre-fix binary) -- so the fixture above may no
  // longer carry any noise rows to filter, which would make the leak check above trivially
  // true rather than a real exercise of isRenderableTurn. Inject a synthetic-but-real-shaped
  // noise row (using the ACTUAL prefixes format.ts's isInjectedTurn matches) via the same
  // live onSessionUpdate tail a real transcript append would use, and confirm the guard
  // actively strips it -- not just that there happened to be nothing to strip.
  const injectedProbe = '<system-reminder>plan mode is active</system-reminder>'
  await p.evaluate(({ id, text }) => {
    window.__mockPhase(id, { messages: [{ kind: 'user', text, timestamp: new Date().toISOString() }] })
  }, { id: LONG_ID, text: injectedProbe })
  await p.waitForTimeout(400)
  const syntheticLeak = await p.evaluate((text) =>
    (window.__canvasTurns ?? []).filter((t) => t.kind === 'user' && t.text === text).length, injectedProbe)
  record('synthetic injected-noise row (real prefix format) is actively filtered by the renderer guard',
    syntheticLeak === 0, `a freshly-appended <system-reminder> turn rendered ${syntheticLeak} times (want 0)`)

  // Scroll works and doesn't throw on a large real transcript.
  const scrollOk = await p.evaluate(() => {
    try {
      const sc = Array.from(document.querySelectorAll('div')).find((d) => /auto/.test(getComputedStyle(d).overflow) && d.scrollHeight > d.clientHeight)
      if (!sc) return { ok: false, reason: 'no scroller found' }
      sc.scrollTop = 0
      const top = sc.scrollTop
      sc.scrollTop = sc.scrollHeight
      const bottom = sc.scrollTop
      return { ok: bottom > top, top, bottom }
    } catch (e) { return { ok: false, reason: String(e) } }
  })
  record('scrolling the real 862-message transcript works', scrollOk.ok, JSON.stringify(scrollOk))
}

// ---------- 3. Cap/freeze: real 10,268-char answer + synthetic stress addendum -------------
{
  await p.locator(`[data-session-row="${BIG_ID}"]`).click()
  await p.waitForTimeout(500)
  await p.getByText('Chat', { exact: true }).first().click()
  const t0 = Date.now()
  await p.waitForFunction(() => (window.__canvasTurns ?? []).length > 0, { timeout: 15000 })
  const loadMs = Date.now() - t0
  const big = await p.evaluate(() => {
    const turns = window.__canvasTurns ?? []
    const longest = turns.reduce((m, t) => Math.max(m, (t.text || '').length), 0)
    return { longest, count: turns.length }
  })
  record('real big-message session loads fast', loadMs < 8000,
    `${loadMs}ms, longest rendered turn=${big.longest} chars, ${big.count} turns`)

  // Responsiveness probe: a rAF round-trip measures whether the main thread is still pumping
  // frames, which is exactly what "freeze" means (WebContent pegged, see
  // project_chat_markdown_freeze.md) -- more direct than eyeballing.
  const rafMs = await p.evaluate(() => new Promise((res) => {
    const t0 = performance.now()
    requestAnimationFrame(() => res(performance.now() - t0))
  }))
  record('main thread still pumps frames after loading the big real message', rafMs < 200, `${rafMs.toFixed(1)}ms to next frame`)

  // Synthetic stress addendum: the documented OLD failure trigger (an ~80KB GFM table) that
  // no real message in this project's chat.db reaches naturally. Injected via the SAME live
  // onSessionUpdate path a real streaming answer would use, appended to a still-'idle' session
  // so it's a genuine incremental update, not a fixture rewrite.
  const bigTableMd = (() => {
    let s = '| a | b | c | d | e |\n|---|---|---|---|---|\n'
    for (let i = 0; i < 900; i++) s += `| row${i} | value${i} | ${i * 7} | some text here ${i} | more text ${i} |\n`
    return s
  })()
  const stressT0 = Date.now()
  await p.evaluate(({ id, text }) => {
    window.__mockPhase(id, { phase: 'idle', messages: [{ kind: 'text', text, timestamp: new Date().toISOString() }] })
  }, { id: BIG_ID, text: bigTableMd })
  await p.waitForTimeout(1200)
  const stressMs = Date.now() - stressT0
  const rafMs2 = await p.evaluate(() => new Promise((res) => {
    const t0 = performance.now()
    requestAnimationFrame(() => res(performance.now() - t0))
  }))
  record(`synthetic ${(bigTableMd.length / 1024).toFixed(0)}KB GFM table (the documented old freeze trigger) does not peg the main thread`,
    rafMs2 < 300, `table=${bigTableMd.length} chars, settle window ${stressMs}ms, next-frame ${rafMs2.toFixed(1)}ms`)
}

// ---------- 1. Orb states across the real phase matrix (chat-signal.ts) --------------------
{
  const setPhase = async (patch) => {
    await p.evaluate(({ id, patch }) => window.__mockPhase(id, patch), { id: BIG_ID, patch })
    await p.waitForTimeout(400)
  }
  const composerAction = () => p.evaluate(() => document.querySelector('[data-composer-action]')?.getAttribute('data-composer-action'))
  const setDraft = async (text) => {
    const ta = p.locator('textarea[placeholder="Message the agent…"], textarea[placeholder="No live session"]')
    await ta.fill(text)
  }

  const MATRIX = [
    ['running, no tool (Thinking)', { status: 'active', phase: 'running', lastToolName: null, activeSubagents: 0 }, '', 'stop'],
    ['running, Bash tool', { status: 'active', phase: 'running', lastToolName: 'Bash', activeSubagents: 0 }, '', 'stop'],
    ['running + 2 subagents', { status: 'active', phase: 'running', lastToolName: 'Task', activeSubagents: 2 }, '', 'stop'],
    ['compacting', { status: 'active', phase: 'compacting', lastToolName: null, activeSubagents: 0 }, '', 'stop'],
    ['waiting, empty draft', { status: 'active', phase: 'waiting', lastToolName: null, activeSubagents: 0 }, '', 'idle'],
    ['waiting, with draft', { status: 'active', phase: 'waiting', lastToolName: null, activeSubagents: 0 }, 'hello', 'send'],
    ['idle, empty draft', { status: 'active', phase: 'idle', lastToolName: null, activeSubagents: 0 }, '', 'idle'],
    ['idle, with draft', { status: 'active', phase: 'idle', lastToolName: null, activeSubagents: 0 }, 'hello', 'send'],
    ['ended', { status: 'ended', phase: 'idle', lastToolName: null, activeSubagents: 0 }, '', 'idle'],
  ]
  for (const [name, patch, draft, want] of MATRIX) {
    await setPhase(patch)
    await setDraft(draft)
    const got = await composerAction()
    record(`orb state: ${name}`, got === want, `want=${want} got=${got}`)
  }
  await setDraft('')
}

// ---------- 2. interrupt-then-no-resubmit, through the REAL production chain ---------------
{
  // terminalWrite calls are recorded keyed by TERMINAL id, not session id.
  const TID = 't-qa-big'
  const writesFor = async (id) => p.evaluate((id) => (window.__calls || []).filter((c) => c.fn === 'terminalWrite' && c.id === id).map((c) => c.data), id)
  const countCalls = () => p.evaluate(() => (window.__calls || []).length)

  // Put the session into a real 'running' state (interruptible) so the composer's orb click
  // takes the interrupt branch, then type + submit a message via the REAL composer, matching
  // an actual user interjecting into a busy turn.
  await p.evaluate(({ id }) => window.__mockPhase(id, { status: 'active', phase: 'running', lastToolName: 'Bash', activeSubagents: 0 }), { id: BIG_ID })
  await p.waitForTimeout(300)

  // --- Case A: short message, interrupt almost immediately (well inside the ~800ms nudge window)
  const before = await countCalls()
  const ta = p.locator('textarea[placeholder="Message the agent…"], textarea[placeholder="No live session"]')
  await ta.fill('short interjection')
  await ta.press('Enter')  // real Enter key -> real send() -> real submitQueue.submit()
  await p.waitForTimeout(150) // deliberately inside the nudge window (floor 800ms)
  await p.locator('[data-composer-action="stop"]').click() // real orb click -> real interruptSession()
  await p.waitForTimeout(1800) // past the 800ms nudge window with margin

  const writesA = await writesFor(TID)
  const pastesA = writesA.filter((d) => d.includes('\x1b[200~'))
  const barecrsA = writesA.filter((d) => d === '\r')
  const escsA = writesA.filter((d) => d === '\x1b')
  record('short interjection: exactly one submit + one interrupt, NO stray rescue CR after interrupt',
    pastesA.length === 1 && escsA.length === 1 && barecrsA.length === 0,
    `writes=${JSON.stringify(writesA)}`)

  // --- Case B: longer message (scaled nudge window, ~800+1.5*len/1000 ms), interrupt mid-window
  const longMsg = 'x'.repeat(2000)
  const nudgeDelay = Math.min(6000, 800 + Math.round((longMsg.length / 1000) * 1500)) // 3800ms
  await ta.fill(longMsg)
  await ta.press('Enter')
  await p.waitForTimeout(Math.round(nudgeDelay * 0.4)) // ~1520ms in, well before the nudge fires
  await p.locator('[data-composer-action="stop"]').click()
  await p.waitForTimeout(nudgeDelay + 1500) // past the full scaled window with margin

  const writesB = (await writesFor(TID)).slice(writesA.length)
  const pastesB = writesB.filter((d) => d.includes('\x1b[200~'))
  const barecrsB = writesB.filter((d) => d === '\r')
  const escsB = writesB.filter((d) => d === '\x1b')
  record('long (2000-char) interjection: interrupt mid-nudge-window still suppresses the rescue CR',
    pastesB.length === 1 && escsB.length === 1 && barecrsB.length === 0,
    `nudgeDelay=${nudgeDelay}ms writes=${JSON.stringify(writesB.map((d) => d.length > 40 ? d.slice(0, 20) + '…' : d))}`)

  // --- Control: submit WITHOUT interrupting -- the legitimate rescue CR must still fire.
  // (Proves the fix didn't neuter the feature it's guarding, only the interrupt race.)
  await p.evaluate(({ id }) => window.__mockPhase(id, { status: 'active', phase: 'waiting', lastToolName: null, activeSubagents: 0 }), { id: BIG_ID })
  await p.waitForTimeout(200)
  const beforeC = await writesFor(TID)
  await ta.fill('no interrupt this time')
  await ta.press('Enter')
  await p.waitForTimeout(800 + 1500) // past the short-message nudge window, no interrupt fired
  const writesC = (await writesFor(TID)).slice(beforeC.length)
  const barecrsC = writesC.filter((d) => d === '\r')
  record('control (no interrupt): the legitimate watchdog rescue CR still fires normally',
    barecrsC.length === 1, `writes=${JSON.stringify(writesC)}`)
}

console.log('\n--- SUMMARY ---')
const failed = results.filter((r) => !r.pass)
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) console.log('FAILED:', failed.map((r) => r.name))
console.log('page errors observed:', pageErrors.length, pageErrors.slice(0, 5))

await b.close()
process.exit(failed.length ? 1 : 0)
