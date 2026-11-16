import { connect } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const S='$SCRATCH'
const { b, page } = await connect()
const lvl=(l,f)=>writeFileSync(S+'/x/pressure',`${l}\n${f}\n`)
const sleep=(ms)=>page.waitForTimeout(ms)
lvl(2,14); await sleep(8000); await page.reload(); await sleep(3500)
await page.evaluate(()=>{ window.__ro=0; const ro=new ResizeObserver(()=>{window.__ro++}); document.querySelectorAll('.xterm').forEach(e=>ro.observe(e)) })
console.log('inner', await page.evaluate(()=>innerWidth+'x'+innerHeight))
const state = async (tag) => { const s = await page.evaluate(()=>{ const t=[...document.querySelectorAll('.xterm')].map(e=>Math.round(e.getBoundingClientRect().height)); const bn=document.querySelector('[data-memory-banner]'); return { banner: bn?bn.getAttribute('data-memory-banner'):null, termHeights: t.join(','), roCallbacks: window.__ro }}); console.log(new Date().toTimeString().slice(0,8), tag.padEnd(34), JSON.stringify(s)) }
await state('banner visible at 2 (not dismissed)')
for (const [l,f] of [[1,60],[2,14],[1,60],[2,14],[1,60],[2,14]]) { lvl(l,f); await sleep(7000); await state(`file=${l} held 7 s`) }
await page.screenshot({path:S+'/shots/c8-flap-after.png'})
lvl(1,60); await b.close()
