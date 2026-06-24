import { describe, it, expect } from 'vitest'
import { base64ToBytes } from './base64'

describe('base64ToBytes', () => {
  it('decodes ascii', () => {
    expect(Array.from(base64ToBytes('aGVsbG8='))).toEqual([104, 101, 108, 108, 111]) // "hello"
  })
  it('decodes an empty payload to an empty array', () => {
    expect(base64ToBytes('').length).toBe(0)
  })
  it('round-trips multibyte UTF-8 bytes', () => {
    // "é" = 0xC3 0xA9
    const b64 = btoa(String.fromCharCode(0xc3, 0xa9))
    expect(Array.from(base64ToBytes(b64))).toEqual([0xc3, 0xa9])
  })
})
