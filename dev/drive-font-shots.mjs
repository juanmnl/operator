// Before/after screenshots for the vendored UI typefaces — dev/briefs/landing-look-and-feel.md.
//
// "Before" is produced by ABORTING the two woff2 requests, which reproduces the app's actual
// state for its whole life so far (declared families, nothing loaded, silent fallback to
// system-ui / SF Mono) rather than approximating it by editing the CSS. The symbol fonts are
// left alone — they always loaded.
//
// Run: `./node_modules/.bin/vite --port 1436 --strictPort` then `node dev/drive-font-shots.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1436
const OUT = '/tmp/operator-shots'

const SURFACES = [
  { key: 'session', go: async () => {} },
  { key: 'agents', go: async (p) => { await p.locator('[data-rail-agents]').click().catch(() => {}) } },
  { key: 'gallery', go: async (p) => { await p.locator('[data-rail-gallery]').click().catch(() => {}) } },
]

for (const withFonts of [true, false]) {
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  const p = await ctx.newPage()
  if (!withFonts) {
    await p.route('**/*.woff2', (r) => (/archivo|jetbrains/i.test(r.request().url()) ? r.abort() : r.continue()))
  }
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(4000)
  const tag = withFonts ? 'after' : 'before'
  for (const s of SURFACES) {
    await s.go(p)
    await p.waitForTimeout(900)
    await p.screenshot({ path: `${OUT}/fonts-${tag}-${s.key}.png` })
  }
  // `getComputedStyle().fontFamily` returns the DECLARED stack and says nothing about what
  // actually rendered — it reads 'Archivo' either way, which is precisely how a never-loaded
  // family stayed invisible for this long. `document.fonts.check` is the honest question.
  const real = await p.evaluate(() => ({
    archivo: document.fonts.check('600 13px Archivo'),
    jb: document.fonts.check('500 11px "JetBrains Mono"'),
  }))
  console.log(`${tag.padEnd(6)} Archivo available: ${String(real.archivo).padEnd(5)} JetBrains Mono: ${real.jb}`)
  await b.close()
}
console.log(`\nshots → ${OUT}/fonts-{before,after}-{channel,session,agents,gallery}.png`)
