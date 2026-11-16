import { connect } from './lib.mjs'
const { b, page } = await connect()
await page.getByText('Start an agent').first().click()
await page.waitForTimeout(500)
await page.getByText('Start ' + process.argv[2], { exact: true }).click()
await page.waitForTimeout(6000)
const txt = await page.innerText('body')
if (/trust this folder/.test(txt)) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(5000) }
await page.screenshot({ path: process.argv[3] })
console.log(txt.includes('trust this folder') ? 'trust accepted' : 'no trust prompt')
await b.close()
