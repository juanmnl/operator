# Review: terminal links stop before trailing punctuation (2026-10-24)

Commit reviewed: `0236e4d` on `operator/98a1c0` ("Terminal links stop before trailing punctuation
and resolve across wrapped rows"). Files: `src/renderer/lib/terminal.ts`,
`src/renderer/components/terminal/TerminalPane.tsx`, `src/renderer/lib/terminal.test.ts`.
Separate finding set from the delivery-hold review of `8698c31`.

## Tests run

On an export of `0236e4d`: root `npx vitest run` 123 files, 1966 passed; electron
`npm run typecheck` clean. The regex was also probed in Node against the cases listed below, and the
wrapped-row resolver was run against a real `@xterm/xterm` 6.0.0 buffer in a scratch vitest (deleted
afterwards).

## Findings, most severe first

### L1. Medium: CJK punctuation and text, and closing guillemets, are kept as part of the URL

`src/renderer/lib/terminal.ts:118` (`LINK_RE`).

The exclusion classes cover ASCII punctuation and curly quotes only. Characters that end a URL in
prose in other languages are URL characters to this regex, including in the last position:

| Input | Match |
|---|---|
| `詳細は https://x.com/a。次に` | `https://x.com/a。次に` |
| `https://x.com/aを参照してください。` | `https://x.com/aを参照してください。` |
| `ver https://x.com/a，y` (fullwidth comma) | `https://x.com/a，y` |
| `ver «https://x.com/a» o` | `https://x.com/a»` |
| `https://x.com/a…` | `https://x.com/a…` |

Failure scenario: a lane answering in Spanish writes `el informe «https://claude.ai/artifact/abc»`.
Clicking it opens `https://claude.ai/artifact/abc%C2%BB` and 404s, which is the bug this commit
fixes, for the quote style Spanish prose uses. A lane answering in Japanese or Chinese, where no
space follows a URL, opens the URL with the rest of the sentence attached. The WebLinksAddon gets
the same regex, so the underline is wrong in the same way.

A fix would add `«»…` and the CJK/fullwidth punctuation block (`、。，．：；！？（）「」『』【】`)
to the "ends a URL" classes.

### L2. Low: a wide character that wraps early inserts a space into the joined rows, so click and hover disagree

`src/renderer/components/terminal/TerminalPane.tsx:594-597`, `src/renderer/lib/terminal.ts:135-139`.

When a double-width character does not fit in the last column, xterm leaves that cell empty and
moves the character to the next row. `translateToString(false)` turns the empty cell into a space.
The click resolver joins rows untrimmed, so the URL is cut at that space. The addon trims each row
and corrects for this case in `_mapStrIdx`, so its underline covers the whole URL.

Reproduced on a 20-column buffer with `https://ja.x.org/w/日本語の記事です`: the joined rows are
`"https://ja.x.org/w/ "` + `"日本語の記事です    "`. A click on the second row returns null, and a
click on the first row opens `https://ja.x.org/w/`. The commit's stated goal is that "the underline
and the opened URL are the same text". Here they are not, while mouse tracking is on.

### L3. Low (not introduced, not fixed): the clicked column is used as a string index, which is wrong after wide characters on the same row

`src/renderer/lib/terminal.ts:138` (`offset + col`), `TerminalPane.tsx:582`.

The offset between rows is correct: each row's string length is where the next row starts in the
joined string, whatever its cell width. Inside the clicked row, though, `col` is a cell column and
is used as a string index. Each double-width character before the URL on that row moves the hit
area by one.

Reproduced on a 20-column buffer with `日本語 https://x.co/ab`. The URL occupies columns 7-19, but
the resolver returns it for columns 4-18. Clicking the last column misses, and clicking on `語` or
the space before the URL opens it. For an emoji that takes several code units in one cell
(`unicode-graphemes` is active), the shift goes the other way. This is the same as before the
commit, but the brief asked for this column math to be checked, and the commit does not handle it.
`_mapStrIdx` in the addon shows the per-cell walk that would.

### L4. Low: `|`, `{`, `}`, `^` and `\` now end a URL on the click path, and a trailing `_` or `~` is dropped

`src/renderer/lib/terminal.ts:118`.

The old click regex allowed `|{}^\`. The new one excludes them anywhere, as the addon's
`strictUrlRegex` does. `https://fonts.googleapis.com/css?family=Roboto|Open+Sans` now opens as
`https://fonts.googleapis.com/css?family=Roboto`. The hover underline already stopped there, so
the click path now matches it, but the click opened the full URL before this commit. A URL that
really ends in `_` or `~` (`https://x.com/snake_case_`) loses that character. Both cases are rare.
Listed so the trade-off is a decision someone made, not something found later.

## Checked and clean

- WebLinksAddon 0.12.0 with `{ urlRegex: LINK_RE }`: `LinkComputer.computeLink` builds
  `new RegExp(regex.source, (regex.flags || '') + 'g')`. `LINK_RE` has no flags, so this works.
  A regex that already had `g` would make `'gg'` and throw, as the comment says. The addon still
  validates each match with `new URL`; the click path does not, which was already the case.
- Regex cases that resolve correctly: query strings (`?b=1&c=2`), fragments (`#frag.` drops the
  period), ports (`http://localhost:1429:` drops the colon, `…:1429/` keeps the slash), `%`-escapes
  including a trailing `%2C`, trailing slashes, `~` and `_` inside paths, markdown links
  `[t](https://x.com/a)`, `Foo_(bar)` inside a markdown link, `(see https://x.y/z)`, `**bold**`
  around a URL, straight and curly quotes after a URL, `a.)` at the end.
- Backtracking: the `(` alternative cannot overlap the plain-character class, so each start
  position is linear. Probes of 50,000 trailing dots, 5,000 unclosed `(a` groups and 50 long
  URLs on one line each ran in 1 ms or less.
- Wrapped-row walk: up to 64 rows above the clicked row and 128 rows in total, so the clicked row
  is always included. The walk stops at the first row that is not `isWrapped`. `findUrlInWrappedRows`
  computes each row's offset from the untrimmed row string lengths, which matches the joined
  string even when a row contains wide characters (checked against the xterm buffer).
- `urlAtClick` runs on mousedown, mouseup and click. Each call joins at most 128 rows and builds
  one regex. Cost is negligible.

## Not verified

The wrapped-row join only applies to rows xterm wrapped itself (`isWrapped`). Claude Code renders
through Ink, which may break long lines with explicit newlines. If it does, its own long URLs
are not `isWrapped` and a click on the second row still opens only that row's part. This needs a
GUI check in a lane: print a URL longer than the pane is wide and click its second row.

## Recommendation to the coordinator

L1 for Code: extend the end-of-URL classes. L2 and L3 can share one change: map the clicked cell
to a string index by walking cells, as the addon's `_mapStrIdx` does, instead of
`translateToString` plus the raw column. L4 is a decision to record, not a fix.
