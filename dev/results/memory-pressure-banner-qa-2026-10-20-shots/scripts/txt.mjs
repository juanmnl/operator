import { connect } from './lib.mjs'
const { b, page } = await connect()
console.log(JSON.stringify(await page.textContent('[data-memory-banner]').catch(()=>null)))
await b.close()
