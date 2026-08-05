// Drive the Preview panel's URL bar — dev/briefs/preview-url-navigate-to-a-page.md.
//
// The parse itself is unit-tested (lib/preview-port.test.ts). What can only be checked here is the
// CONTROL: that clicking the host hands you what you were looking at instead of a blank field,
// that a path typed on the end actually navigates, that clearing still un-pins, and — the one that
// would ship silently — that opening the editor and blurring without typing pins NOTHING.
//
// That last one is the whole risk of this change. The field used to open empty, so committing on
// blur was harmless; prefilled, an unedited blur would nail a session that FOLLOWS its own dev
// server to whatever port it happened to be on, with no visible difference until the port moved.
//
// The fixture's `code` lane serves on 1421 + 5173 with 1421 reserved, so the preview auto-resolves
// to localhost:1421 with NOTHING pinned — which is exactly the state the bug lived in.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-preview-url.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))

const bar = () => p.evaluate(() => {
  const host = document.querySelector('[data-preview-host]')
  const input = document.querySelector('[data-preview-url]')
  return {
    // The collapsed button: host + path, plus its `·pinned` marker when an override is set.
    host: host ? host.textContent.trim() : null,
    pinned: host ? host.textContent.includes('pinned') : null,
    editing: !!input,
    value: input ? input.value : null,
    // What is actually loaded, which is the only proof it navigated.
    frame: document.querySelector('iframe[title="App preview"]')?.getAttribute('src') ?? null,
    stored: (() => { try { return localStorage.getItem('operator.preview.port.main-s-code') } catch { return null } })(),
  }
})
// The host label carries its ·pinned suffix; compare against the URL part alone.
const hostOnly = (s) => (s ?? '').replace(/\s*·pinned\s*$/, '').replace(/\s*●\s*/, '').trim()

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(900)
await p.locator('button[title="Preview view"]').click()
await p.waitForTimeout(1200)

// ---- 1. At rest: auto-resolved, nothing pinned -----------------------------------------
const s1 = await bar()
console.log('1 at rest:', JSON.stringify(s1))
console.log('1 auto-resolved to the reserved port:', hostOnly(s1.host) === 'localhost:1421', '(expect true)')
console.log('1 …and NOTHING is pinned:', s1.pinned === false && s1.stored === null, '(expect true — this is the state the bug lived in)')

// ---- 2. Clicking the host opens the editor HOLDING what is on screen --------------------
// The defect: `defaultValue={override ?? ''}` and `override` is null whenever the preview
// auto-resolved — so this used to hand you a blank 90px field. That was the "click and clear".
await p.locator('[data-preview-host]').click()
await p.waitForTimeout(250)
const s2 = await bar()
console.log('2 editor opened with:', JSON.stringify(s2.value), '(expect "localhost:1421", NOT "")')
console.log('2 it is what the button said:', s2.value === hostOnly(s1.host), '(expect true)')
console.log('2 selected for wholesale replacement:', await p.evaluate(() => {
  const i = document.querySelector('[data-preview-url]')
  return i.selectionStart === 0 && i.selectionEnd === i.value.length
}), '(expect true — one gesture to replace, since the field is no longer empty)')
console.log('2 wide enough for a path:', await p.evaluate(() =>
  Math.round(document.querySelector('[data-preview-url]').getBoundingClientRect().width)), '(was 90; needs ~localhost:1432/docs/intro)')
console.log('2 the 30px toolbar row did not move:', await p.evaluate(() =>
  Math.round(document.querySelector('[data-preview-url]').closest('div').getBoundingClientRect().height)), '(expect 30)')

// ---- 3. THE TRAP: blurring without editing must pin nothing -----------------------------
await p.locator('iframe[title="App preview"], [data-preview-host]').first().click({ force: true }).catch(() => {})
await p.evaluate(() => document.querySelector('[data-preview-url]')?.blur())
await p.waitForTimeout(400)
const s3 = await bar()
console.log('3 after an UNEDITED blur:', JSON.stringify({ host: s3.host, pinned: s3.pinned, stored: s3.stored, editing: s3.editing }))
console.log('3 nothing was pinned:', s3.pinned === false && s3.stored === null, '(expect true — the prefill must not commit itself)')
console.log('3 …and the session still FOLLOWS its own server:', hostOnly(s3.host) === 'localhost:1421', '(expect true)')

// ---- 4. Type a path on the end and land on it -------------------------------------------
// The second defect: `/settings` matched no branch of the old parse, so `next` stayed null and
// typing a page actively UN-PINNED the preview.
await p.locator('[data-preview-host]').click()
await p.waitForTimeout(200)
await p.locator('[data-preview-url]').press('End')   // clear the select-all, keep the prefill
await p.locator('[data-preview-url]').type('/settings')
await p.locator('[data-preview-url]').press('Enter')
await p.waitForTimeout(1200)
const s4 = await bar()
console.log('4 after typing /settings:', JSON.stringify({ host: s4.host, stored: s4.stored, frame: s4.frame }))
console.log('4 the bar shows the page:', hostOnly(s4.host) === 'localhost:1421/settings', '(expect true)')
console.log('4 it is PINNED and stored as a full URL:', s4.stored === 'http://localhost:1421/settings', '(expect true)')
console.log('4 …and overrideUrl passed it through unchanged (no localhost: prefix bug):',
  !!s4.stored && !/localhost:http/.test(s4.stored), '(expect true)')

// ---- 5. A stale stored pin with a path still loads ---------------------------------------
await p.reload({ waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(900)
await p.locator('button[title="Preview view"]').click()
await p.waitForTimeout(1000)
const s5 = await bar()
console.log('5 a pinned PATH survives a reload:', hostOnly(s5.host) === 'localhost:1421/settings' && s5.pinned, JSON.stringify(s5.host))
// `displayPort` comes from portOf(display), and display now carries a path. If portOf stopped
// finding the port through it, the picker would mark NOTHING — so this is that check, by ink:
// exactly one of the two ports is accented, and it is the one on screen.
console.log('5 the picker still marks the live port through the path:', await p.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button')).filter((x) => /^:\d+$/.test(x.textContent.trim()))
  const ink = btns.map((x) => ({ port: x.textContent.trim(), color: getComputedStyle(x).color }))
  const distinct = [...new Set(ink.map((i) => i.color))]
  // The accented one is whichever colour is not shared by the rest.
  const odd = distinct.find((c) => ink.filter((i) => i.color === c).length === 1)
  return { ports: ink.map((i) => i.port), marked: ink.find((i) => i.color === odd)?.port ?? null }
}), '(expect ports [:1421,:5173], marked :1421)')

// ---- 6. Escape cancels outright ----------------------------------------------------------
await p.locator('[data-preview-host]').click()
await p.waitForTimeout(200)
await p.locator('[data-preview-url]').fill('9999')
await p.locator('[data-preview-url]').press('Escape')
await p.waitForTimeout(400)
const s6 = await bar()
console.log('6 Escape cancelled:', !s6.editing && hostOnly(s6.host) === 'localhost:1421/settings' && s6.stored === 'http://localhost:1421/settings', '(expect true)')

// ---- 7. Clearing UN-PINS, back to auto-resolution -----------------------------------------
// The only way back to "follow whatever this session is serving". It has to survive the prefill.
await p.locator('[data-preview-host]').click()
await p.waitForTimeout(200)
await p.locator('[data-preview-url]').fill('')
await p.locator('[data-preview-url]').press('Enter')
await p.waitForTimeout(1200)
const s7 = await bar()
console.log('7 after clearing:', JSON.stringify({ host: s7.host, pinned: s7.pinned, stored: s7.stored }))
console.log('7 un-pinned and following the session again:',
  s7.pinned === false && s7.stored === null && hostOnly(s7.host) === 'localhost:1421', '(expect true)')

// ---- 8. A bare port still works (the multi-server picker commits one) ----------------------
await p.locator('[data-preview-host]').click()
await p.waitForTimeout(200)
await p.locator('[data-preview-url]').fill('5173')
await p.locator('[data-preview-url]').press('Enter')
await p.waitForTimeout(1000)
const s8 = await bar()
console.log('8 a bare port pins as a port:', JSON.stringify({ host: hostOnly(s8.host), stored: s8.stored }), '(expect localhost:5173 / "5173")')

await p.screenshot({ path: '/tmp/operator-shots/preview-url.png' })
await b.close()
