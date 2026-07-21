import { describe, it, expect } from 'vitest'
import { portOf, pickPreviewUrl } from './preview-port'

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

describe('pickPreviewUrl', () => {
  it('prefers the reserved port when the session is serving on it', () => {
    expect(pickPreviewUrl([3000, 1420, 5173], 'http://localhost:1420'))
      .toBe('http://localhost:1420')
  })

  it('falls back to the LOWEST port when the reserved one is not being served', () => {
    // Stability matters: the pick must not depend on the order the OS reports sockets.
    expect(pickPreviewUrl([5173, 3000], 'http://localhost:1420')).toBe('http://localhost:3000')
    expect(pickPreviewUrl([3000, 5173], 'http://localhost:1420')).toBe('http://localhost:3000')
  })

  it('returns the reserved url unchanged when nothing is serving yet', () => {
    // Renders the correct "not serving yet" empty state rather than a blank panel.
    expect(pickPreviewUrl([], 'http://localhost:1420')).toBe('http://localhost:1420')
    expect(pickPreviewUrl([], null)).toBeNull()
  })

  it('picks the lowest when there is no reserved url at all', () => {
    expect(pickPreviewUrl([8080, 4321], null)).toBe('http://localhost:4321')
  })
})
