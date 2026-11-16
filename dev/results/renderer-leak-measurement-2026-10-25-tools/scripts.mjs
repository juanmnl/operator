// Dump CDP scriptId -> url for the renderer (Debugger.enable replays scriptParsed for existing scripts).
import { connect } from './cdp.mjs'
import { writeFileSync } from 'node:fs'
const c = await connect()
const map = {}
c.on((d) => { if (d.method === 'Debugger.scriptParsed') map[d.params.scriptId] = d.params.url })
await c.send('Debugger.enable')
await new Promise((r) => setTimeout(r, 1500))
await c.send('Debugger.disable')
writeFileSync(process.argv[2] || 'scriptmap.json', JSON.stringify(map, null, 1))
console.log(Object.keys(map).length, 'scripts;', Object.values(map).filter((u) => /assets/.test(u)).join(', '))
c.close()
