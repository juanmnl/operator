import { connect } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const S='$SCRATCH'
const { b, page } = await connect()
writeFileSync(S+'/x/pressure','1\n60\n'); const t0=Date.now()
while (Date.now()-t0<150000) { if (!(await page.$('[data-memory-banner]'))) break; await page.waitForTimeout(250) }
console.log('banner gone after', ((Date.now()-t0)/1000).toFixed(1)+'s')
await b.close()
