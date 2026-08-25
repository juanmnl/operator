import { describe, it, expect } from 'vitest'
import { pathFromOutput, filePathForCall, fileHrefForCall } from './tool-file-link'
import { parseFileHref } from './code-nav'

// The shapes below are taken from real rows in `~/.operator/chat.db` — 66,690 tool payloads,
// 11,707 of them file tools. See the module header for the counts that shaped this.

describe('pathFromOutput — Edit and Write only report a basename as their target', () => {
  it('reads the path out of an Edit result', () => {
    expect(pathFromOutput('The file /Users/j/Developer/mantel-landing/src/index.css has been updated successfully.'))
      .toBe('/Users/j/Developer/mantel-landing/src/index.css')
  })

  it('reads it out of a Write result, whose wording differs', () => {
    expect(pathFromOutput('File created successfully at: /Users/j/Developer/operator/dev/x.md'))
      .toBe('/Users/j/Developer/operator/dev/x.md')
  })

  it('is undefined when the output has no path — 31% of Edits, which get NO link', () => {
    expect(pathFromOutput('The file has been updated successfully.')).toBeUndefined()
    expect(pathFromOutput('')).toBeUndefined()
    expect(pathFromOutput(undefined)).toBeUndefined()
  })

  it('does not match prose that merely contains a slash', () => {
    expect(pathFromOutput('applied 3/4 hunks')).toBeUndefined()
  })
})

describe('filePathForCall', () => {
  it('trusts an absolute target — Read reports one in 99.8% of calls', () => {
    expect(filePathForCall({ name: 'Read', target: '/Users/j/x/a.ts' })).toBe('/Users/j/x/a.ts')
  })

  // The summarizer ellipsises long targets. A truncated path is not something anything can open,
  // and turning it into a link would produce exactly the dead link this module refuses.
  it('refuses a TRUNCATED target rather than linking to a path that does not exist', () => {
    expect(filePathForCall({ name: 'Read', target: '/private/tmp/claude-501/-Users-j/…' })).toBeUndefined()
  })

  it('falls back to the output for a bare basename', () => {
    expect(filePathForCall({
      name: 'Edit', target: 'index.css',
      output: 'The file /Users/j/src/index.css has been updated successfully.',
    })).toBe('/Users/j/src/index.css')
  })

  it('gives up when the transcript never said where — no link is better than a dead one', () => {
    expect(filePathForCall({ name: 'Edit', target: 'index.css', output: 'done' })).toBeUndefined()
  })

  it('ignores tools that are not about a file', () => {
    expect(filePathForCall({ name: 'Bash', target: 'npm test', output: '/usr/bin/node x.js' })).toBeUndefined()
    expect(filePathForCall({ name: undefined, target: '/a/b.ts' })).toBeUndefined()
  })

  it('covers every file tool the transcript actually carries', () => {
    for (const name of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(filePathForCall({ name, target: '/a/b.ts' }), name).toBe('/a/b.ts')
    }
  })
})

describe('fileHrefForCall', () => {
  it('builds a link the router can parse back', () => {
    const href = fileHrefForCall({ name: 'Read', target: '/a/b.ts' })!
    expect(parseFileHref(href)).toMatchObject({ path: '/a/b.ts', root: 'lane' })
  })

  // ZERO of the 11,707 sampled rows carried a line number. A link that implied one would land
  // somewhere arbitrary, so it carries none — the viewer opens the file at the top.
  it('NEVER carries a line — nothing in the transcript has one', () => {
    const href = fileHrefForCall({ name: 'Read', target: '/a/b.ts' })!
    expect(parseFileHref(href)!.line).toBeUndefined()
    expect(href).not.toMatch(/:\d+$/)
  })

  it('is undefined when the path could not be resolved', () => {
    expect(fileHrefForCall({ name: 'Edit', target: 'a.ts', output: 'ok' })).toBeUndefined()
  })

  it('survives a path with a space or a hash', () => {
    const href = fileHrefForCall({ name: 'Read', target: '/a/b c#d.ts' })!
    expect(parseFileHref(href)!.path).toBe('/a/b c#d.ts')
  })
})
