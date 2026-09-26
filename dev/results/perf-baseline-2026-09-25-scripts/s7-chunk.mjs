import fs from 'node:fs'
import { stripOrnaments, detectDevServerPort, base64ToBytes } from './chunk.bundle.mjs'
const src = fs.readFileSync('/Users/juanmnl/Developer/operator/scripts/width-audit/claude-stream.bin')
const big = Buffer.concat(Array(12).fill(src)) // ~74KB of real Claude output
const time = (fn, n) => { for (let i = 0; i < 200; i++) fn(); const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(); return Number(process.hrtime.bigint() - t) / n / 1000 }
for (const size of [512, 2048, 8192, 32768]) {
  const str = big.subarray(0, size).toString('utf8')
  const hist = []; let hb = 0
  const mainUs = time(() => { const buf = Buffer.from(str, 'utf8'); hist.push(buf); hb += buf.length; if (hb > 512 * 1024) { while (hb > 256 * 1024 && hist.length > 1) hb -= hist.shift().length } return buf.toString('base64') }, 3000)
  const b64 = Buffer.from(str, 'utf8').toString('base64'); const dec = new TextDecoder()
  const bridgeUs = time(() => dec.decode(base64ToBytes(b64), { stream: true }), 3000)
  const tail = { t: '' }
  const scanUs = time(() => { const { tail: t2 } = detectDevServerPort(tail.t, str, null); tail.t = t2; return stripOrnaments(str) }, 3000)
  console.log(`chunk ${String(size).padStart(5)}B  main(Buffer+history+base64) ${mainUs.toFixed(1)}us | renderer bridge(atob+bytes+decode) ${bridgeUs.toFixed(1)}us | detectDevServer+stripOrnaments ${scanUs.toFixed(1)}us`)
}
