import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// ONE theme object for all SIX palettes, because every colour is a CSS variable.
//
// This is the whole reason the research picked CodeMirror over Shiki and Monaco: `EditorView.theme`
// generates a real stylesheet through `style-mod`, so `color: 'var(--fg)'` is ordinary CSS that
// resolves at paint time. Shiki and Monaco both bake hex into a theme definition, which would have
// meant six JSON files kept in sync with `themes/*.ts` by hand — and they would have drifted.
//
// Nothing here re-mounts or recomputes when the user switches theme: the variables simply repaint.
//
// SIX PALETTES, NOT FOUR. Finding #4 of the design: three identities (Mission Control, Mr Pink,
// 1984) × light/dark. `CLAUDE.md` still says four themes; the standalone "Light" identity was
// removed. Anything verified by eye here has to be verified six times.

/** §6's five roles plus plain — now on their OWN per-palette tokens, not the ANSI ones.
 *
 *  Six roles is still a DELIBERATE FLOOR: a twenty-role TextMate grammar would need a palette per
 *  theme and would be the first thing to rot.
 *
 *  WHY NOT THE ANSI VARS, which is what this shipped with. The assumption was that they are
 *  "already tuned per palette against that palette's own background" — true for a terminal, false
 *  for small syntax text on the LIGHT palettes, and my own result doc flagged it as the thing to
 *  check. Measured against each palette's `--bg-terminal`: green 2.92 / 2.67 / 2.32:1, yellow
 *  3.05 / 3.03 / 1.86:1, and on 1984-light EVERY role failed — keyword 2.63, type 2.44, attr
 *  2.07, and `--fg-muted` for comments 4.30. QA reported the 1.86 independently.
 *
 *  `--syn-*` is defined in all six palettes, holds hue and saturation, and moves only lightness,
 *  so a palette still reads as itself. `themes/index.test.ts` computes every one of them against
 *  its own ground and fails under 4.5:1, so this cannot regress silently. */
export const codeHighlightStyle = HighlightStyle.define([
  // keyword / control → the reserved-word hue in all six xterm palettes
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--syn-keyword)' },
  // string / char
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: 'var(--syn-string)' },
  // number / constant / boolean
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: 'var(--syn-number)' },
  // comment / doc — comments are meta ink, and this is the app's meta ink
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.docString], color: 'var(--syn-comment)', fontStyle: 'italic' },
  // type / class / function name
  { tag: [t.typeName, t.className, t.namespace, t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--syn-type)' },
  // Everything below is still one of the six — these are the tags that would otherwise fall to
  // plain `--fg` and read flatter than the language deserves, mapped onto a role already listed.
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-type)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--syn-attr)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--syn-comment)' },
  { tag: [t.link, t.url], color: 'var(--syn-attr)', textDecoration: 'underline' },
  { tag: [t.heading], color: 'var(--fg)', fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.invalid], color: 'var(--red)' },
  // everything else → plain code is body text, and inherits `--fg` from the theme below.
])

/** The viewer chrome: gutter, cursor-less selection, the arrival wash.
 *
 *  READ-ONLY WITHOUT THE DISABLED FEEL (§7): no greyed anything, no caret going nowhere. The
 *  cursor is hidden because there is no editing, but the SELECTION is fully painted — selecting
 *  and copying is the point of a viewer, and it is why this is DOM rather than canvas (unlike the
 *  transcript). */
export const codeTheme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    backgroundColor: 'transparent',
    height: '100%',
    fontSize: '11px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    // Lines WRAP (`EditorView.lineWrapping` in FileViewer), so there is normally nothing to
    // scroll sideways. `auto` stays rather than `hidden`: a token with no break opportunity —
    // a base64 blob, a minified bundle — still cannot be wrapped by any rule, and hiding it
    // would make it unreadable instead of merely wide.
    overflowX: 'auto',
  },
  // `anywhere`, so a long unbroken token breaks mid-token rather than pushing the line out. The
  // alternative (`break-word`) leaves exactly the URLs, hashes and base64 that overflow worst.
  '.cm-content': { padding: '6px 0', caretColor: 'transparent', overflowWrap: 'anywhere' },
  '.cm-line': { padding: '0 10px' },

  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--fg-muted)',
    border: 'none',
    // A hairline, not a border on the gutter box: a border here re-rasterizes the whole gutter on
    // a theme change, and this app has a documented WKWebView freeze from exactly that shape.
    boxShadow: 'inset -1px 0 0 var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '3ch' },
  // No active-line emphasis: nothing is "active" in a viewer, and a highlighted line the reader
  // did not ask for competes with the arrival mark, which they did.
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },

  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--overlay-subtle)' },
  '&.cm-focused .cm-selectionBackground, &.cm-focused ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
  },

  // THE ARRIVAL MARK (§4.3). A tint wash, never a fill and never a border — the same technique
  // the diff's `@@` row already uses, and nothing that re-rasterizes on a radiused edge.
  '.cm-line.op-arrival': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)',
    // The wash fades to nothing after the reader has seen it; the gutter mark stays. A permanent
    // highlight becomes noise the moment you scroll, and no mark at all loses the answer to
    // "which line was it?".
    transition: 'background-color 600ms ease-out',
  },
  '.cm-line.op-arrival-faded': { backgroundColor: 'transparent' },
  // The persistent half: a `▸` in the gutter, drawn with a pseudo-element so it costs no layout.
  '.cm-lineNumbers .cm-gutterElement.op-arrival-gutter': { color: 'var(--accent)', position: 'relative' },
  '.cm-lineNumbers .cm-gutterElement.op-arrival-gutter::before': {
    content: '"▸"', position: 'absolute', left: '2px', color: 'var(--accent)',
  },
}, { dark: false })
// `dark: false` is not a claim about the palette — CM6 uses it only to pick its own built-in
// defaults, and every colour above is overridden by a variable. Setting it either way would be
// equally arbitrary; what matters is that nothing here reads a hardcoded hex.
