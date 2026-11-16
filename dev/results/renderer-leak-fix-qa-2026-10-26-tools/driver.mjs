// Every 5 min alternately (a) switches the active lane through the sidebar rows, (b) generates project
// traffic: opens the project page, BOARD tab, adds one task (no assignee, no Send) so `projects` changes.
import { connect } from './cdp.mjs'
import { appendFileSync, existsSync } from 'node:fs'
const S = '/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad'
const log = (...a) => appendFileSync(`${S}/logs/driver.log`, new Date().toISOString() + ' ' + a.join(' ') + '\n')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const INTERVAL = Number(process.argv[2] || 5 * 60 * 1000)
let tick = Number(process.argv[3] || 0), lane = Number(process.argv[4] || 0), task = Number(process.argv[5] || 1)
const clickText = (c, re) => c.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>${re}.test((b.innerText||'').trim())); if(!b) return 'none'; b.click(); return 'ok'})()`)
for (;;) {
  try {
    const c = await connect()
    if (tick % 2 === 0) {
      const r = await c.evaluate(`(()=>{
        const rows=[...document.querySelectorAll('*')].filter(e=>e.children.length>=1&&/(RUNNING|YOUR TURN|WAITING|IDLE)/.test(e.innerText||'')&&(e.innerText||'').length<80&&e.getBoundingClientRect().width>150&&e.getBoundingClientRect().left<40)
        const inner=rows.filter(e=>!rows.some(o=>o!==e&&e.contains(o)))
        if(!inner.length) return 'no rows'
        const el=inner[${lane} % inner.length]; el.click(); return 'clicked '+(${lane} % inner.length)+'/'+inner.length+' '+(el.innerText||'').replace(/\\n/g,' ').slice(0,40)
      })()`)
      log('switch', r); lane++
    } else {
      const back = await clickText(c, '/^‹/'); await wait(1500)
      const board = await clickText(c, '/^BOARD$/'); await wait(1500)
      const typed = await c.evaluate(`(()=>{
        const find=()=>document.querySelector('textarea[placeholder^="e.g. Make"]')||document.querySelector('textarea[placeholder="Add a task…"]')
        let ta=find()
        if(!ta){const plus=[...document.querySelectorAll('button')].find(b=>(b.innerText||'').trim()==='+'); if(plus) plus.click()}
        return 'opened'})()`)
      await wait(700)
      const typed2 = await c.evaluate(`(()=>{const ta=document.querySelector('textarea[placeholder^="e.g. Make"]')||document.querySelector('textarea[placeholder="Add a task…"]'); if(!ta) return 'no composer'; const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta,'traffic probe ${task}'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'})()`)
      await wait(700)
      const add = await clickText(c, '/^Add$/')
      log('traffic', task, 'back', back, 'board', board, typed, typed2, 'add', add); task++
    }
    c.close()
  } catch (e) { log('error', e.message) }
  tick++
  const end = Date.now() + INTERVAL
  while (Date.now() < end) { await wait(10000); if (existsSync(`${S}/driver.stop`)) process.exit(0) }
}
