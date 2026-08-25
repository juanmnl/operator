import { describe, it, expect } from 'vitest'
import type { SessionPort } from '../../shared/types'
import {
  portOf, parseTarget, formatTarget, pickPreviewPort, pickPreviewUrl, EMPTY_TARGET,
} from './preview-port'

const sniffed = (port: number): SessionPort => ({ port, attributed: 'sniffed' })
const reserved = (port: number): SessionPort => ({ port, attributed: 'reserved' })
const foreign = (port: number): SessionPort => ({ port, attributed: 'foreign' })

describe('portOf', () => {
  it('extracts the port from a localhost url', () => {
    expect(portOf('http://localhost:5173')).toBe(5173)
  })
  it('is null for a portless url, a null url, and garbage', () => {
    expect(portOf('https://app.example.com')).toBeNull()
    expect(portOf(null)).toBeNull()
    expect(portOf('not a url')).toBeNull()
  })
})

describe('pickPreviewPort — sniffed beats reserved, foreign never wins', () => {
  // THE BUG. A stale orphan or a sibling lane answering on our reserved port used to be shown as
  // this lane's app, because "something is listening on 1422" was treated as proof.
  it('never picks a foreign port, even when it is the only one answering', () => {
    expect(pickPreviewPort([foreign(1422)])).toBeNull()
    expect(pickPreviewPort([foreign(1422), foreign(3000)])).toBeNull()
  })

  it('prefers a SNIFFED port over a reserved one — proof beats inference', () => {
    // The dev server ignored PORT and bound 5173 while something else answers on 1422. The
    // announced one is the app the user is working on.
    expect(pickPreviewPort([reserved(1422), sniffed(5173)])).toEqual(sniffed(5173))
  })

  it('takes a reserved port when nothing was sniffed', () => {
    expect(pickPreviewPort([reserved(1422), foreign(3000)])).toEqual(reserved(1422))
  })

  it('is stable within a tier — the LOWEST port, whatever order they arrive in', () => {
    expect(pickPreviewPort([sniffed(5173), sniffed(3000)])).toEqual(sniffed(3000))
    expect(pickPreviewPort([sniffed(3000), sniffed(5173)])).toEqual(sniffed(3000))
  })

  it('is null with nothing to pick from', () => {
    expect(pickPreviewPort([])).toBeNull()
  })
})

describe('parseTarget — one box, four jobs', () => {
  it('reads a bare number as a PORT, not a path', () => {
    // Typed into a browser bar `3000` would be a search; typed here it is unambiguously the
    // thing the box is named for, and reading it as a path breaks the common case.
    expect(parseTarget('3000')).toEqual({ port: 3000, path: '' })
  })

  it('reads port + path', () => {
    expect(parseTarget('5173/admin')).toEqual({ port: 5173, path: '/admin' })
    expect(parseTarget('5173/admin/users?tab=1')).toEqual({ port: 5173, path: '/admin/users?tab=1' })
  })

  it('reads a bare path, leaving the port to be chosen', () => {
    expect(parseTarget('/admin')).toEqual({ path: '/admin' })
    expect(parseTarget('/')).toEqual({ path: '' })
  })

  it('reads host:port/path', () => {
    expect(parseTarget('localhost:5173/x')).toEqual({ port: 5173, path: '/x' })
    expect(parseTarget('127.0.0.1:8080')).toEqual({ port: 8080, path: '' })
  })

  it('keeps a LOCALHOST url as port + path, so a port change can carry the path over', () => {
    expect(parseTarget('http://localhost:5173/admin?q=1'))
      .toEqual({ port: 5173, path: '/admin?q=1' })
  })

  it('takes an external url whole — none of the attribution applies to it', () => {
    expect(parseTarget('https://app.example.com/x')).toEqual({ path: '', url: 'https://app.example.com/x' })
  })

  it('gives a schemeless hostname a scheme rather than refusing it', () => {
    expect(parseTarget('app.example.com/x')).toEqual({ path: '', url: 'http://app.example.com/x' })
  })

  it('is the empty target for empty input', () => {
    expect(parseTarget('')).toEqual(EMPTY_TARGET)
    expect(parseTarget('   ')).toEqual(EMPTY_TARGET)
  })

  it('round-trips through formatTarget for everything the box can express', () => {
    for (const s of ['3000', '5173/admin', '/admin', 'https://app.example.com/x']) {
      expect(formatTarget(parseTarget(s))).toBe(s)
    }
  })
})

describe('pickPreviewUrl', () => {
  it('composes the picked port with the stored path', () => {
    expect(pickPreviewUrl([sniffed(5173)], 'http://localhost:1422', { path: '/admin' }))
      .toEqual({ url: 'http://localhost:5173/admin', foreign: false, port: 5173 })
  })

  // The second half of the brief: a port change must not lose the page the user was on.
  it('KEEPS THE PATH when the port changes underneath it', () => {
    const target = { path: '/admin/users' }
    expect(pickPreviewUrl([sniffed(5173)], null, target).url).toBe('http://localhost:5173/admin/users')
    expect(pickPreviewUrl([sniffed(3000)], null, target).url).toBe('http://localhost:3000/admin/users')
  })

  it('refuses to show a foreign server, and says so instead', () => {
    expect(pickPreviewUrl([foreign(1422)], 'http://localhost:1422'))
      .toEqual({ url: null, foreign: true, port: null })
  })

  // The precise regression: falling back to `reservedUrl` here would load the exact port the
  // stranger is on, which is the original bug wearing a fallback's clothes.
  it('does NOT fall back to the reserved url when the reserved port is the foreign one', () => {
    expect(pickPreviewUrl([foreign(1422)], 'http://localhost:1422').url).toBeNull()
  })

  it('still flags foreign while showing an attributable port beside it', () => {
    const pick = pickPreviewUrl([sniffed(5173), foreign(1422)], 'http://localhost:1422')
    expect(pick.url).toBe('http://localhost:5173')
    expect(pick.foreign).toBe(true)
  })

  it('a pinned port overrules everything, including foreign — the user may mean it', () => {
    expect(pickPreviewUrl([foreign(1422)], null, { port: 1422, path: '/x' }))
      .toEqual({ url: 'http://localhost:1422/x', foreign: false, port: 1422 })
  })

  it('an external target takes over completely', () => {
    expect(pickPreviewUrl([sniffed(5173)], null, { path: '', url: 'https://app.example.com' }))
      .toEqual({ url: 'https://app.example.com', foreign: false, port: null })
  })

  it('falls back to the reserved port when nothing is serving yet, keeping the path', () => {
    // Renders the "not serving yet" empty state naming the right port, rather than a blank panel.
    expect(pickPreviewUrl([], 'http://localhost:1422', { path: '/admin' }))
      .toEqual({ url: 'http://localhost:1422/admin', foreign: false, port: 1422 })
    expect(pickPreviewUrl([], null)).toEqual({ url: null, foreign: false, port: null })
  })
})
