# Terminal links: trailing punctuation and wrapped URLs (2026-10-24)

Branch `operator/98a1c0`, commit `0236e4d`. This is a separate commit from the delivery-hold work on
the same branch. Not merged. Not GUI-verified.

## Cause

Claude Code turns mouse tracking on, so a click in a lane goes to TerminalPane's own resolver
(`onClickCapture` → `findUrlAtColumn`) and not to WebLinksAddon. The old regex,
`/(https?:\/\/[^\s'"`<>()\[\]]+)/g`, kept every trailing `, . ; : ! ?`, curly quotes and `*`/`_`.
"claude.ai/artifact/…qge," therefore opened with the comma. The hover underline came from
WebLinksAddon's own `strictUrlRegex`, so hover and click could disagree.

## What changed

- `src/renderer/lib/terminal.ts:118`: `LINK_RE` replaces `URL_RE`. It is based on the addon's
  `strictUrlRegex`. These characters end a URL: whitespace, straight and curly quotes, backticks,
  `<>`, `{}`, `[]`, `|`, `\`, `^` and `*`. The last character may not be `. , ; : ! ? ~ _`. One
  change from the addon: a balanced `(…)` group is kept, also at the end (one level of nesting).
  So `wiki/Foo_(bar)` resolves whole, and the `)` that closes "(see https://x.y/z)" is left out.
  An unmatched `(` or `)` ends the URL. The regex has no `g` flag, because the addon adds its own
  and a doubled flag would throw.
- `terminal.ts:121`: `findUrlAtColumn` builds a global copy of `LINK_RE`.
- `terminal.ts:135`: new `findUrlInWrappedRows(rows, row, col)` joins the rows of one wrapped line
  and maps the column into the joined string.
- `src/renderer/components/terminal/TerminalPane.tsx:197`: WebLinksAddon gets
  `{ urlRegex: LINK_RE }`, so the hover underline and the opened URL are the same text.
- `TerminalPane.tsx:587-598`: the click resolver walks up and down through rows with `isWrapped`
  (capped at 64 rows up and 128 rows in total) and resolves against the joined line. It used to
  read only the clicked row (`translateToString` on one line), so a URL wider than the terminal
  opened only the part on that row.
- `src/renderer/components/terminal/GridTerminalPane.tsx:397` calls `findUrlAtColumn` and gets the
  punctuation fix with no change. Wrapping is not fixed there: its `GridUpdate` rows have no wrap
  flag, so there is nothing to join on. No other copy of the resolver exists in `src/renderer`
  or `electron/src`.

## Tests

Added to `src/renderer/lib/terminal.test.ts`:
- `:79` trailing comma (the reported artifact URL), period, `?`, `;`, `!`, straight and curly
  closing quotes.
- Punctuation inside a URL is kept (`a.b,c?d=1&e=f.g`, port and fragment).
- Closing paren of prose: `(see https://x.y/z)`, `(see https://x.y/z).`, `[docs](https://x.y/z)`.
- Markdown: `**https://x.y**`, `_https://x.y/z_`.
- Balanced parens: `wiki/Foo_(bar)`, the same inside prose parens followed by a period, and
  `a_(b)_c`.
- `LINK_RE` has no `g` flag and the addon's `new RegExp(source, flags + 'g')` does not throw.
- `:112` `findUrlInWrappedRows`: a URL over three 20-column rows resolves whole from each row,
  returns null past its end, and a single row behaves like `findUrlAtColumn`.

Results:
- Root `npx vitest run`: 123 files, **1966 passed**. That is 1957 plus 9 new tests.
- Root `npx tsc --noEmit -p .` and electron `npm run typecheck`: clean.

## Not covered

- A wide character that wraps early leaves an empty last cell. With an untrimmed read that cell
  is a space, which ends the URL at that point. The addon corrects for this case and this
  resolver does not. It is rare in URLs.
- Column mapping with wide characters before the URL on the same line is unchanged from before:
  cell column and string index can differ.

## GUI check for the user

In a lane with Claude Code running (mouse tracking on):
1. Ask the lane to print `See https://claude.ai/artifact/L6xd2A8XBUUCiXZFGv9qge, then this.`
   Click the URL. It should open without the comma, and the hover underline should stop before it.
2. Ask it to print `(see https://en.wikipedia.org/wiki/Foo_(bar)).` The click should open
   `…/Foo_(bar)`.
3. Narrow the pane until a long URL wraps over two rows, then click the second row. The full URL
   should open.
