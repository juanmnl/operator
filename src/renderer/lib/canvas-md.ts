// Canvas chat SPIKE — a small, pure markdown tokenizer.
//
// Why not reuse react-markdown/remark? That path re-parses on every React render and
// its GFM grammar is super-linear (an 80KB table ≈ 21s), which is exactly the freeze the
// DOM ConversationPanel fights with a memo + a 16KB plain-text cap. For a CANVAS renderer
// we want to parse ONCE into a flat layout model we can measure + virtualize, so we need
// our own tokenizer we fully control. This covers the markdown Claude actually emits in
// prose answers (headings, fenced code, bullet/ordered/task lists, GFM tables, blockquotes,
// rules, and inline bold/italic/strike/code/links). It is deliberately NOT full CommonMark —
// nested lists collapse by indent depth. Being pure (string in → data out), it's
// unit-testable without a canvas.

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  href?: string
}

export type Align = 'left' | 'center' | 'right'

export type Block =
  | { type: 'heading'; level: number; spans: Span[] }
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'list'; ordered: boolean; index: number; depth: number; spans: Span[]; checked?: boolean }
  | { type: 'quote'; spans: Span[] }
  | { type: 'table'; headers: Span[][]; aligns: Align[]; rows: Span[][][] }
  | { type: 'hr' }

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/
const UL_RE = /^(\s*)[-*+]\s+(.*)$/
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const FENCE_RE = /^\s*```(.*)$/
const TASK_RE = /^\[([ xX])\]\s+(.*)$/

/** A GFM table separator row, e.g. `| --- | :--: |` (only |:- + space, has a dash). */
function isTableSep(line: string): boolean {
  const s = line.trim()
  return s.includes('-') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s)
}
/** Split a table row into trimmed cell strings (drop the optional leading/trailing pipe). */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** Parse a markdown answer into block-level tokens (one pass, no backtracking). */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', spans: parseInline(para.join(' ').trim()) })
      para = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Fenced code block — consume verbatim until the closing fence (no inline parse).
    const fence = FENCE_RE.exec(line)
    if (fence) {
      flushPara()
      const lang = fence[1].trim() || undefined
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) { body.push(lines[i]); i++ }
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') { flushPara(); continue }

    if (HR_RE.test(line)) { flushPara(); blocks.push({ type: 'hr' }); continue }

    // GFM table: a header row containing pipes followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara()
      const headers = splitRow(line).map(parseInline)
      const aligns: Align[] = splitRow(lines[i + 1]).map((s) => {
        const l = s.startsWith(':'), r = s.endsWith(':')
        return l && r ? 'center' : r ? 'right' : 'left'
      })
      i += 2
      const rows: Span[][][] = []
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]).map(parseInline)); i++
      }
      i-- // step back so the for-loop's i++ lands on the first non-row line
      blocks.push({ type: 'table', headers, aligns, rows })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushPara()
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseInline(heading[2].trim()) })
      continue
    }

    const ol = OL_RE.exec(line)
    if (ol) {
      flushPara()
      blocks.push({ type: 'list', ordered: true, index: parseInt(ol[2], 10), depth: indentDepth(ol[1]), spans: parseInline(ol[3]) })
      continue
    }
    const ul = UL_RE.exec(line)
    if (ul) {
      flushPara()
      // Task-list item? `- [ ] todo` / `- [x] done` → strip the marker, carry the state.
      const task = TASK_RE.exec(ul[2])
      const checked = task ? task[1] !== ' ' : undefined
      const body = task ? task[2] : ul[2]
      blocks.push({ type: 'list', ordered: false, index: 0, depth: indentDepth(ul[1]), spans: parseInline(body), checked })
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      flushPara()
      blocks.push({ type: 'quote', spans: parseInline(quote[1]) })
      continue
    }

    para.push(line)
  }
  flushPara()
  return blocks
}

/** Two spaces (or a tab) of leading indent = one nesting level, capped so a rogue
 *  deep indent can't push list text off the panel. */
function indentDepth(indent: string): number {
  const cols = indent.replace(/\t/g, '  ').length
  return Math.min(3, Math.floor(cols / 2))
}

// Inline scanner: walks the string once, opening/closing the simplest span kinds.
// Precedence: backtick code (opaque — no nesting) > link > bold (** or __) > italic
// (* or _). Unmatched markers are emitted as literal text so partial/streaming markdown
// never drops characters.
export function parseInline(text: string): Span[] {
  const spans: Span[] = []
  let i = 0
  let buf = ''
  const flush = (extra?: Partial<Span>) => {
    if (buf) { spans.push({ text: buf, ...extra }); buf = '' }
  }
  while (i < text.length) {
    const c = text[i]

    // `code`
    if (c === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) { flush(); spans.push({ text: text.slice(i + 1, end), code: true }); i = end + 1; continue }
    }

    // [label](href)
    if (c === '[') {
      const close = text.indexOf(']', i + 1)
      if (close > i && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2)
        if (paren > close) {
          flush()
          const label = text.slice(i + 1, close)
          const href = text.slice(close + 2, paren).trim()
          // Links carry inline styling of their label too, but keep the spike simple:
          // one span, styled as a link, label shown as-is.
          spans.push({ text: label, href })
          i = paren + 1
          continue
        }
      }
    }

    // ~~strikethrough~~
    if (c === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2)
      if (end > i + 1) { flush(); spans.push({ text: text.slice(i + 2, end), strike: true }); i = end + 2; continue }
    }

    // **bold** / __bold__
    if ((c === '*' || c === '_') && text[i + 1] === c) {
      const marker = c + c
      const end = text.indexOf(marker, i + 2)
      if (end > i + 1) { flush(); spans.push({ text: text.slice(i + 2, end), bold: true }); i = end + 2; continue }
    }

    // *italic* / _italic_ — require non-empty content (end > i + 1) so an UNCLOSED
    // bold marker (`**open`) doesn't get consumed here as an empty italic; the markers
    // then fall through to literal text, keeping streaming/partial markdown intact.
    if (c === '*' || c === '_') {
      const end = text.indexOf(c, i + 1)
      if (end > i + 1 && text[i + 1] !== ' ') { flush(); spans.push({ text: text.slice(i + 1, end), italic: true }); i = end + 1; continue }
    }

    buf += c
    i++
  }
  flush()
  return spans.length ? spans : [{ text: '' }]
}
