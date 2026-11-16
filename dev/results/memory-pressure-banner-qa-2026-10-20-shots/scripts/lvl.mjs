// usage: node lvl.mjs <level> <free%> [shotpath]   waits for banner of that level (or none at 1)
import { connect } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const S='$SCRATCH'
const { b, page } = await connect()
const [lvl, free, shot] = process.argv.slice(2)
const t0 = Date.now()
writeFileSync(S+'/x/pressure', `${lvl}\n${free}\n`)
const end = Date.now()+40000
let txt=null
while (Date.now()<end) {
  const a = await page.getAttribute('[data-memory-banner]','data-memory-banner').catch(()=>null)
  if (lvl==='1' ? a===null : a===lvl) { txt = a && await page.textContent('[data-memory-banner]'); break }
  await page.waitForTimeout(250)
}
console.log('level', lvl, 'after', ((Date.now()-t0)/1000).toFixed(1)+'s', 'text:', JSON.stringify(txt))
if (shot) { await page.waitForTimeout(600); await page.screenshot({ path: shot }) }
await b.close()
