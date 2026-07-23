// Design audit sweep: capture the uncommitted-diff surfaces in dark + light.
import { webkit } from 'playwright'

const SHOT = '/tmp/operator-shots/audit'
const theme = process.argv[2] || 'mission-control-dark'
const tag = process.argv[3] || 'dark'

const b = await webkit.launch()
const p = await b.newPage({
  viewport: { width: 1440, height: 980 },
  colorScheme: theme.endsWith('light') ? 'light' : 'dark',
})
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript((t) => localStorage.setItem('operator.theme', t), theme)
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)
await p.screenshot({ path: `${SHOT}/${tag}-1-boot.png` })

// Project workspace → roster board (idle-lane recede, live pill phase, resume button).
await p.keyboard.press('Meta+k'); await p.waitForTimeout(600)
await p.keyboard.type('workspace', { delay: 40 }); await p.waitForTimeout(600)
await p.screenshot({ path: `${SHOT}/${tag}-2a-palette.png` })
await p.keyboard.press('Enter'); await p.waitForTimeout(1600)
await p.screenshot({ path: `${SHOT}/${tag}-2-roster.png` })

// Hover an idle card — opacity should restore to 1.
const design = p.locator('div').filter({ hasText: /^Design/ }).first()
await design.hover({ position: { x: 300, y: 12 } }).catch(() => {})
await p.waitForTimeout(400)
await p.screenshot({ path: `${SHOT}/${tag}-3-roster-hover-idle.png` })

// Fire a dispatch at an IDLE lane → toast + auto-launch + dispatch-log row.
await p.evaluate(() => window.__mockDispatch?.({
  id: 'd-audit-1', terminalId: 't0', role: 'design',
  task: 'Audit the roster board for token drift and verify both themes',
}))
await p.waitForTimeout(1200)
await p.screenshot({ path: `${SHOT}/${tag}-4-dispatch-toast.png` })

// A long task + an unresolvable role — overflow + the "no lane" outcome.
await p.evaluate(() => window.__mockDispatch?.({
  id: 'd-audit-2', terminalId: 't0', role: 'nonexistent-lane',
  task: 'A deliberately very long dispatch task string that should ellipsize cleanly inside the dispatch log row rather than wrapping or pushing the outcome chip off the right edge of the panel',
}))
await p.waitForTimeout(1500)
await p.screenshot({ path: `${SHOT}/${tag}-5-dispatch-log.png` })

const probe = await p.evaluate(() => {
  const out = {}
  out.bg = getComputedStyle(document.body).backgroundColor
  out.bodyHScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth
  // Leaf text nodes clipped WITHOUT an ellipsis affordance.
  out.clippedNoEllipsis = Array.from(document.querySelectorAll('*'))
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 &&
      getComputedStyle(el).textOverflow !== 'ellipsis' && (el.textContent || '').trim().length > 0 &&
      el.children.length === 0)
    .slice(0, 8).map((el) => ({ text: (el.textContent || '').slice(0, 40), s: el.scrollWidth, c: el.clientWidth }))
  return out
})
console.log(`[${tag}]`, JSON.stringify(probe, null, 2))

await b.close()
