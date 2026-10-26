// A short stand-in for a long string, for "is this the text I wrote last time?" checks that would
// otherwise keep the whole text. DashboardView's persist effects kept the last serialized projects
// list (about 10 MB of string for a 5 MB store) for the life of the renderer only to compare
// against the next one; they keep this instead.
//
// cyrb53 (two 32-bit lanes mixed into 53 bits) plus the length. Not cryptographic: two different
// texts of the same length share a fingerprint with a chance near 2^-53, and the cost of that is
// one skipped write, until the next change.

export function fingerprint(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `${s.length}:${h.toString(36)}`
}
