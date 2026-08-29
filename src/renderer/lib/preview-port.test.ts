import { describe, it, expect } from 'vitest'
import type { SessionPort } from '../../shared/types'
import {
  portOf, parseTarget, formatTarget, pickPreviewPort, pickPreviewUrl, EMPTY_TARGET,
  isAutoSelectable, evidenceLabel,
} from './preview-port'

const sniffed = (port: number): SessionPort => ({ port, attributed: 'sniffed' })
const reserved = (port: number): SessionPort => ({ port, attributed: 'reserved' })
const shared = (port: number, n = 2): SessionPort => ({ port, attributed: 'shared', sharedWith: n })
const claimed = (port: number, by = 't9'): SessionPort => ({ port, attributed: 'claimed', claimedBy: by })
const orphan = (port: number): SessionPort => ({ port, attributed: 'orphan' })
/** Any tier that is not this lane's. The old code had one such tier; the design names three. */
const foreign = orphan

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
      .toMatchObject({ url: 'http://localhost:5173/admin', foreign: false, port: 5173 })
  })

  // The second half of the brief: a port change must not lose the page the user was on.
  it('KEEPS THE PATH when the port changes underneath it', () => {
    const target = { path: '/admin/users' }
    expect(pickPreviewUrl([sniffed(5173)], null, target).url).toBe('http://localhost:5173/admin/users')
    expect(pickPreviewUrl([sniffed(3000)], null, target).url).toBe('http://localhost:3000/admin/users')
  })

  it('refuses to show a foreign server, and says so instead', () => {
    expect(pickPreviewUrl([foreign(1422)], 'http://localhost:1422'))
      .toMatchObject({ url: null, foreign: true, port: null })
  })

  // The precise regression: falling back to `reservedUrl` here would load the exact port the
  // stranger is on, which is the original bug wearing a fallback's clothes.
  it('does NOT fall back to the reserved url when the reserved port is the foreign one', () => {
    expect(pickPreviewUrl([foreign(1422)], 'http://localhost:1422').url).toBeNull()
  })

  it('still NAMES the unattributable one while showing an attributable port beside it', () => {
    const pick = pickPreviewUrl([sniffed(5173), foreign(1422)], 'http://localhost:1422')
    expect(pick.url).toBe('http://localhost:5173')
    // `foreign` is now reserved for what is being SHOWN; the stray is named separately so the
    // picker can offer it without the strip claiming the visible app is a stranger's.
    expect(pick.foreignServer).toMatchObject({ port: 1422 })
  })

  it('a pinned port overrules everything, including foreign — the user may mean it', () => {
    expect(pickPreviewUrl([foreign(1422)], null, { port: 1422, path: '/x' }))
      .toMatchObject({ url: 'http://localhost:1422/x', port: 1422, source: 'pinned' })
  })

  it('an external target takes over completely', () => {
    expect(pickPreviewUrl([sniffed(5173)], null, { path: '', url: 'https://app.example.com' }))
      .toMatchObject({ url: 'https://app.example.com', foreign: false, port: null })
  })

  it('falls back to the reserved port when nothing is serving yet, keeping the path', () => {
    // Renders the "not serving yet" empty state naming the right port, rather than a blank panel.
    expect(pickPreviewUrl([], 'http://localhost:1422', { path: '/admin' }))
      .toMatchObject({ url: 'http://localhost:1422/admin', foreign: false, port: 1422 })
    expect(pickPreviewUrl([], null)).toMatchObject({ url: null, foreign: false, port: null })
  })
})


// ── §2's decision table, row for row ─────────────────────────────────────────────────────────
//
// `dev/results/preview-address-bar-design.md` says "this table IS its test table", so it is
// transcribed rather than paraphrased. Rows are evaluated top to bottom, first match wins.
describe('the selection rule, row by row', () => {
  const RESERVED = 'http://localhost:1423'

  it('row 1 — a pin wins over everything, including the evidence', () => {
    const pick = pickPreviewUrl([claimed(1423)], RESERVED, { port: 1423, path: '/x' })
    expect(pick).toMatchObject({ url: 'http://localhost:1423/x', source: 'pinned', port: 1423 })
    // …and it is still FLAGGED, because warned is not the same as blocked. Sometimes two lanes
    // really are looking at one server and the user knows it.
    expect(pick.foreign).toBe(true)
  })

  it('row 2 — a sniffed port outranks a live reserved one', () => {
    const pick = pickPreviewUrl([reserved(1423), sniffed(5173)], RESERVED)
    expect(pick).toMatchObject({ url: 'http://localhost:5173', source: 'sniffed' })
  })

  it('row 3 — reserved, unshared, unclaimed shows, and says `unconfirmed`', () => {
    const pick = pickPreviewUrl([reserved(1423)], RESERVED)
    expect(pick).toMatchObject({ url: 'http://localhost:1423', source: 'reserved' })
    expect(evidenceLabel(reserved(1423))).toBe('reserved · unconfirmed')
  })

  // ROWS 4, 5 AND 6 ARE THE FIX. A reserved port that is alive but unattributable is no longer
  // shown automatically — it becomes an offer with a warning. The cost is one extra click; the
  // cost of the old behaviour was silently reviewing a sibling's build and reporting on it.
  it('row 4 — claimed by another lane shows NOTHING', () => {
    const pick = pickPreviewUrl([claimed(1423)], RESERVED)
    expect(pick.url).toBeNull()
    expect(pick.foreign).toBe(true)
    expect(pick.foreignServer).toMatchObject({ port: 1423, attributed: 'claimed' })
  })

  it('row 5 — a SHARED reservation shows nothing: it cannot tell siblings apart', () => {
    // `allocPort` hands one port to every lane in a cwd on purpose, so this signal is ambiguous
    // by construction — and the old rule ranked it highest. That is the bug at its root.
    const pick = pickPreviewUrl([shared(1423, 3)], RESERVED)
    expect(pick.url).toBeNull()
    expect(evidenceLabel(shared(1423, 3))).toBe('⚠ shared with 3 lanes')
  })

  it('row 6 — shared AND claimed still shows nothing', () => {
    expect(pickPreviewUrl([shared(1423), claimed(1424)], RESERVED).url).toBeNull()
  })

  it('row 7 — nothing answering falls back to naming the reserved port', () => {
    const pick = pickPreviewUrl([], RESERVED, { path: '/admin' })
    expect(pick).toMatchObject({ url: 'http://localhost:1423/admin', foreign: false })
  })

  // The precise regression: falling back to `reservedUrl` in rows 4–6 would load the exact port
  // the stranger is on — the original bug wearing a fallback's clothes.
  it('never falls back to the reserved url when that port is the unattributable one', () => {
    for (const s of [claimed(1423), shared(1423), orphan(1423)]) {
      expect(pickPreviewUrl([s], RESERVED).url, s.attributed).toBeNull()
    }
  })

  it('names what it is refusing to show, so the empty state can too', () => {
    const pick = pickPreviewUrl([claimed(1423, 't7')], RESERVED)
    expect(evidenceLabel(pick.foreignServer!)).toBe("⚠ t7's server")
  })
})

describe('isAutoSelectable — only two tiers may be chosen without a click', () => {
  it('accepts this lane\'s evidence', () => {
    expect(isAutoSelectable(sniffed(1))).toBe(true)
    expect(isAutoSelectable(reserved(1))).toBe(true)
  })
  it('refuses every ambiguous tier', () => {
    expect(isAutoSelectable(shared(1))).toBe(false)
    expect(isAutoSelectable(claimed(1))).toBe(false)
    expect(isAutoSelectable(orphan(1))).toBe(false)
  })
})

describe('evidenceLabel — words, not jargon', () => {
  it('never leaks the enum name to the UI', () => {
    for (const s of [sniffed(1), reserved(1), shared(1), claimed(1), orphan(1)]) {
      expect(evidenceLabel(s), s.attributed).not.toBe(s.attributed)
      expect(evidenceLabel(s).length, s.attributed).toBeGreaterThan(0)
    }
  })
  it('warns on exactly the tiers that are not this lane\'s', () => {
    expect(evidenceLabel(sniffed(1)).startsWith('⚠')).toBe(false)
    expect(evidenceLabel(reserved(1)).startsWith('⚠')).toBe(false)
    for (const s of [shared(1), claimed(1), orphan(1)]) {
      expect(evidenceLabel(s).startsWith('⚠'), s.attributed).toBe(true)
    }
  })
})
