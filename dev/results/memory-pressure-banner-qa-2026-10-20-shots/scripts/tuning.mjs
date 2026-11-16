import { connect } from './lib.mjs'
const { b, page } = await connect()
await page.getByText('Tuning', { exact: true }).first().click()
await page.waitForTimeout(1500)
const t = await page.innerText('body')
console.log(t.split('\n').filter(l=>/idle|suspend|Off|min/i.test(l)).slice(0,20).join(' | '))
await page.screenshot({ path: process.argv[2] })
console.log(await page.evaluate(()=>localStorage.getItem('operator.lane.idleSuspendMinutes')))
await b.close()
