import { connect } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const S='$SCRATCH'
const { b, page } = await connect()
const lvl=(l,f)=>writeFileSync(S+'/x/pressure',`${l}\n${f}\n`)
const wrapped = await page.evaluate(()=>{
  window.__rs=[]; window.__ro=0
  try { const o=window.operator.terminalResize; window.operator.terminalResize=(id,c,r)=>{window.__rs.push([Date.now(),id.slice(0,6),c,r]);return o(id,c,r)}; if (window.operator.terminalResize===o) return 'frozen' } catch(e){ return 'err '+e.message }
  return 'wrapped' })
console.log('terminalResize wrap:', wrapped)
await page.evaluate(()=>{ window.__ro=0; const ro=new ResizeObserver(()=>{window.__ro++}); document.querySelectorAll('.xterm').forEach(e=>ro.observe(e)) })
const state = async (tag) => {
  const s = await page.evaluate(()=>{
    const vis=[...document.querySelectorAll('.xterm')].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height)})
    const bn=document.querySelector('[data-memory-banner]')
    return { banner: bn?bn.getAttribute('data-memory-banner'):null, visibleTerm: vis.join(','), ro: window.__ro, ptyResizes: (window.__rs||[]).length }
  })
  console.log(new Date().toTimeString().slice(0,8), tag.padEnd(34), JSON.stringify(s))
}
const sleep=(ms)=>page.waitForTimeout(ms)
await state('start (level 1, no banner)')
lvl(2,14); await sleep(8000); await state('level 2 held 8 s')
await page.click('[data-memory-banner] [aria-label="Dismiss"]'); await sleep(700); await state('dismissed')
const flap=[[1,60],[2,14],[1,60],[2,14],[1,60],[2,14]]
for (const [l,f] of flap) { lvl(l,f); await sleep(7000); await state(`file=${l} held 7 s`) }
await sleep(10000); await state('+10 s, file left at 2')
lvl(1,60); await sleep(2000); await b.close()
