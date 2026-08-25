import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isInsideRoot, resolveInRoot, isIgnoredPath, sortEntries, looksBinary,
  languageFor, countLines, coalesceChanges, fileTree, fileRead, SKIP_DIRS,
} from './files'

const ROOT = mkdtempSync(join(tmpdir(), 'operator-files-'))
mkdirSync(join(ROOT, 'src', 'lib'), { recursive: true })
mkdirSync(join(ROOT, 'node_modules', 'x'), { recursive: true })
mkdirSync(join(ROOT, '.git'), { recursive: true })
writeFileSync(join(ROOT, 'src', 'a.ts'), 'const a = 1\nconst b = 2\n')
writeFileSync(join(ROOT, 'src', 'lib', 'b.rs'), 'fn main() {}\n')
writeFileSync(join(ROOT, 'README.md'), '# hi\n')
writeFileSync(join(ROOT, 'bin.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
writeFileSync(join(ROOT, 'empty.txt'), '')
const OUTSIDE = mkdtempSync(join(tmpdir(), 'operator-outside-'))
writeFileSync(join(OUTSIDE, 'secret.txt'), 'do not read me\n')
try { symlinkSync(OUTSIDE, join(ROOT, 'escape')) } catch { /* some sandboxes forbid symlinks */ }
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

// THE ONLY NEW ATTACK SURFACE THIS FEATURE OPENS, per the design — so it is tested against every
// escape shape rather than the one that came to mind first.
describe('the path guard', () => {
  it('accepts the root itself and anything genuinely inside it', () => {
    expect(isInsideRoot(ROOT, ROOT)).toBe(true)
    expect(isInsideRoot(ROOT, join(ROOT, 'src', 'a.ts'))).toBe(true)
  })

  it('refuses a `..` escape, which `resolve` collapses before the comparison', () => {
    expect(isInsideRoot(ROOT, join(ROOT, '..', '..', 'etc', 'passwd'))).toBe(false)
    expect(() => resolveInRoot(ROOT, '../../../etc/passwd')).toThrow(/outside the root/)
  })

  it('refuses an absolute path outside the root', () => {
    expect(() => resolveInRoot(ROOT, '/etc/passwd')).toThrow(/outside the root/)
  })

  // Without a separator-terminated prefix, `/a/rootkit` reads as inside `/a/root`.
  it('refuses a SIBLING whose name merely starts with the root', () => {
    expect(isInsideRoot('/a/root', '/a/rootkit/x')).toBe(false)
    expect(isInsideRoot('/a/root', '/a/root/x')).toBe(true)
  })

  it('refuses a path reached through a symlink that leaves the root', () => {
    // The candidate is canonicalised before comparing, so the symlink's TARGET is what is judged.
    expect(isInsideRoot(ROOT, join(ROOT, 'escape', 'secret.txt'))).toBe(false)
  })

  it('refuses empty input rather than treating it as the root', () => {
    expect(isInsideRoot(ROOT, '')).toBe(false)
    expect(isInsideRoot('', ROOT)).toBe(false)
  })

  it('resolves a legitimate relative path to an absolute one', () => {
    expect(resolveInRoot(ROOT, 'src/a.ts')).toContain('src')
  })
})

describe('isIgnoredPath — what the watcher drops', () => {
  it('matches a skip directory at ANY depth, which is where the watcher sees them', () => {
    expect(isIgnoredPath('node_modules/.bin/foo')).toBe(true)
    expect(isIgnoredPath('packages/web/node_modules/react/index.js')).toBe(true)
    expect(isIgnoredPath('src-tauri/target/debug/build/x')).toBe(true)
    expect(isIgnoredPath('.git/objects/ab/cd')).toBe(true)
  })

  it('leaves ordinary paths alone', () => {
    expect(isIgnoredPath('src/lib/a.ts')).toBe(false)
    expect(isIgnoredPath('README.md')).toBe(false)
  })

  it('does not match a partial segment — `distribution` is not `dist`', () => {
    expect(isIgnoredPath('src/distribution/a.ts')).toBe(false)
    expect(isIgnoredPath('my-node_modules/a.ts')).toBe(false)
  })
})

describe('sortEntries', () => {
  it('puts directories first, then sorts case-insensitively', () => {
    const out = sortEntries([
      { path: 'z.ts', name: 'z.ts', dir: false },
      { path: 'B', name: 'B', dir: true },
      { path: 'a.ts', name: 'a.ts', dir: false },
      { path: 'a', name: 'a', dir: true },
    ])
    expect(out.map((e) => e.name)).toEqual(['a', 'B', 'a.ts', 'z.ts'])
  })

  it('does NOT hoist dotfiles — a .claude directory is content here, not chrome', () => {
    const out = sortEntries([
      { path: 'src', name: 'src', dir: true },
      { path: '.claude', name: '.claude', dir: true },
    ])
    expect(out.map((e) => e.name)).toEqual(['.claude', 'src'])
  })
})

describe('looksBinary', () => {
  it('is a NUL byte in the sniff window — the same rule git and ripgrep use', () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x00]))).toBe(true)
    expect(looksBinary(new Uint8Array([0x61, 0x62, 0x0a]))).toBe(false)
  })
  it('reads an empty window as text, not binary', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false)
  })
})

describe('languageFor', () => {
  it('maps the repo\'s own languages', () => {
    expect(languageFor('src/a.ts')).toBe('TypeScript')
    expect(languageFor('src/A.TSX')).toBe('TSX')
    expect(languageFor('src-tauri/src/lib.rs')).toBe('Rust')
    expect(languageFor('package.json')).toBe('JSON')
    expect(languageFor('styles.css')).toBe('CSS')
    expect(languageFor('README.md')).toBe('Markdown')
    expect(languageFor('Cargo.toml')).toBe('TOML')
    expect(languageFor('run.sh')).toBe('Shell')
  })

  it('names a few files by NAME, since they have no extension', () => {
    expect(languageFor('Dockerfile')).toBe('Dockerfile')
    expect(languageFor('a/b/.zshrc')).toBe('Shell')
  })

  // A name `language-data` cannot resolve renders as plain text anyway, and that looks like the
  // highlighter is broken rather than like the language is unsupported. null is the honest answer.
  it('is null for an unknown extension, so the footer can say `plain text`', () => {
    expect(languageFor('a.wat')).toBeNull()
    expect(languageFor('LICENSE')).toBeNull()
  })
})

describe('countLines — the number a deep link addresses', () => {
  it('does not count the empty line after a trailing newline, matching wc -l and every editor', () => {
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
  })
  it('counts a single line with no newline', () => expect(countLines('a')).toBe(1))
  it('is zero for an empty file', () => expect(countLines('')).toBe(0))
  it('counts blank lines in the middle', () => expect(countLines('a\n\nb\n')).toBe(3))
})

describe('coalesceChanges', () => {
  it('dedupes a burst and drops everything under an ignored directory', () => {
    expect(coalesceChanges([
      'src/a.ts', 'src/a.ts', 'node_modules/react/index.js', 'src/b.ts', '.git/index',
    ])).toEqual(['src/a.ts', 'src/b.ts'])
  })
  it('is empty when a burst was entirely npm-install churn', () => {
    expect(coalesceChanges(['node_modules/a', 'node_modules/b'])).toEqual([])
  })
  it('ignores empty filenames, which fs.watch does emit', () => {
    expect(coalesceChanges(['', 'src/a.ts'])).toEqual(['src/a.ts'])
  })
})

describe('fileTree — lazy, one directory at a time', () => {
  it('lists a directory\'s immediate children and nothing deeper', async () => {
    const out = await fileTree(ROOT, '.')
    expect(out.map((e) => e.name)).toContain('src')
    expect(out.some((e) => e.path.includes('/'))).toBe(false)
  })

  it('never lists a skip directory by default — that is the whole point of lazy', async () => {
    const out = await fileTree(ROOT, '.')
    expect(out.some((e) => SKIP_DIRS.has(e.name))).toBe(false)
  })

  it('lists them when asked, and still does not descend', async () => {
    const out = await fileTree(ROOT, '.', true)
    expect(out.some((e) => e.name === 'node_modules')).toBe(true)
  })

  it('does not follow a symlinked directory — that is how a walk escapes its root', async () => {
    const out = await fileTree(ROOT, '.', true)
    expect(out.some((e) => e.name === 'escape')).toBe(false)
  })

  it('reports file sizes and directory-ness', async () => {
    const out = await fileTree(ROOT, 'src')
    const file = out.find((e) => e.name === 'a.ts')!
    expect(file.dir).toBe(false)
    expect(file.size).toBeGreaterThan(0)
    expect(out.find((e) => e.name === 'lib')!.dir).toBe(true)
  })

  it('refuses to list outside the root', async () => {
    await expect(fileTree(ROOT, '../..')).rejects.toThrow(/outside the root/)
  })
})

describe('fileRead', () => {
  it('reads a text file with its language and a true line count', async () => {
    const f = await fileRead(ROOT, 'src/a.ts')
    expect(f).toMatchObject({ language: 'TypeScript', lines: 2, truncated: false, binary: false })
    expect(f.text).toBe('const a = 1\nconst b = 2\n')
  })

  it('reports a binary file WITHOUT reading it into a string', async () => {
    const f = await fileRead(ROOT, 'bin.png')
    expect(f).toMatchObject({ binary: true, text: '', lines: 0 })
    expect(f.bytes).toBeGreaterThan(0)
  })

  it('reports an empty file as empty rather than as a blank pane', async () => {
    expect(await fileRead(ROOT, 'empty.txt')).toMatchObject({ bytes: 0, lines: 0, binary: false, text: '' })
  })

  // The design's rule: a file is never a refusal. Over the cap it truncates and says how much.
  it('TRUNCATES over the cap, at a line boundary, and still reports honestly', async () => {
    const f = await fileRead(ROOT, 'src/a.ts', 14)
    expect(f.truncated).toBe(true)
    expect(f.text.endsWith('\n')).toBe(false)   // cut at the last complete line
    expect(f.text).toBe('const a = 1')
    expect(f.bytes).toBe(24)                     // the TRUE size, not the kept size
  })

  it('refuses a path outside the root', async () => {
    await expect(fileRead(ROOT, '../../etc/passwd')).rejects.toThrow(/outside the root/)
    await expect(fileRead(ROOT, 'escape/secret.txt')).rejects.toThrow(/outside the root/)
  })

  it('refuses a directory rather than returning its bytes', async () => {
    await expect(fileRead(ROOT, 'src')).rejects.toThrow(/Not a file/)
  })
})
