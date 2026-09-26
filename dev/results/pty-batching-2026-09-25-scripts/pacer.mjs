// Writes the fixture to stdout every 50 ms for N seconds: QA's "6 KB every 50 ms per shell".
import { readFileSync } from 'node:fs'
const buf = readFileSync(process.argv[2]); const until = Date.now() + Number(process.argv[3]) * 1000
const tick = () => { if (Date.now() > until) return; process.stdout.write(buf); setTimeout(tick, 50) }
tick()
