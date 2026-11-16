import { connect } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const S='$SCRATCH'
const { b, page } = await connect()
const lvl=(l,f)=>writeFileSync(S+'/x/pressure',`${l}\n${f}\n`)
const sleep=(ms)=>page.waitForTimeout(ms)
const info = () => page.evaluate(()=>{
  const bn=document.querySelector('[data-memory-banner]'); if(!bn) return null
  const r=(e)=>{if(!e)return null;const x=e.getBoundingClientRect();return [Math.round(x.left),Math.round(x.right),Math.round(x.width),Math.round(x.height)]}
  const txt=bn.querySelector('span[title]'), btn=bn.querySelector('[data-memory-suspend]'), x=bn.querySelector('[aria-label="Dismiss"]')
  const cs=getComputedStyle(bn)
  return { win: innerWidth, banner: r(bn), text: r(txt), textTruncated: txt.scrollWidth>txt.clientWidth, button: r(btn), close: r(x), bg: cs.backgroundColor, color: cs.color, label: bn.textContent }
})
const waitLevel=async(l,ms=25000)=>{const e=Date.now()+ms; while(Date.now()<e){ const a=await page.getAttribute('[data-memory-banner]','data-memory-banner').catch(()=>null); if(a===String(l)) return true; await sleep(300)} return false}
const mode = process.argv[2]
if (mode==='themes') {
  lvl(2,14); await sleep(25000)
  for (const th of ['1984-dark','1984-light','mr-pink-dark','mr-pink-light','mission-control-light','mission-control-dark']) {
    await page.evaluate((t)=>localStorage.setItem('operator.theme',t), th); await page.reload(); await sleep(3500)
    console.log(th, 'level 2 shown:', await waitLevel(2,10000))
    await sleep(500); await page.screenshot({path:`${S}/shots/c8-th-${th}-warn.png`}); console.log('  ', JSON.stringify(await info()))
  }
  // critical in the two new palettes
  lvl(4,4)
  for (const th of ['1984-dark','1984-light','mr-pink-dark','mr-pink-light']) {
    await page.evaluate((t)=>localStorage.setItem('operator.theme',t), th); await page.reload(); await sleep(3500)
    console.log(th, 'level 4 shown:', await waitLevel(4,20000))
    await sleep(500); await page.screenshot({path:`${S}/shots/c8-th-${th}-critical.png`}); console.log('  ', JSON.stringify(await info()))
  }
  await page.evaluate(()=>localStorage.setItem('operator.theme','mission-control-dark')); await page.reload(); await sleep(2500)
}
if (mode==='narrow') {
  const orig = await page.evaluate(()=>[outerWidth,outerHeight])
  console.log('orig window', orig)
  await page.evaluate(()=>window.resizeTo(720, outerHeight)); await sleep(1500)
  console.log('after resizeTo innerWidth =', await page.evaluate(()=>innerWidth))
  for (const th of ['mission-control-dark','1984-dark','mr-pink-light']) {
    await page.evaluate((t)=>localStorage.setItem('operator.theme',t), th); await page.reload(); await sleep(3000)
    for (const L of [2,4]) { lvl(L, L===2?14:4); console.log('narrow',th,'level',L,'shown:',await waitLevel(L,25000)); await sleep(800)
      await page.screenshot({path:`${S}/shots/c8-narrow-720-${th}-L${L}.png`}); console.log('  ', JSON.stringify(await info())) }
  }
  await page.evaluate(()=>localStorage.setItem('operator.theme','mission-control-dark'))
  await page.evaluate(([w,h])=>window.resizeTo(w,h), orig); await sleep(1000)
}
await b.close()
