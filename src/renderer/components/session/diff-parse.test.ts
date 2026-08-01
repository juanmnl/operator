import { describe, it, expect } from 'vitest'
import { parseDiff } from './DiffBody'
// `?raw` rather than fs: the fixture then travels with the module graph, so it is resolved the
// same way in the test runner and in a build, and a rename of the file is a compile error
// instead of a runtime one.
import FIXTURE from './__fixtures__/real-git.diff?raw'

// `__fixtures__/real-git.diff` is REAL `git diff` output, not a hand-written approximation of
// one. It was produced by a scratch repo doing every awkward thing at once — a rename, a rename
// of a path containing spaces, a chmod with no content change, an edit to a path containing a
// space, a file with no trailing newline, a binary file, a new file, and an edit whose removed
// and added lines are themselves `-- dashes` / `++ pluses`.
//
// That last one is the reason this file exists. Once git prefixes them they read `--- dashes`
// and `+++ pluses`, i.e. exactly like the preamble markers both of the app's former parsers
// matched on by prefix. A fabricated fixture would never have contained it, and the bug it hides
// is silent: the lines simply do not appear.

const byPath = (p: string) => parseDiff(FIXTURE).find((f) => f.path === p)

describe('parseDiff, over real git output', () => {
  it('names every file by its CURRENT path', () => {
    expect(parseDiff(FIXTURE).map((f) => f.path)).toEqual([
      'bin.dat',
      'mode.sh',
      'my file.ts',                 // a space — the old `\S+` parser produced '?' here
      'nonewline.txt',
      'plain.ts',
      'renamed with space 2.ts',    // the NEW name, not the old one
      'renamed.ts',
      'untracked.ts',
      'edge.md',
    ])
  })

  it('keeps content lines that look like preamble markers', () => {
    // The whole point: `-- dashes` and `++ pluses` become `--- dashes` / `+++ pluses` in a diff.
    // Stripping by prefix anywhere in the file deleted both; this is what the hunk gate buys.
    expect(byPath('edge.md')!.lines).toEqual([
      '@@ -1,3 +1,3 @@',
      ' keep',
      '--- dashes',
      '+++ pluses',
      ' keep2',
      // git's trailing newline, split into a final empty element. Asserted rather than trimmed:
      // an empty last line is also what an unchanged blank context line looks like, so dropping
      // it by rule would eat real content to tidy an artifact worth one blank row.
      '',
    ])
  })

  it('still strips the real preamble, which only ever appears before the first hunk', () => {
    expect(byPath('plain.ts')!.lines).toEqual([
      '@@ -1,3 +1,4 @@', ' a', '-b', '+B', ' c', '+d',
    ])
    // `--- /dev/null` and `+++ b/untracked.ts` are gone; the added line is not.
    expect(byPath('untracked.ts')!.lines).toEqual(['@@ -0,0 +1 @@', '+new'])
  })

  it('turns a metadata-only change into a note instead of an empty body', () => {
    // Both of these have no hunks at all. Before, they rendered as a file section you could
    // expand onto nothing.
    expect(byPath('mode.sh')).toMatchObject({ lines: [], note: 'Mode 100644 → 100755' })
    expect(byPath('renamed.ts')).toMatchObject({ lines: [], note: 'Renamed from rename-me.ts' })
    expect(byPath('renamed with space 2.ts')!.note).toBe('Renamed from renamed with space.ts')
  })

  it('leaves binary and no-newline markers as body lines', () => {
    expect(byPath('bin.dat')!.lines).toEqual(['Binary files a/bin.dat and b/bin.dat differ'])
    expect(byPath('nonewline.txt')!.lines).toContain('\\ No newline at end of file')
  })

  it('returns nothing for an empty diff rather than a phantom file', () => {
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('\n\n')).toEqual([])
  })

  it('ignores anything before the first file header', () => {
    expect(parseDiff('warning: LF will be replaced by CRLF\n+not a real line\n')).toEqual([])
  })
})
