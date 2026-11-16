import { connect } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const S='$SCRATCH'
const { b, page } = await connect()
const lvl=(l,f)=>writeFileSync(S+'/x/pressure',`${l}\n${f}\n`)
await page.evaluate(()=>{ window.__ro=0; const ro=new ResizeObserver(()=>{window.__ro++}); document.querySelectorAll('.xterm').forEach(e=>ro.observe(e)) })
const state = async (tag) => {
  const s = await page.evaluate(()=>{
    const t=[...document.querySelectorAll('.xterm')].map(e=>Math.round(e.getBoundingClientRect().height))
    const bn=document.querySelector('[data-memory-banner]')
    return { banner: bn?bn.getAttribute('data-memory-banner'):null, termHeights: t.join(','), roCallbacks: window.__ro }
  })
  console.log(new Date().toTimeString().slice(0,8), tag.padEnd(40), JSON.stringify(s)); return s
}
const sleep=(ms)=>page.waitForTimeout(ms)
const waitBanner=async(ms)=>{const e=Date.now()+ms; while(Date.now()<e){ if(await page.$('[data-memory-banner]')) return true; await sleep(250)} return false}
await state('start')
console.log('(entering with the banner dismissed at 2, main still at 2)')
lvl(4,4); console.log('banner shown again on rise 2->4:', await waitBanner(15000)); await sleep(800); await state('level 4'); await page.screenshot({path:S+'/shots/c8-06-dismissed2-shown4.png'})
await page.click('[data-memory-banner] [aria-label="Dismiss"]'); await sleep(600); await state('dismissed at 4')
lvl(2,12); await sleep(8000); await state('4->2, dismissed stays?')
for (const round of [1,2]) {
  lvl(1,60); await sleep(70000); await state(`round ${round}: normal held 70 s`)
  lvl(2,14); await sleep(12000); await state(`round ${round}: rise to 2 held 12 s`)
}
lvl(1,60); await b.close()
