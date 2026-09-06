// MEASURE THE TUNING PAGE, rather than look at a picture of it.
//
// `tsc` proves it compiles and `scripts/visual/capture.mjs --page tuning` proves it draws, but an
// element screenshot frames the PageShell scroller's viewport, so it shows the top half and says
// nothing about what is below. This reads the DOM instead: every section's real box, and the
// stacked project bar's segment widths against its parent.
//
// Two things it is built to catch, both of which fooled me first:
//   · a section heading present in the DOM while its box has collapsed to nothing inside its
//     slot — the exact failure `chrome.test.ts` guards, and invisible in a screenshot;
//   · a case-sensitive text match against `innerText`, which in WebKit returns the RENDERED text,
//     so `text-transform: uppercase` makes it test the CSS rather than the content.
//
// Run: node dev/measure-tuning.mjs   (boots its own Vite on 1427; needs no app)
import { spawn } from 'node:child_process'
import { webkit } from 'playwright'
const PORT = 1427
const vite = spawn('npm', ['run', 'dev'], { env: { ...process.env, OPERATOR_DEV_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
const wait = async () => { for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://localhost:${PORT}/scripts/visual/tuning.html`); if (r.ok) return } catch {} await new Promise(r => setTimeout(r, 500)) } throw new Error('no server') }
try {
  await wait()
  const b = await webkit.launch()
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
  p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/scripts/visual/tuning.html`, { waitUntil: 'load' })
  await p.waitForFunction('window.__visualReady === true', { timeout: 20000 })
  const out = await p.evaluate(() => {
    // CASE-INSENSITIVE: the section headings are `text-transform: uppercase`, and `innerText`
    // returns the RENDERED text in WebKit, so a case-sensitive match tests the CSS, not the DOM.
    const text = document.body.innerText.toLowerCase()
    const sections = ['Biggest single change', 'Spend by lane', 'Project share of the window', 'Context pressure', 'Tool output', 'Cache']
      .map((s) => [s, text.includes(s.toLowerCase())])
    // EVERY SECTION'S REAL BOX. A heading in the DOM proves nothing about layout — the failure
    // `chrome.test.ts` guards is a surface that renders with zero usable height inside its slot.
    const headings = Array.from(document.querySelectorAll('h3')).map((h) => {
      const sec = h.parentElement
      const r = sec.getBoundingClientRect()
      return { name: h.textContent, h: Math.round(r.height), rows: sec.querySelectorAll('div').length }
    })
    // The stacked project bar: its segments' real widths.
    const bars = Array.from(document.querySelectorAll('div[title]')).filter((d) => /—/.test(d.title || ''))
    const seg = bars.map((d) => ({ title: d.title, w: Math.round(d.getBoundingClientRect().width) }))
    const parent = bars[0]?.parentElement
    return {
      sections, headings,
      barParentWidth: parent ? Math.round(parent.getBoundingClientRect().width) : null,
      segments: seg,
      bodyScrollHeight: document.body.scrollHeight,
      rootHeight: Math.round(document.getElementById('tuning').getBoundingClientRect().height),
    }
  })
  console.log(JSON.stringify(out, null, 1))
  await b.close()
} finally { vite.kill('SIGTERM') }
