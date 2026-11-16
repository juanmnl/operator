// Cycles the active lane through the sidebar rows every INTERVAL; logs what it clicked.
import { connect } from './cdp.mjs'
import { appendFileSync, existsSync } from 'node:fs'
const S = '/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad'
const INTERVAL = Number(process.argv[2] || 20 * 60 * 1000)
let i = 0
for (;;) {
  try {
    const c = await connect()
    const r = await c.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('*')].filter(e=>e.children.length>=1&&/(RUNNING|YOUR TURN|WAITING|IDLE)/.test(e.innerText||'')&&(e.innerText||'').length<80&&e.getBoundingClientRect().width>150&&e.getBoundingClientRect().left<40)
      // keep innermost rows only
      const inner=rows.filter(e=>!rows.some(o=>o!==e&&e.contains(o)))
      if(!inner.length) return 'no rows'
      const el=inner[${i} % inner.length]; el.click(); return 'clicked '+(${i} % inner.length)+'/'+inner.length+' '+(el.innerText||'').replace(/\\n/g,' ').slice(0,40)
    })()`)
    appendFileSync(`${S}/logs/switcher.log`, new Date().toISOString() + ' ' + r + '\n')
    c.close()
  } catch (e) { appendFileSync(`${S}/logs/switcher.log`, new Date().toISOString() + ' error ' + e.message + '\n') }
  i++
  const end = Date.now() + INTERVAL
  while (Date.now() < end) { await new Promise((r) => setTimeout(r, 10000)); if (existsSync(`${S}/switcher.stop`)) process.exit(0) }
}
