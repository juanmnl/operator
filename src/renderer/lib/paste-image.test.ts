import { describe, it, expect, vi } from 'vitest'
import { persistFiles, imageFilesFrom } from './paste-image'

// jsdom's File.arrayBuffer() doesn't reliably round-trip bytes, so use explicit
// File-like stubs — this also lets us simulate an unreadable file deterministically.
function fakeFile(bytes: number[] | null, name: string, type: string, path?: string): File {
  const f: Record<string, unknown> = { name, type }
  if (path) f.path = path
  f.arrayBuffer =
    bytes === null
      ? () => Promise.reject(new Error('unreadable'))
      : () => Promise.resolve(new Uint8Array(bytes).buffer)
  return f as unknown as File
}

describe('persistFiles', () => {
  it('reads bytes, base64-encodes, and returns the saved path', async () => {
    const save = vi.fn(async (_b64: string, ext: string) => `/tmp/operator-pastes/x.${ext}`)
    const paths = await persistFiles([fakeFile([1, 2, 3], 'shot.png', 'image/png')], save)
    expect(paths).toEqual(['/tmp/operator-pastes/x.png'])
    expect(save).toHaveBeenCalledTimes(1)
    const [b64, ext] = save.mock.calls[0]
    expect(ext).toBe('png')
    expect(atob(b64)).toBe('\x01\x02\x03')
  })

  it('derives the extension from the mime type when the name has none', async () => {
    const save = vi.fn(async (_b64: string, ext: string) => `/tmp/p.${ext}`)
    await persistFiles([fakeFile([0], 'clipboard', 'image/jpeg')], save)
    expect(save.mock.calls[0][1]).toBe('jpeg')
  })

  it('uses an existing on-disk path without calling save', async () => {
    const save = vi.fn()
    const paths = await persistFiles([fakeFile([], 'a.png', 'image/png', '/real/a.png')], save)
    expect(paths).toEqual(['/real/a.png'])
    expect(save).not.toHaveBeenCalled()
  })

  it('skips an unreadable file but keeps the rest, in order', async () => {
    const save = vi.fn(async (_b64: string, ext: string) => `/tmp/ok.${ext}`)
    const bad = fakeFile(null, 'bad.png', 'image/png')
    const good = fakeFile([9], 'good.png', 'image/png')
    const paths = await persistFiles([bad, good], save)
    expect(paths).toEqual(['/tmp/ok.png'])
  })
})

describe('imageFilesFrom', () => {
  it('returns only image files', () => {
    const img = fakeFile([], 'a.png', 'image/png')
    const txt = fakeFile([], 'a.txt', 'text/plain')
    const dt = { files: [img, txt] } as unknown as DataTransfer
    expect(imageFilesFrom(dt)).toEqual([img])
  })

  it('handles a null DataTransfer', () => {
    expect(imageFilesFrom(null)).toEqual([])
  })
})
