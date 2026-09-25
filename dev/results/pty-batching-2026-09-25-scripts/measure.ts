// Messages/s from TerminalManager to the renderer sink, with real node-pty and real login shells.
// One sink call is one `webContents.send` in the app. See README.md for how to build and run.
import { TerminalManager } from '../../../electron/src/main/terminals'
const BENCH = process.env.BENCH!   // this directory
const FIXTURE = process.env.FIXTURE! // scripts/width-audit/claude-stream.bin (git-ignored, 6192 bytes)
const MODE = process.env.MODE ?? 'paced' // 'paced' = 6 KB every 50 ms per shell; 'flood' = cat in a loop
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let counting = false, msgs = 0, bytes = 0
const sizes: number[] = []
const tm = new TerminalManager((_id, b64) => {
  if (!counting) return
  const n = Buffer.from(b64, 'base64').length
  msgs++; bytes += n; sizes.push(n)
}, () => {})
const cmd = MODE === 'flood'
  ? `(end=$((SECONDS+16)); while [ $SECONDS -lt $end ]; do cat ${FIXTURE}; done)\r`
  : `node ${BENCH}/pacer.mjs ${FIXTURE} 16\r`
async function main() {
  const ids = [0, 1, 2, 3].map(() => tm.spawnShell(BENCH))
  await sleep(4000) // login shells finish their rc files
  for (const id of ids) tm.write(id, cmd)
  await sleep(3000) // warm-up
  counting = true
  const t0 = Date.now()
  await sleep(10000)
  counting = false
  const secs = (Date.now() - t0) / 1000
  sizes.sort((a, b) => a - b)
  console.log(JSON.stringify({ mode: MODE, msgsPerSec: +(msgs / secs).toFixed(1), kbPerSec: +(bytes / 1024 / secs).toFixed(1), medianBytes: sizes[sizes.length >> 1], maxBytes: sizes[sizes.length - 1], msgs, secs }))
  for (const id of ids) tm.write(id, 'exit\r')
  await sleep(500)
  process.exit(0)
}
main()
