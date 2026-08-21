// M3 — idle RSS of the packaged app: 1 instance with 0 lanes, then 3 at once.
//
// Bypasses `open` and execs the bundle binary directly, because LaunchServices refuses to
// start a second copy of the same bundle and "3 Operators across worktrees" is the shape the
// question is actually about.
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const BIN = new URL('../dist/Operator-Electron-darwin-arm64/Operator-Electron.app/Contents/MacOS/Operator-Electron', import.meta.url).pathname
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 45_000)

/** Summed RSS (MB) of every process whose argv mentions the bundle. `ps` once, no per-pid
 *  inspection — a per-process walk is what fires a macOS TCC prompt per process. */
function rssMb() {
  const out = execFileSync('ps', ['-eo', 'rss,args'], { encoding: 'utf8', maxBuffer: 32e6 })
  let kb = 0, n = 0
  for (const line of out.split('\n')) {
    if (!line.includes('Operator-Electron.app')) continue
    const m = line.trim().match(/^(\d+)\s/)
    if (m) { kb += Number(m[1]); n++ }
  }
  return { mb: Math.round(kb / 1024), processes: n }
}

const kids = []
const launch = (n) => { for (let i = 0; i < n; i++) kids.push(spawn(BIN, [], { detached: true, stdio: 'ignore' })) }
const stop = () => { for (const k of kids) { try { process.kill(-k.pid) } catch { try { k.kill() } catch { /* gone */ } } } }

launch(1)
await sleep(SETTLE_MS)
const one = rssMb()
console.log(`1 instance, 0 lanes:  ${one.mb} MB across ${one.processes} processes`)

launch(2)
await sleep(SETTLE_MS)
const three = rssMb()
console.log(`3 instances, 0 lanes: ${three.mb} MB across ${three.processes} processes`)
console.log(`per-instance marginal: ${Math.round((three.mb - one.mb) / 2)} MB`)

stop()
