import { connect } from './lib.mjs'
const S='$SCRATCH'
const { b, page } = await connect()
const t0=Date.now()
await page.click('[data-memory-suspend]')
let last='', shot=false
while (Date.now()-t0 < 15000) {
  const t = await page.textContent('[data-memory-banner]').catch(()=>null)
  if (t!==last) { console.log(((Date.now()-t0)/1000).toFixed(2)+'s', JSON.stringify(t)); last=t
    if (t && t.includes('Suspending') && !shot) { await page.screenshot({path:S+'/shots/'+(process.env.P||'x')+'-suspending.png'}); shot=true } }
  await page.waitForTimeout(60)
}
await page.screenshot({path:S+'/shots/'+(process.env.P||'x')+'-after.png'})
console.log((await page.innerText('body')).split('\n').slice(2,24).join(' | '))
await b.close()
