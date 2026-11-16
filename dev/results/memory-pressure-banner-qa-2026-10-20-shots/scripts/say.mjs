import { connect } from './lib.mjs'
const { b, page } = await connect()
const [lane, text] = [process.argv[2], process.argv[3]]
await page.getByText(new RegExp('^' + lane + '$', 'i')).first().click({ timeout: 8000 })
await page.waitForTimeout(1200)
if (text) {
  await page.keyboard.type(text, { delay: 8 })
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
}
await b.close()
