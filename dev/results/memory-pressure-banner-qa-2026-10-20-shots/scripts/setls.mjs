import { connect } from './lib.mjs'
const { b, page } = await connect()
await page.evaluate(([k,v])=>{ if(v==='null') localStorage.removeItem(k); else localStorage.setItem(k,v) }, [process.argv[2], process.argv[3]])
await b.close()
