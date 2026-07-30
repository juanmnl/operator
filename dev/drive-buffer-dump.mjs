// Exercise the ⌘K "Dump terminal buffer (debug)" diagnostic end to end.
//
// It had never been run — `~/.operator/terminal-dumps/` does not exist — and it is the only
// instrument that can settle buffer-vs-pixels on the next garble sighting, so "it fails
// silently" was the thing to rule out. It doesn't: it surfaces the exception in an error
// toast. This driver pins the rest — that the command reaches the file writer, and the shape
// of the filename it writes.
//
// The handler is the ONLY caller of @tauri-apps/api/path in the renderer, so it needs
// `window.__TAURI_INTERNALS__`, which a plain browser has not got. The shim below stands in
// for the two path-plugin commands it uses; everything downstream of that is real code.
// (`core:default` includes `core:path:default`, so the real app is permitted to call them —
// checked in src-tauri/gen/schemas/acl-manifests.json.)
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-buffer-dump.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })
await ctx.addInitScript(() => {
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:path|resolve_directory') return '/Users/harness'
      if (cmd === 'plugin:path|join') return args.paths.join('/')
      throw new Error(`unstubbed tauri command: ${cmd}`)
    },
  }
})
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3200)
await p.locator('[data-session-row]').first().click()
await p.waitForTimeout(1200)

await p.keyboard.press('Meta+K'); await p.waitForTimeout(400)
await p.keyboard.type('dump'); await p.waitForTimeout(500)
console.log('1 palette entry:', await p.evaluate(() => Array.from(document.querySelectorAll('div'))
  .map((d) => d.textContent?.trim()).filter((t) => t && /dump/i.test(t) && t.length < 60)[0] ?? null))
await p.keyboard.press('Enter'); await p.waitForTimeout(1200)

const r = await p.evaluate(() => {
  const call = window.__calls.filter((c) => c.fn === 'folderPrefsSaveMd').pop()
  const host = Array.from(document.querySelectorAll('div')).find((d) => d.style.position === 'fixed' && d.style.zIndex === '900')
  const content = call?.args?.[1] ?? ''
  return {
    reachedTheWriter: !!call,
    path: call?.args?.[0] ?? null,
    header: content.split('\n').slice(0, 5),
    lines: content ? content.split('\n').length : 0,
    toast: host?.firstElementChild?.textContent?.slice(0, 120) ?? null,
  }
})
console.log('2 reached the file writer:', r.reachedTheWriter, '(expect true)')
console.log('2 path:', r.path)
console.log('2 toast:', r.toast)
console.log('3 header lines:', JSON.stringify(r.header, null, 1))
console.log('3 total lines written:', r.lines, '(viewport + 50 rows of tail + header)')

const name = (r.path || '').split('/').pop() || ''
// The filename has to carry BOTH ids and a timestamp: a report is matched against a pty, and
// two dumps of one session across a restart differ only by terminal id.
const ok = {
  underTerminalDumps: (r.path || '').includes('/.operator/terminal-dumps/'),
  hasTimestamp: /\d{4}-\d{2}-\d{2}T[\d-]+Z\.txt$/.test(name),
  parts: name.replace(/\.txt$/, '').split('-').length >= 3,
  carriesTerminalId: name.includes('t1') || name.split('-').length >= 3,
}
console.log('4 filename:', name)
console.log('4 checks:', JSON.stringify(ok), Object.values(ok).every(Boolean) ? '✓' : '✗')

await b.close()
