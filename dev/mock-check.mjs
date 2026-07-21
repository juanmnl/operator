import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
const errs = [], logs = []
p.on('pageerror', e => errs.push(String(e)))
p.on('console', m => { if (m.type() === 'error') logs.push(m.text()) })
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(3500)
const rootHtml = await p.evaluate(() => document.getElementById('root')?.innerHTML.length ?? -1)
console.log('root innerHTML length:', rootHtml)
console.log('pageerrors:', errs.length); errs.slice(0,5).forEach(e => console.log('  ERR', e.slice(0,300)))
console.log('console errors:', logs.length); logs.slice(0,5).forEach(e => console.log('  LOG', e.slice(0,300)))
await p.screenshot({ path: '/tmp/mock-boot.png' })
await b.close()
