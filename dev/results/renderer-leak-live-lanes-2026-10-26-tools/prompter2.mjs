// every 5 min send one tiny prompt to each real Claude lane (cwd proj-scratch)
import { connect } from './cdp.mjs'
import { appendFileSync, existsSync } from 'node:fs'
const S = process.env.S
const log = (...a) => appendFileSync(`${S}/logs/prompter2.log`, new Date().toISOString() + ' ' + a.join(' ') + '\n')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const N = Number(process.argv[2] || 25)
for (let i = 0; i < N; i++) {
  if (existsSync(`${S}/prompter.stop`)) { log('stop file'); break }
  try {
    const c = await connect()
    const ids = JSON.parse(await c.evaluate(`window.operator.terminalList().then(l=>JSON.stringify(l.filter(x=>x.alive&&/proj-scratch$/.test(x.cwd||'')).map(x=>x.id)))`))
    for (const id of ids) {
      await c.evaluate(`window.operator.terminalWrite(${JSON.stringify(id)}, 'Write a 120-word explanation of what a git worktree is and when to use one. Plain prose, no lists, no tools.')`)
      await wait(500)
      await c.evaluate(`window.operator.terminalWrite(${JSON.stringify(id)}, '\\r')`)
      log('sent', i, id)
      await wait(1500)
    }
    c.close()
  } catch (e) { log('error', e.message) }
  await wait(5 * 60000)
}
log('done')
