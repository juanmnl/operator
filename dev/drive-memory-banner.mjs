// Drive the memory-pressure banner in an isolated Electron dev build, by faking the kernel level.
//
// Start the dev build with a fake level file and an isolated OPERATOR_DIR, e.g. from electron/:
//   printf '1\n60\n' > /tmp/x/pressure
//   OPERATOR_DIR=/tmp/x/operator-dir OPERATOR_MEMORY_PRESSURE_FILE=/tmp/x/pressure \
//     OPERATOR_ELECTRON_PORT=1425 OPERATOR_CDP_PORT=9345 npm run dev
// then: PRESSURE_FILE=/tmp/x/pressure OUT=/tmp/x/shots node dev/drive-memory-banner.mjs
//
// For each theme mode: level 1 (no banner), 2 (warn), 4 (critical), dismiss at 4, back to 1, and
// 2 again (shown after the new rise). Main polls every 20 s at normal and 5 s above it, so a rise
// from 1 takes up to 20 s to show.
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const CDP = process.env.OPERATOR_CDP_PORT || 9345
const FILE = process.env.PRESSURE_FILE
const OUT = process.env.OUT || '.'
if (!FILE) throw new Error('PRESSURE_FILE is required')
mkdirSync(OUT, { recursive: true })

const browser = await chromium.connectOverCDP(`http://localhost:${CDP}`)
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'))
if (!page) throw new Error('no Operator window found over CDP')

const setLevel = (level, free) => writeFileSync(FILE, `${level}\n${free}\n`)
const banner = () => page.$('[data-memory-banner]')

async function waitFor(pred, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return true
    await page.waitForTimeout(500)
  }
  return false
}

const results = []
const note = (what, ok) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); console.log(results.at(-1)) }

for (const mode of ['dark', 'light']) {
  // The theme toggle is not on screen in every mode; set the stored theme and reload instead.
  await page.evaluate((m) => {
    const cur = localStorage.getItem('operator.theme') || 'mission-control-dark'
    localStorage.setItem('operator.theme', cur.replace(/-(dark|light)$/, '') + '-' + m)
  }, mode)
  await page.reload()
  await page.waitForTimeout(2_000)

  setLevel(1, 60)
  note(`${mode}: hidden at level 1`, await waitFor(async () => !(await banner())))

  setLevel(2, 14)
  note(`${mode}: shown at level 2`, await waitFor(async () => (await banner()) && (await page.getAttribute('[data-memory-banner]', 'data-memory-banner')) === '2'))
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(OUT, `memory-banner-${mode}-warn.png`) })
  console.log('     text:', JSON.stringify(await page.textContent('[data-memory-banner]')))

  setLevel(4, 4)
  note(`${mode}: critical at level 4`, await waitFor(async () => (await page.getAttribute('[data-memory-banner]', 'data-memory-banner').catch(() => null)) === '4'))
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(OUT, `memory-banner-${mode}-critical.png`) })
  console.log('     text:', JSON.stringify(await page.textContent('[data-memory-banner]')))

  await page.click('[data-memory-banner] [aria-label="Dismiss"]')
  note(`${mode}: dismissed`, await waitFor(async () => !(await banner()), 3_000))
  setLevel(2, 12)
  await page.waitForTimeout(7_000)
  note(`${mode}: stays dismissed going 4 to 2`, !(await banner()))

  setLevel(1, 60)
  await page.waitForTimeout(7_000)
  setLevel(2, 14)
  note(`${mode}: shown again after a new rise from 1`, await waitFor(async () => !!(await banner())))
  setLevel(1, 60)
  note(`${mode}: gone at 1`, await waitFor(async () => !(await banner())))
}

writeFileSync(join(OUT, 'results.txt'), results.join('\n') + '\n')
await browser.close()
