// DOES LOWERING `scrollback` ACTUALLY RECLAIM MEMORY? (2026-08-04)
//
// The renderer-crash fix rests on one assumption: setting `term.options.scrollback` DOWN on a
// hidden pane discards the lines beyond the new limit. If xterm instead only capped FUTURE
// growth, the fix would do nothing for the case that crashes — eight lanes that have already
// filled 10k lines each — while still costing history. That is the difference between a fix and
// a placebo, and it is not something to take on faith from a docs sentence.
//
// So: build a real Terminal, fill it past the cap, lower the cap, and read the buffer back.
//
// Run: `npx vite --port 1441 --strictPort` then `MOCK_PORT=1441 node dev/drive-scrollback-trim.mjs`
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1441
let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1200, height: 800 } })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2000)

const result = await p.evaluate(async () => {
  // `.mjs` is the ESM build (package.json `module`); the `.js` one is UMD and yields no
  // named export through a dynamic import.
  const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs')
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-9999px;width:800px;height:400px'
  document.body.appendChild(host)

  const term = new Terminal({ scrollback: 10000, allowProposedApi: true })
  term.open(host)

  // Fill well past the eventual cap. 6,000 lines is enough to prove trimming without making
  // the write itself the slow part.
  const lines = 6000
  await new Promise((res) => term.write(Array.from({ length: lines }, (_, i) => `line ${i}`).join('\r\n') + '\r\n', res))
  const before = term.buffer.active.length

  term.options.scrollback = 2000
  await new Promise((res) => setTimeout(res, 100))
  const after = term.buffer.active.length

  // And that it still works afterwards — a trimmed terminal must keep accepting output.
  await new Promise((res) => term.write('still alive\r\n', res))
  const afterWrite = term.buffer.active.length

  term.dispose()
  host.remove()
  return { before, after, afterWrite, rows: term.rows }
})

console.log('buffer lines:', JSON.stringify(result))
ok('the buffer was actually full before the change', result.before > 5000, result.before)
ok('lowering scrollback TRIMS the existing buffer', result.after < result.before / 2, { before: result.before, after: result.after })
ok('…to roughly the new cap (+ the visible rows)', result.after <= 2000 + result.rows + 2, { after: result.after, cap: 2000, rows: result.rows })
ok('the terminal still accepts output after trimming', result.afterWrite >= result.after, { after: result.after, afterWrite: result.afterWrite })

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
