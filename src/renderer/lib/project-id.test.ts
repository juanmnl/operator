import { describe, it, expect } from 'vitest'
import { deriveProjectId } from './project-id'

describe('deriveProjectId', () => {
  it('is stable for the same path', () => {
    expect(deriveProjectId('/Users/x/Developer/operator')).toBe(deriveProjectId('/Users/x/Developer/operator'))
  })

  it('keeps the basename readable and appends an 8-hex hash', () => {
    const id = deriveProjectId('/Users/x/Developer/operator')
    expect(id).toMatch(/^operator-[0-9a-f]{8}$/)
  })

  it('distinguishes two folders that share a basename (collision fix)', () => {
    const a = deriveProjectId('/Users/x/a/api')
    const b = deriveProjectId('/Users/x/b/api')
    expect(a).not.toBe(b)
    expect(a.startsWith('api-')).toBe(true)
    expect(b.startsWith('api-')).toBe(true)
  })

  it('slugs non-alphanumeric basenames and never yields an empty slug', () => {
    expect(deriveProjectId('/tmp/My Project!')).toMatch(/^my-project-[0-9a-f]{8}$/)
    expect(deriveProjectId('/')).toMatch(/^project-[0-9a-f]{8}$/)
  })
})
