# Review round 2: terminal links (2026-10-25)

Commit reviewed: `0480d60` on `operator/98a1c0` (also `operator/ced0c0`, on top of `b72339b`), diff
`git diff b72339b 0480d60`. Round 1: `dev/results/terminal-link-punctuation-review-2026-10-24.md`.
Scope: L1-L4 and regressions in the touched lines.

## Merge verdict

**Nothing blocks merging.** L1-L4 are closed. One tradeoff remains under L1 and is noted below.
Whether Claude Code's own long URLs are `isWrapped` rows is still the open GUI question from round 1.

## Tests run

On an export of `0480d60`: root `npx vitest run` 123 files, 2006 passed; root `npx tsc --noEmit -p .`
clean. In addition:

- `LINK_RE` was probed in Node against the round-1 cases and the new ones.
- `findUrlInWrappedRows` was run against a real `@xterm/xterm` 6.0.0 buffer in a scratch vitest,
  which I deleted afterwards.

## L1-L4

| Finding | Status | Evidence |
|---|---|---|
| L1 CJK punctuation and guillemets kept in the URL | Closed | `«https://x.com/a»` → `https://x.com/a`; `詳細は https://x.com/a。次に` → `https://x.com/a`; `https://x.com/a，y` → `https://x.com/a`; `https://x.com/a…` → `https://x.com/a`. |
| L2 a wide character wrapped early cut the URL | Closed | 20-column buffer, `https://ja.x.org/w/日本語の記事です`: a click on either row returns the whole URL. The blank cell left by the early wrap is skipped, as the addon's `_mapStrIdx` skips it. |
| L3 column used as a string index | Closed | Same buffer, `日本語 https://x.co/ab`: the resolver hits columns 7-19 on row 0 and 0-1 on row 1, exactly the URL's cells, and nothing on `語` or the space. Width-0 cells map to their wide character. |
| L4 `\| { } ^` ended a URL; trailing `_` `~` dropped | Closed | `family=Roboto\|Open+Sans` is kept whole; `/api/{id}/edit` is kept; `a^b` is kept; a trailing `\|`, `^`, `{` or `}` is dropped; `snake_case_` and `/~` keep their last character. |

### The tradeoff left under L1

CJK text with no punctuation between it and the URL is still part of the URL:
`https://x.com/aを参照してください。` → `https://x.com/aを参照してください`. CJK letters are valid in a
path (`ja.wikipedia.org/wiki/日本`), so the regex cannot end a URL at them without breaking those
links. Only the punctuation was in scope, and that is fixed. Low, and not a blocker.

## Touched lines checked, no regressions

- **Hover and click agree.** Both use the same `LINK_RE`, which has no flags (`LINK_RE.flags === ''`),
  so the addon's `new RegExp(source, flags + 'g')` still works. The early-wrap case now reads the
  same on both sides.
- **No catastrophic backtracking.** Probes of 50 URLs each followed by 3,000 dots, and 50,000 `|`
  after `https://`, ran in about 1 ms. The `(` alternative still cannot overlap the plain class.
- **Click cost.** The resolver reads at most 128 rows of cells, three times per click
  (mousedown, mouseup, click). That is negligible.
- **Unchanged from before.** Markdown `_https://x.y_` now keeps the closing `_`, as the comment says.
  A two-level nested `(…)` (Kibana's rison) is still cut at the inner group. Neither was in scope.
