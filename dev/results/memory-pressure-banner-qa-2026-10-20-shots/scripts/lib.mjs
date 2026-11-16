import { chromium } from '$SCRATCH/build/node_modules/playwright/index.mjs'
export async function connect() {
  const b = await chromium.connectOverCDP('http://localhost:9344')
  const page = b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('index.html')||p.url().includes('1434'))
  return { b, page }
}
