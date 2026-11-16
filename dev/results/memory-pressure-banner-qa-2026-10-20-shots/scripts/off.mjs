import { connect } from './lib.mjs'
const { b, page } = await connect()
await page.getByText(process.argv[2], { exact: true }).first().click()
await page.waitForTimeout(800)
console.log(await page.evaluate(()=>localStorage.getItem('operator.lane.idleSuspendMinutes')))
await b.close()
