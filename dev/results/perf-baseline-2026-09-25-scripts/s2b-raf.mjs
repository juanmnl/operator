import { chromium, BASE, open } from './lib.mjs'
const b = await chromium.launch()
const INIT = `window.__raf = {}; const oraf = window.requestAnimationFrame; window.requestAnimationFrame = (cb) => oraf((t) => { const k = cb.toString().slice(0,90).replace(/\\s+/g,' '); __raf[k]=(__raf[k]||0)+1; cb(t) });`
const { p } = await open(b, 'mock-nomin', { init: INIT })
await p.goto(`${BASE}/mock-nomin/dev/mock.html`); await p.waitForTimeout(3000)
await p.evaluate(() => { for (const k in __raf) delete __raf[k] })
await p.waitForTimeout(10000)
console.log(JSON.stringify(Object.entries(await p.evaluate(() => __raf)).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>[k,v/10]), null, 1))
// CSS animations running
console.log(await p.evaluate(() => document.getAnimations().map(a => (a.animationName||a.transitionProperty||'?')+':'+(a.effect?.target?.className?.toString?.().slice(0,40)||a.effect?.target?.tagName)).reduce((m,k)=>(m[k]=(m[k]||0)+1,m),{})))
await b.close()
