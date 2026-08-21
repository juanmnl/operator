import { describe, it, expect } from 'vitest'
import { isAllowedNavigation as allow } from './navigation'

const DEV = 'http://localhost:1450/index.html'
const APP = '/Applications/Operator.app/Contents/Resources/app.asar/out/renderer'

// This is the backstop for the 2026-08-14 accident: a stray Finder drop navigated the webview to
// `file:///…/image.png`, and closing that window killed every lane's pty.
describe('the drop / navigation guard', () => {
  it('allows the dev server, including other pages and query strings', () => {
    expect(allow('http://localhost:1450/index.html', DEV, APP)).toBe(true)
    expect(allow('http://localhost:1450/bench.html?renderer=webgl', DEV, APP)).toBe(true)
    expect(allow('http://localhost:1450/', DEV, APP)).toBe(true)
  })

  it('compares ORIGIN, not prefix — a lookalike host must not pass', () => {
    // The reason this is an origin check: `http://localhost:1450.evil.test/` shares the prefix.
    expect(allow('http://localhost:1450.evil.test/', DEV, APP)).toBe(false)
    expect(allow('http://localhost:14500/', DEV, APP)).toBe(false)
    expect(allow('https://localhost:1450/index.html', DEV, APP)).toBe(false)  // different scheme
  })

  it('REFUSES a dropped file — the whole reason this exists', () => {
    expect(allow('file:///Users/juanmnl/Desktop/screenshot.png', DEV, APP)).toBe(false)
    expect(allow('file:///etc/passwd', null, APP)).toBe(false)
  })

  it('allows the packaged renderer\'s own files', () => {
    expect(allow(`file://${APP}/index.html`, null, APP)).toBe(true)
    expect(allow(`file://${APP}/assets/main.js`, null, APP)).toBe(true)
  })

  it('does not let a SIBLING directory pass as the app directory', () => {
    // `/…/renderer-evil` startsWith `/…/renderer` — the separator is what stops it.
    expect(allow(`file://${APP}-evil/index.html`, null, APP)).toBe(false)
  })

  it('refuses external web URLs (they are handed to the system browser instead)', () => {
    expect(allow('https://example.com/', DEV, APP)).toBe(false)
    expect(allow('http://evil.test/', DEV, APP)).toBe(false)
  })

  it('refuses schemes that are not http(s) or our own file://', () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,<h1>x', 'about:blank', 'operatorpick://ipc?d=x']) {
      expect(allow(u, DEV, APP), u).toBe(false)
    }
  })

  it('refuses garbage rather than throwing', () => {
    expect(allow('', DEV, APP)).toBe(false)
    expect(allow('not a url', DEV, APP)).toBe(false)
  })

  it('with no dev server, only the packaged renderer is allowed', () => {
    expect(allow('http://localhost:1450/index.html', null, APP)).toBe(false)
  })
})
