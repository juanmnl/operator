import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { AgentSession, NarrationEntry, Role } from '../../../shared/types'
import { parseBlocks, type Block, type Span } from '../../lib/canvas-md'
import { MEASURE_FORM } from '../settings/PageShell'
import { stripDispatchLines } from '../../lib/roster'
import { sessionLabel } from '../../lib/session-label'
import { laneTextColor } from '../../lib/lane-color'
import { fmtDur } from '../../lib/format'
import { isRenderableTurn } from '../../lib/chat-turns'
import { coalesceTools, runLabel, runDetail, type ToolRun } from '../../lib/tool-blocks'
import { chatSignal } from '../../lib/chat-signal'
import { StatusWave } from '../sidebar/StatusWave'
import { stripAnsi } from '../../lib/terminal'
import { ChatComposer } from './ChatComposer'

// Canvas chat SPIKE — renders the conversation PAINTED on one <canvas> instead of the
// react-markdown DOM panel. The DOM panel re-parses markdown every render (super-linear
// GFM grammar → the 80KB-table freeze) and caps big answers to plain <pre> at 16KB. Here
// we parse ONCE into a block model (lib/canvas-md), lay it into positioned lines, and
// virtualize the paint (only the visible slice draws) — no freeze, no size cap.
//
// Look is a document-style transcript (not iMessage bubbles): full width, each turn led by
// a small role marker (dot + label + time), assistant prose flush to the column. Canvas
// can't do native text selection, so links are click-through (hit-tested against the same
// layout ops) and a whole turn copies on double-click.

// ---- theme snapshot (read CSS vars once per relayout) --------------------------------
interface Theme {
  fg: string; fgMuted: string; accent: string
  /** The lane's colour as TEXT (ink-blended for light themes) — the agent turn's name. */
  laneInk: string
  /** The lane's colour at FULL strength — the turn's orb. Dots aren't held to a text
   *  contrast ratio, so they carry the lane identity undiluted (see lib/lane-color). */
  laneDot: string
  border: string; codeBg: string; userBg: string; fontBody: string; fontMono: string
}
// `laneTextColor` returns a `color-mix(… var(--fg) var(--lane-ink-blend))` expression, and
// canvas `fillStyle` parses neither color-mix nor var(). Resolving it means letting CSS do
// it: a throwaway probe INSIDE the scroller inherits the theme's --fg/--lane-ink-blend, and
// its computed `color` comes back as a flat rgb() the canvas can paint.
function resolveColor(el: HTMLElement, css: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  probe.style.color = css
  el.appendChild(probe)
  const out = getComputedStyle(probe).color
  probe.remove()
  return out || fallback
}
function readTheme(el: HTMLElement, laneAccent?: string): Theme {
  const s = getComputedStyle(el)
  const v = (n: string, f: string) => s.getPropertyValue(n).trim() || f
  const fgMuted = v('--fg-muted', '#8a8f98')
  // No lane (an unassigned session) keeps the original muted treatment — a chat with no
  // role to name shouldn't invent a colour for itself.
  const accent = laneAccent?.trim()
  return {
    fg: v('--fg', '#eef1f3'),
    fgMuted,
    accent: v('--accent', '#7ee787'),
    laneInk: accent ? resolveColor(el, laneTextColor(accent), fgMuted) : fgMuted,
    laneDot: accent || fgMuted,
    border: v('--border', '#2a2a35'),
    codeBg: 'rgba(127,127,127,0.13)',
    // §3's user-turn tint. Neutral grey rather than an accent wash: it marks WHOSE turn it
    // is, it is not a state, and a coloured fill would break the no-accent-fill rule.
    userBg: 'rgba(127,127,127,0.07)',
    fontBody: v('--font-body', 'Archivo, system-ui, sans-serif'),
    fontMono: v('--font-mono', 'JetBrains Mono, ui-monospace, monospace'),
  }
}

// ---- layout model --------------------------------------------------------------------
const MARGIN = 18, TURN_GAP = 22, BLOCK_GAP = 7, HEADER_H = 22
/** Code/table measure (§1): wider than prose because they're scanned, not read. */
const MEASURE_WIDE = 960
/** A tool line is punctuation: one line, tight, muted. */
const TOOL_LH = 19
const TOOL_MARK = '⟩'
const PROSE = 13.5, PROSE_LH = 21, CODE = 12, CODE_LH = 18

type Seg = { text: string; x: number; font: string; color: string; code?: boolean; strike?: boolean; href?: string; w?: number }
type Op =
  | { kind: 'header'; x: number; y: number; role: 'user' | 'agent'; label: string; time: string; top: number; bottom: number }
  | { kind: 'codebg'; x: number; y: number; w: number; h: number; top: number; bottom: number }
  // §3: the quiet container behind a USER turn. Not a bubble — no right-alignment, no accent
  // fill, no left-edge stripe; a tint is the marker, and it is what lets you find your own
  // instructions when skimming back.
  | { kind: 'userbg'; x: number; y: number; w: number; h: number; top: number; bottom: number }
  | { kind: 'rule'; x: number; y: number; w: number; top: number; bottom: number }
  | { kind: 'vbar'; x: number; y: number; h: number; top: number; bottom: number }
  | { kind: 'segs'; y: number; h: number; segs: Seg[]; top: number; bottom: number }
  // Table frame: outer box + header underline + internal column/row separators. Cell text
  // rides as normal `segs` ops. colX/rowY are ABSOLUTE (content-space) separator positions.
  | { kind: 'tframe'; x: number; y: number; w: number; h: number; headerBottom: number; colX: number[]; rowY: number[]; top: number; bottom: number }
type TurnBound = { top: number; bottom: number; text: string; key: string; kind: string }
interface Layout { ops: Op[]; height: number; bounds: TurnBound[] }

// Per-answer state — SAME localStorage keys as the DOM ConversationPanel, so answers you'd
// already starred/dismissed there carry straight over to the canvas panel.
const SAVED_KEY = 'operator.answers.saved'
const DISMISSED_KEY = 'operator.answers.dismissed'
/** Stable-ish identity for a turn across re-emits (timestamp + length + head). */
function blockKey(m: NarrationEntry): string {
  return `${m.timestamp}|${m.text.length}|${m.text.slice(0, 40)}`
}
function loadSet(k: string): Set<string> {
  try { const r = localStorage.getItem(k); return new Set<string>(r ? JSON.parse(r) : []) } catch { return new Set() }
}
function persistSet(k: string, s: Set<string>) {
  try { localStorage.setItem(k, JSON.stringify([...s])) } catch { /* quota */ }
}

function fontFor(sp: Span, size: number, t: Theme): string {
  if (sp.code) return `${size - 1}px ${t.fontMono}`
  const style = sp.italic ? 'italic ' : ''
  const weight = sp.bold ? '600 ' : ''
  return `${style}${weight}${size}px ${t.fontBody}`
}

// Symbol glyphs (⌘ ● ◉ ⏺ ▸ ✔ arrows, keycaps, emoji, …) whose FONT advance is often narrower
// than their ink — so the next character overlaps them. We isolate these and advance by their
// real ink extent (see tokenAdvance), which fixes the "⌘N / ●LANE collide" spacing.
function isSymbol(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return cp > 0xffff ||                       // astral plane (emoji, legacy-computing, …)
    (cp >= 0x2190 && cp <= 0x2bff) ||         // arrows, technical, geometric shapes, dingbats
    cp === 0xfe0f || cp === 0x20e3            // emoji variation selector / combining keycap
}

// Split a word into runs: each symbol char becomes its own token (so we can give it an
// ink-based advance), while ordinary text stays grouped (preserving its kerning). Iterates by
// code point so surrogate-pair emoji stay intact.
function tokenizeWord(word: string): string[] {
  const out: string[] = []
  let buf = ''
  for (const ch of word) {
    if (isSymbol(ch)) { if (buf) { out.push(buf); buf = '' } out.push(ch) }
    else buf += ch
  }
  if (buf) out.push(buf)
  return out
}

// Advance width for a token. For a symbol token whose ink overruns its advance box, return the
// ink right edge + a hair of breathing room so the following glyph can never sit on top of it.
function tokenAdvance(ctx: CanvasRenderingContext2D, tok: string): number {
  const m = ctx.measureText(tok)
  if (tok.length <= 2 && isSymbol(tok)) {
    const ink = m.actualBoundingBoxRight ?? m.width
    return Math.max(m.width, ink) + 1.5
  }
  return m.width
}

// Greedy word-wrap a run of inline spans into positioned segments (x relative to the block
// left edge). Each word keeps its own font/colour/href so bold/italic/code/links flow
// inline, and its measured width so links can be hit-tested and code chips drawn.
function flowSpans(
  ctx: CanvasRenderingContext2D, spans: Span[], maxW: number, size: number, baseColor: string, t: Theme,
): { lines: Seg[][] } {
  const lines: Seg[][] = []
  let cur: Seg[] = []
  let x = 0
  for (const sp of spans) {
    const font = fontFor(sp, size, t)
    const color = sp.href ? t.accent : baseColor
    ctx.font = font
    const words = sp.text.match(/\S+\s*|\s+/g) || []
    for (let word of words) {
      let w = ctx.measureText(word).width
      if (x + w > maxW && x > 0) { lines.push(cur); cur = []; x = 0; word = word.replace(/^\s+/, ''); w = ctx.measureText(word).width }
      if (word === '') continue
      const meta = { font, color, code: sp.code, strike: sp.strike, href: sp.href }
      let hasSym = false
      for (const ch of word) { if (isSymbol(ch)) { hasSym = true; break } }
      // Fast path: no symbols → one seg for the whole (kerned) word. Otherwise flow each token
      // with a symbol-aware advance so nothing collides with the glyph after it.
      if (!hasSym) {
        cur.push({ text: word, x, ...meta, w })
        x += w
      } else {
        for (const tok of tokenizeWord(word)) {
          const adv = tokenAdvance(ctx, tok)
          cur.push({ text: tok, x, ...meta, w: adv })
          x += adv
        }
      }
    }
  }
  lines.push(cur)
  return { lines }
}

function flowCode(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, t: Theme): string[] {
  ctx.font = `${size}px ${t.fontMono}`
  const out: string[] = []
  for (const raw of text.split('\n')) {
    if (ctx.measureText(raw).width <= maxW || raw === '') { out.push(raw); continue }
    let line = ''
    for (const ch of raw) {
      if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch }
      else line += ch
    }
    out.push(line)
  }
  return out
}

const blockCache = new Map<string, Block[]>()
function cachedBlocks(text: string): Block[] {
  let b = blockCache.get(text)
  if (!b) { b = parseBlocks(text); if (blockCache.size > 400) blockCache.clear(); blockCache.set(text, b) }
  return b
}

// Lay out a GFM table: measure columns, cap to the available width, render header + rows as
// aligned `segs` ops, plus one `tframe` op for the box + column/row separators.
function emitTable(ctx: CanvasRenderingContext2D, ops: Op[], blk: Extract<Block, { type: 'table' }>, x: number, startY: number, width: number, t: Theme): number {
  const cols = Math.max(1, blk.headers.length)
  const padH = 8, padV = 5
  const colContentW = new Array<number>(cols).fill(0)
  const measure = (cells: Span[][]) => {
    for (let c = 0; c < cols; c++) {
      let w = 0
      for (const sp of cells[c] || []) { ctx.font = fontFor(sp, PROSE, t); w += ctx.measureText(sp.text).width }
      colContentW[c] = Math.max(colContentW[c], w)
    }
  }
  measure(blk.headers)
  blk.rows.forEach(measure)
  let colW = colContentW.map((w) => Math.max(36, w) + padH * 2)
  let total = colW.reduce((a, b) => a + b, 0)
  if (total > width) { const scale = width / total; colW = colW.map((w) => w * scale); total = width }
  const cxs: number[] = [x]
  for (let c = 0; c < cols; c++) cxs.push(cxs[c] + colW[c])

  // Flow every row's cells FIRST (measure only) so we know the geometry; then push the
  // frame op, then the cell text — so the frame's header fill paints UNDER the text.
  const rows = [{ cells: blk.headers, header: true }, ...blk.rows.map((r) => ({ cells: r, header: false }))]
  const flowed = rows.map(({ cells, header }) => {
    const cellLines: Seg[][][] = []
    let maxLines = 1
    for (let c = 0; c < cols; c++) {
      const raw = cells[c] || []
      const spans: Span[] = header ? raw.map((s) => ({ ...s, bold: true })) : raw
      const { lines } = flowSpans(ctx, spans.length ? spans : [{ text: '' }], colW[c] - padH * 2, PROSE, t.fg, t)
      cellLines.push(lines)
      maxLines = Math.max(maxLines, lines.length)
    }
    return { cellLines, rowH: maxLines * PROSE_LH + padV * 2 }
  })
  const rowTop: number[] = []
  let y = startY
  for (const f of flowed) { rowTop.push(y); y += f.rowH }
  const headerBottom = rowTop[1] ?? y // top of the first data row = bottom of the header

  // Frame first (header bg + borders under the text).
  ops.push({ kind: 'tframe', x, y: startY, w: total, h: y - startY, headerBottom, colX: cxs.slice(1, -1), rowY: rowTop.slice(2), top: startY, bottom: y })

  // Then the cell text, aligned per column.
  flowed.forEach((f, ri) => {
    for (let c = 0; c < cols; c++) {
      const align = blk.aligns[c] || 'left'
      const inner = colW[c] - padH * 2
      f.cellLines[c].forEach((segs, li) => {
        const lineW = segs.reduce((mx, s) => Math.max(mx, s.x + (s.w ?? 0)), 0)
        let dx = cxs[c] + padH
        if (align === 'center') dx += Math.max(0, (inner - lineW) / 2)
        else if (align === 'right') dx += Math.max(0, inner - lineW)
        const shifted = segs.map((s) => ({ ...s, x: dx + s.x }))
        const ly = rowTop[ri] + padV + li * PROSE_LH
        ops.push({ kind: 'segs', y: ly, h: PROSE_LH, segs: shifted, top: ly, bottom: ly + PROSE_LH })
      })
    }
  })
  return y
}

// Emit an agent answer's blocks as positioned ops at column [x, x+width], returning the
// next Y. Prose is full-width (no bubble) — role is conveyed by the header marker above.
/** `wideX`/`wideWidth` are the CODE/TABLE measure — wider than prose on purpose (§1). They
 *  default to the prose column so callers that don't care (the thinking preview) are unchanged. */
function emitBlocks(ctx: CanvasRenderingContext2D, ops: Op[], blocks: Block[], x: number, startY: number, width: number, t: Theme, wideX: number = x, wideWidth: number = width): number {
  let y = startY
  const pushLines = (lines: Seg[][], lh: number, dx: number, prefix?: Seg) => {
    lines.forEach((segs, li) => {
      const shifted = segs.map((s) => ({ ...s, x: x + dx + s.x }))
      if (li === 0 && prefix) shifted.unshift(prefix)
      ops.push({ kind: 'segs', y, h: lh, segs: shifted, top: y, bottom: y + lh }); y += lh
    })
  }
  blocks.forEach((blk, bi) => {
    if (bi > 0) y += BLOCK_GAP
    if (blk.type === 'hr') {
      ops.push({ kind: 'rule', x, y: y + 5, w: width, top: y + 5, bottom: y + 6 }); y += 11
    } else if (blk.type === 'code') {
      // Code runs at the WIDE measure (§1) — scanned, not read line by line.
      const codeLines = flowCode(ctx, blk.text, wideWidth - 20, CODE, t)
      const labelH = blk.lang ? 15 : 0
      const boxH = codeLines.length * CODE_LH + 14 + labelH
      ops.push({ kind: 'codebg', x: wideX, y, w: wideWidth, h: boxH, top: y, bottom: y + boxH })
      if (blk.lang) {
        ops.push({ kind: 'segs', y: y + 5, h: 14, segs: [{ text: blk.lang.toUpperCase(), x: wideX + 10, font: `600 9px ${t.fontMono}`, color: t.fgMuted }], top: y + 5, bottom: y + 19 })
      }
      let cy = y + 7 + labelH
      for (const cl of codeLines) {
        ops.push({ kind: 'segs', y: cy, h: CODE_LH, segs: [{ text: cl, x: wideX + 10, font: `${CODE}px ${t.fontMono}`, color: t.fg }], top: cy, bottom: cy + CODE_LH }); cy += CODE_LH
      }
      y += boxH
    } else if (blk.type === 'heading') {
      const size = blk.level <= 1 ? 18 : blk.level === 2 ? 16 : blk.level === 3 ? 14.5 : 13.5
      const lh = Math.round(size * 1.5)
      const { lines } = flowSpans(ctx, blk.spans.map((s) => ({ ...s, bold: true })), width, size, t.fg, t)
      pushLines(lines, lh, 0)
    } else if (blk.type === 'list') {
      // Task list → checkbox glyph (accent when checked); otherwise the bullet / number.
      const isTask = blk.checked !== undefined
      const prefix = isTask ? (blk.checked ? '☑' : '☐') : blk.ordered ? `${blk.index}.` : '•'
      const prefixColor = blk.checked ? t.accent : t.fgMuted
      const indent = 16 * blk.depth
      ctx.font = `${PROSE}px ${t.fontBody}`
      const pw = ctx.measureText(prefix + '  ').width
      const { lines } = flowSpans(ctx, blk.spans, width - indent - pw, PROSE, t.fg, t)
      pushLines(lines, PROSE_LH, indent + pw, { text: prefix, x: x + indent, font: `${PROSE}px ${t.fontBody}`, color: prefixColor })
    } else if (blk.type === 'quote') {
      const { lines } = flowSpans(ctx, blk.spans, width - 14, PROSE, t.fgMuted, t)
      ops.push({ kind: 'vbar', x, y, h: lines.length * PROSE_LH, top: y, bottom: y + lines.length * PROSE_LH })
      pushLines(lines, PROSE_LH, 14)
    } else if (blk.type === 'table') {
      y = emitTable(ctx, ops, blk, wideX, y, wideWidth, t)
    } else {
      const { lines } = flowSpans(ctx, blk.spans, width, PROSE, t.fg, t)
      pushLines(lines, PROSE_LH, 0)
    }
  })
  return y
}

/** One line of a thought, as a preview. Kept short — the point of the collapsed state is
 *  that it costs a line, not a screen. */
function thoughtPreview(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function layout(ctx: CanvasRenderingContext2D, turns: (NarrationEntry | ToolRun)[], cssW: number, t: Theme, expanded: Set<string>, agentLabel: string): Layout {
  const ops: Op[] = []
  const bounds: TurnBound[] = []
  // §1 — CAP THE MEASURE. At a 1680px window the column ran 1400px ≈ 180 characters per
  // line, which is why the panel read as a log rather than as writing. 720 is MEASURE_FORM,
  // the app's existing prose measure (settings pages) — reused rather than inventing a
  // chat-specific number. Centred in the PANEL, which already sits beside the sidebar.
  //
  // Code and tables are SCANNED, not read line by line, so they get a wider cap; wrapping a
  // code sample to a paragraph's measure helps nobody.
  const avail = Math.max(120, cssW - MARGIN * 2)
  const contentW = Math.min(MEASURE_FORM, avail)
  const contentL = Math.round((cssW - contentW) / 2)
  const wideW = Math.min(MEASURE_WIDE, avail)
  const wideL = Math.round((cssW - wideW) / 2)
  let y = 16
  // Who spoke last, so a run of turns from one side reads as one block (§3).
  let prevRole: 'user' | 'agent' | null = null

  for (const m of turns) {
    const role: 'user' | 'agent' = m.kind === 'user' ? 'user' : 'agent'
    const turnTop = y
    const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    // TOOL RUN — the action stream, rendered as PUNCTUATION between prose (critique §A):
    // one muted line per run of same-tool calls, no card, no header, no box. A wall of cards
    // is exactly what this must not become, so a run of seven reads costs one line.
    if (m.kind === 'toolrun') {
      const label = runLabel(m)
      const detail = runDetail(m)
      const seg: Seg[] = [{ text: `${TOOL_MARK} ${label}`, font: `11px ${t.fontBody}`, color: t.fgMuted, x: 0 }]
      if (detail) seg.push({ text: `  ${detail}`, font: `10.5px ${t.fontMono}`, color: t.fgMuted, x: 0 })
      // Lay the segments end to end (flowSpans is for wrapped prose; this line never wraps).
      let sx = 0
      for (const sgm of seg) { ctx.font = sgm.font!; sgm.x = contentL + sx; sx += ctx.measureText(sgm.text).width }
      ops.push({ kind: 'segs', y, h: TOOL_LH, segs: seg, top: y, bottom: y + TOOL_LH })
      y += TOOL_LH
      bounds.push({ top: turnTop, bottom: y, text: label, key: `toolrun:${m.timestamp}:${m.name}`, kind: 'toolrun' })
      y += Math.round(TURN_GAP / 2) // tighter than a turn — it is punctuation, not a turn
      continue
    }

    // THINKING — the third state (critique §3): neither thrown away nor always inlined. One
    // muted line you can click open, so the reasoning is recoverable without it competing
    // with the answer for the reader's attention.
    if (m.kind === 'thinking') {
      const open = expanded.has(blockKey(m))
      ops.push({ kind: 'header', x: contentL, y, role: 'agent', label: open ? 'Thought ▾' : 'Thought ▸', time, top: y, bottom: y + HEADER_H })
      y += HEADER_H
      const body = open ? m.text : thoughtPreview(m.text)
      for (const rawline of body.split('\n')) {
        if (rawline.trim() === '') { y += Math.round(PROSE_LH * 0.5); continue }
        const { lines } = flowSpans(ctx, [{ text: rawline }], contentW, PROSE, t.fgMuted, t)
        for (const segs of lines) {
          ops.push({ kind: 'segs', y, h: PROSE_LH, segs: segs.map((sg) => ({ ...sg, x: contentL + sg.x })), top: y, bottom: y + PROSE_LH }); y += PROSE_LH
        }
      }
      bounds.push({ top: turnTop, bottom: y, text: m.text, key: blockKey(m), kind: m.kind })
      y += TURN_GAP
      prevRole = null // a thought interrupts the run; the next answer re-announces its lane
      continue
    }

    // §3: consecutive turns from the same speaker don't repeat the header, and a user turn
    // has none at all (its tint is the identity; the timestamp lives on hover).
    if (role === 'agent' && prevRole !== 'agent') {
      ops.push({ kind: 'header', x: contentL, y, role, label: agentLabel, time, top: y, bottom: y + HEADER_H })
      y += HEADER_H
    }
    prevRole = role

    if (role === 'user') {
      // The tint says "you", so the YOU label is redundant — dropping it is most of the
      // density win (a one-word turn was costing what a decision costs). The container is
      // measured first, then back-filled once its height is known.
      const bgIndex = ops.length
      const padX = 11, padY = 8
      y += padY
      const innerW = contentW - padX * 2
      for (const rawline of m.text.split('\n')) {
        if (rawline.trim() === '') { y += Math.round(PROSE_LH * 0.5); continue }
        const { lines } = flowSpans(ctx, [{ text: rawline }], innerW, PROSE, t.fg, t)
        for (const segs of lines) {
          ops.push({ kind: 'segs', y, h: PROSE_LH, segs: segs.map((s) => ({ ...s, x: contentL + padX + s.x })), top: y, bottom: y + PROSE_LH }); y += PROSE_LH
        }
      }
      y += padY
      ops.splice(bgIndex, 0, { kind: 'userbg', x: contentL, y: turnTop, w: contentW, h: y - turnTop, top: turnTop, bottom: y })
    } else {
      y = emitBlocks(ctx, ops, cachedBlocks(m.text), contentL, y, contentW, t, wideL, wideW)
    }

    bounds.push({ top: turnTop, bottom: y, text: m.text, key: blockKey(m), kind: m.kind })
    y += TURN_GAP
  }
  return { ops, height: y, bounds }
}

// ---- component -----------------------------------------------------------------------
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// A canvas header is drawn, not laid out, so a long first-prompt summary would run under
// the timestamp instead of ellipsing. The sidebar can afford the full ladder; here it gets
// clipped to a name-sized string.
const NAME_MAX = 32
function shortLabel(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1)}…` : flat
}

export function CanvasConversation({ session, role, customName, accent, onModelChange, onEffortChange }: {
  session?: AgentSession
  /** The lane this session runs on — names the agent's turns. */
  role?: Role
  /** A user rename, which outranks the lane name (same ladder as the sidebar). */
  customName?: string
  /** The colour the session actually draws with (lane's, else its own override) — pass
   *  the dashboard's `accentOf` so chat agrees with the sidebar on a lane-less session. */
  accent?: string
  onModelChange?: (model: string) => void
  onEffortChange?: (effort: 'high' | 'normal' | 'low') => void
}) {
  // WHO is talking, by the one shared ladder (lib/session-label): a rename, then the lane,
  // then its own first prompt, then the model. This surface used to hardcode 'Agent', which
  // is exactly the three-surfaces-three-rules drift that ladder exists to prevent.
  const agentLabel = shortLabel(
    session ? sessionLabel({ session, role, customName, fallback: 'Agent' }) : 'Agent',
  )
  const laneAccent = accent ?? role?.accent
  // Read through refs so `relayout` (declared below, closing over these) keeps its lean dep
  // list; the effect further down syncs them and repaints when the lane changes under us.
  const labelRef = useRef(agentLabel)
  const laneRef = useRef(laneAccent)
  // Same durable-history + live-tail merge as ConversationPanel (kept local so the spike
  // doesn't touch the shipping panel). history = full ordered record from the SQLite store;
  // session.messages = freshest tail that may lag ~1s. Dedupe by (timestamp|len|head).
  const [history, setHistory] = useState<NarrationEntry[]>([])
  useEffect(() => {
    const id = session?.id
    setHistory([])
    if (!id) return
    let cancelled = false
    const load = () => window.operator.chatHistory?.(id)
      .then((h) => { if (!cancelled && h && h.length) setHistory((prev) => (h.length > prev.length ? h : prev)) })
      .catch(() => { /* store unavailable */ })
    load()
    const iv = window.setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [session?.id])

  const turns = useMemo(() => {
    const byKey = new Map<string, NarrationEntry>()
    const order: string[] = []
    for (const m of [...history, ...(session?.messages ?? [])]) {
      // One predicate for what the reading surface may show (lib/chat-turns): real prompts
      // and answers, minus Claude Code's plumbing turns, minus SIGNATURE-ONLY thinking blocks
      // — which is all of them in practice, so the collapsible Thought block could never
      // open. The parse path stays, so it lights up by itself if real thinking text ever
      // arrives; what it must not do is render an empty disclosure.
      if (!isRenderableTurn(m)) continue
      const k = blockKey(m) // key on the RAW text — history and tail must dedupe identically
      if (byKey.has(k)) continue
      // Orchestrator dispatch directives are protocol, not prose — the dispatch log shows
      // them; strip from the reading surface (drop the turn if that's all it was). ANSI comes
      // off everything: terminal output quoted in an answer arrives with raw SGR codes, which
      // paint as replacement glyphs plus a literal "[1m" on a canvas that has no notion of
      // escape sequences.
      const text = stripAnsi(m.kind === 'text' ? stripDispatchLines(m.text) : m.text)
      if (!text.trim()) { byKey.set(k, m); continue } // consumed, but still deduped
      byKey.set(k, text === m.text ? m : { ...m, text })
      order.push(k)
    }
    // Fold consecutive same-tool calls into runs LAST, so dedupe and filtering still see
    // individual entries (lib/tool-blocks).
    return coalesceTools(order.map((k) => byKey.get(k)!))
  }, [history, session?.messages])

  // Dev-only test seam: the transcript is PAINTED, so a harness has no DOM to query for
  // "what is chat actually showing". Publishing the laid-out turns makes the reading surface
  // assertable (injected-turn filtering, ANSI stripping, dispatch-line stripping). The guard
  // compiles the whole thing out of production builds.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __canvasTurns?: unknown[] }).__canvasTurns = turns
  }, [turns])

  // Per-answer reading state (starred / dismissed), search + saved-only filter — ported
  // from the DOM ConversationPanel so the canvas panel has the same affordances.
  const [saved, setSaved] = useState<Set<string>>(() => loadSet(SAVED_KEY))
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadSet(DISMISSED_KEY))
  const [search, setSearch] = useState('')
  const [savedOnly, setSavedOnly] = useState(false)
  const q = search.trim().toLowerCase()

  const visible = useMemo(() => turns.filter((m) => {
    // A tool RUN is punctuation, not an answer: it can't be starred or dismissed, and in
    // saved-only mode it drops with everything else. Search still matches its label.
    if (m.kind === 'toolrun') return !savedOnly && (!q || runLabel(m).toLowerCase().includes(q))
    const k = blockKey(m)
    if (m.kind === 'text' && dismissed.has(k)) return false           // dismissed answers hide
    if (savedOnly && !(m.kind === 'text' && saved.has(k))) return false // saved-only ⇒ user turns drop too
    if (q && !m.text.toLowerCase().includes(q)) return false           // search filters prompts + answers
    return true
  }), [turns, dismissed, savedOnly, saved, q])

  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layoutRef = useRef<Layout>({ ops: [], height: 0, bounds: [] })
  const themeRef = useRef<Theme | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [spacerH, setSpacerH] = useState(0)
  const stickRef = useRef(true)
  /** True until the first layout has been positioned — that one snaps (trap 3). */
  const firstPaintRef = useRef(true)
  /** Last known max scroll offset, to tell content GROWTH from a plain re-layout. */
  const lastMaxRef = useRef(0)
  const [flash, setFlash] = useState<string | null>(null)
  // Liveness (dev/briefs/chat-signals-and-interrupt.md). `signal` is a pure read of fields
  // already on the wire — the same ones driving the sidebar orb — so chat finally says what
  // the agent is doing instead of going silent for minutes at a time.
  const signal = chatSignal(session)
  // Elapsed is measured from the last PHASE CHANGE, not from session start: "12s" means "12s
  // in this state", which is the number a waiting human is actually asking for.
  const phaseKey = `${session?.status ?? ''}:${session?.phase ?? ''}:${session?.lastToolName ?? ''}`
  const [phaseSince, setPhaseSince] = useState(() => Date.now())
  useEffect(() => { setPhaseSince(Date.now()) }, [phaseKey])
  // Below a second there is nothing worth reporting — "3ms" is noise where the brief's
  // example is "12s". The clock appears once the wait is real.
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!signal?.animate) { setElapsedMs(0); return } // only a BUSY state has a clock worth watching
    setElapsedMs(Date.now() - phaseSince)
    const iv = window.setInterval(() => setElapsedMs(Date.now() - phaseSince), 1000)
    return () => clearInterval(iv)
  }, [signal?.animate, phaseSince])
  // Scrolled away from the live edge → the jump-to-latest control appears, and doubles as the
  // running indicator (one control, two jobs).
  const [atEdge, setAtEdge] = useState(true)
  // Which `thinking` turns are open. A ref alongside the state because layout() runs from a
  // callback that must not re-subscribe on every toggle.
  const [expandedThoughts, setExpandedThoughts] = useState<Set<string>>(() => new Set())
  const expandedRef = useRef(expandedThoughts)
  expandedRef.current = expandedThoughts
  const flashMsgRef = useRef<((m: string) => void) | null>(null)
  // Hover action toolbar: which turn the pointer is over (key + kind + viewport y). Updated
  // only when the hovered turn CHANGES (hoverKeyRef guard) so mousemove stays cheap.
  const [hover, setHover] = useState<{ key: string; kind: string; y: number } | null>(null)
  const hoverKeyRef = useRef<string | null>(null)

  const flashMsg = useCallback((m: string) => { setFlash(m); setTimeout(() => setFlash(null), 1100) }, [])
  flashMsgRef.current = flashMsg

  const paint = useCallback(() => {
    const canvas = canvasRef.current, scroller = scrollRef.current
    if (!canvas || !scroller) return
    const ctx = canvas.getContext('2d')
    const t = themeRef.current
    if (!ctx || !t) return
    const dpr = window.devicePixelRatio || 1
    const vw = scroller.clientWidth, vh = scroller.clientHeight
    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
      canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr)
      canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, vw, vh)
    ctx.textBaseline = 'top'
    const scrollTop = scroller.scrollTop
    const vTop = scrollTop, vBot = scrollTop + vh
    for (const op of layoutRef.current.ops) {
      if (op.bottom < vTop || op.top > vBot) continue
      const y = op.top - scrollTop
      if (op.kind === 'header') {
        // The agent side wears its LANE's colour — orb at full strength, name ink-blended
        // so it stays legible on light themes. The user side keeps the app accent.
        const isUser = op.role === 'user'
        ctx.beginPath(); ctx.arc(op.x + 3, y + 7, 3, 0, Math.PI * 2)
        ctx.fillStyle = isUser ? t.accent : t.laneDot; ctx.fill()
        const hadLS = 'letterSpacing' in ctx
        if (hadLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0.1em'
        ctx.font = `600 10px ${t.fontMono}`; ctx.fillStyle = isUser ? t.accent : t.laneInk
        ctx.fillText(op.label.toUpperCase(), op.x + 12, y + 2)
        const lw = ctx.measureText(op.label.toUpperCase()).width
        if (hadLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px'
        ctx.font = `10px ${t.fontBody}`; ctx.fillStyle = t.fgMuted
        ctx.globalAlpha = 0.7; ctx.fillText(op.time, op.x + 12 + lw + 10, y + 2); ctx.globalAlpha = 1
      } else if (op.kind === 'userbg') {
        roundRect(ctx, op.x, y, op.w, op.h, 10)
        ctx.fillStyle = t.userBg; ctx.fill()
      } else if (op.kind === 'codebg') {
        roundRect(ctx, op.x, y, op.w, op.h, 7); ctx.fillStyle = t.codeBg; ctx.fill()
      } else if (op.kind === 'rule') {
        const ry = Math.round(y) + 0.5
        ctx.strokeStyle = t.border; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(op.x, ry); ctx.lineTo(op.x + op.w, ry); ctx.stroke()
      } else if (op.kind === 'vbar') {
        ctx.fillStyle = t.border; ctx.fillRect(op.x, y, 2, op.h)
      } else if (op.kind === 'tframe') {
        // Header fill, then the outer box + header underline + column/row separators.
        ctx.fillStyle = t.codeBg
        ctx.fillRect(op.x, y, op.w, op.headerBottom - op.y)
        ctx.strokeStyle = t.border; ctx.lineWidth = 1
        ctx.strokeRect(Math.round(op.x) + 0.5, Math.round(y) + 0.5, Math.round(op.w), Math.round(op.h))
        const line = (cy: number) => { const yr = Math.round(cy) + 0.5; ctx.beginPath(); ctx.moveTo(op.x, yr); ctx.lineTo(op.x + op.w, yr); ctx.stroke() }
        line(op.headerBottom - scrollTop)
        for (const ry of op.rowY) line(ry - scrollTop)
        for (const vx of op.colX) { const xv = Math.round(vx) + 0.5; ctx.beginPath(); ctx.moveTo(xv, y); ctx.lineTo(xv, y + op.h); ctx.stroke() }
      } else if (op.kind === 'segs') {
        for (const s of op.segs) {
          if (s.code) {
            ctx.font = s.font
            const w = s.w ?? ctx.measureText(s.text).width
            roundRect(ctx, s.x - 3, y - 1, w + 6, 17, 3); ctx.fillStyle = t.codeBg; ctx.fill()
          }
          ctx.font = s.font; ctx.fillStyle = s.color
          ctx.fillText(s.text, s.x, y)
          if (s.href) { ctx.strokeStyle = s.color; ctx.lineWidth = 1; const uy = Math.round(y + 15) + 0.5; ctx.beginPath(); ctx.moveTo(s.x, uy); ctx.lineTo(s.x + (s.w ?? 0), uy); ctx.stroke() }
          if (s.strike) { ctx.strokeStyle = s.color; ctx.lineWidth = 1; const my = Math.round(y + 8) + 0.5; ctx.beginPath(); ctx.moveTo(s.x, my); ctx.lineTo(s.x + (s.w ?? ctx.measureText(s.text).width), my); ctx.stroke() }
        }
      }
    }
  }, [])

  const relayout = useCallback(() => {
    const scroller = scrollRef.current, canvas = canvasRef.current
    if (!scroller || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    themeRef.current = readTheme(scroller, laneRef.current)
    const cssW = scroller.clientWidth
    if (cssW < 40) return
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0)
    const lay = layout(ctx, visibleRef.current, cssW, themeRef.current, expandedRef.current, labelRef.current)
    layoutRef.current = lay
    // Same dev-only seam as __canvasTurns: WHERE each turn was laid out, so a harness can
    // click a specific one (a canvas offers nothing to query or target).
    if (import.meta.env.DEV) (window as unknown as { __canvasBounds?: unknown }).__canvasBounds = lay.bounds
    setSpacerH(lay.height)
    paint()
  }, [paint])

  // Opening or closing a thought changes the whole document's height below it.
  useEffect(() => { relayout() }, [expandedThoughts, relayout])

  useEffect(() => {
    labelRef.current = agentLabel
    laneRef.current = laneAccent
    relayout()
  }, [agentLabel, laneAccent, relayout])

  // Mount: own the ResizeObserver; re-layout on container resize.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    relayout()
    const ro = new ResizeObserver(() => relayout())
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [relayout])

  // Re-layout whenever the VISIBLE set changes (new turns, search, saved filter, dismiss).
  useEffect(() => { relayout() }, [visible, relayout])

  // --- the feed ---------------------------------------------------------------------------
  // "Chat messages should go up like a typewriter" — the paper rising as content lands, NOT a
  // character reveal (we get transcript text in chunks; a typed-out reveal would misrepresent
  // when the work happened).
  //
  // Driven from a rAF loop rather than `behavior: 'smooth'` because this is a VIRTUALIZED
  // CANVAS: every scroll event repaints and recomputes the visible slice, so a native smooth
  // scroll multiplies repaints across its whole flight on a schedule we don't control. Here
  // position and paint advance together, once per frame.
  const feedRef = useRef<{ raf: number; target: number } | null>(null)
  const animatingRef = useRef(false)

  const cancelFeed = useCallback(() => {
    if (feedRef.current) cancelAnimationFrame(feedRef.current.raf)
    feedRef.current = null
    animatingRef.current = false
  }, [])

  /** Scroll `el` to `target`, animated when that reads as paper moving and snapped when it
   *  doesn't. Returns nothing; callers don't wait on it. */
  const feedTo = useCallback((el: HTMLDivElement, target: number, opts?: { animate?: boolean }) => {
    cancelFeed()
    const from = el.scrollTop
    const delta = target - from
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // Only small deltas animate. A session switch, a history load or first paint drops
    // thousands of pixels, and sliding through content nobody asked to see is worse than a
    // jump. Above roughly a viewport, snap.
    const tooFar = Math.abs(delta) > el.clientHeight
    if (opts?.animate === false || reduced || tooFar || Math.abs(delta) < 2) {
      el.scrollTop = target
      paint()
      return
    }
    animatingRef.current = true
    // ~260ms, ease-out. Deliberately NOT the busy idiom's timing: this is view movement, not
    // a state signal — it should read as paper moving, not as something working.
    const DUR = 260
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DUR)
      const eased = 1 - Math.pow(1 - t, 3)
      // Re-read the target each frame: content can land mid-flight, and the bottom moves.
      const dest = feedRef.current?.target ?? target
      el.scrollTop = from + (dest - from) * eased
      paint()
      if (t < 1) {
        feedRef.current = { raf: requestAnimationFrame(step), target: dest }
      } else {
        feedRef.current = null
        animatingRef.current = false
        // Settle: recompute stick from where we actually landed (see onScroll).
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        setAtEdge(stickRef.current)
      }
    }
    feedRef.current = { raf: requestAnimationFrame(step), target }
  }, [cancelFeed, paint])

  useEffect(() => cancelFeed, [cancelFeed])

  // Both feed refs are per-COMPONENT, and this component is not keyed per session — it
  // persists across a switch. So they must be reset by hand, before the layout effect below
  // reads them for the new transcript (declaration order decides that, hence: above it).
  // Without this, `firstPaintRef` only ever protected the first session opened in an app run,
  // and `lastMaxRef` carried the PREVIOUS session's document height into the new one — which
  // rewinds and animates through content the reader has never seen, on a session they just
  // opened. The `tooFar` snap guard hid part of that band by accident; it is sized for one
  // append, not for a whole different transcript.
  useLayoutEffect(() => {
    cancelFeed()
    firstPaintRef.current = true
    lastMaxRef.current = 0
  }, [session?.id, cancelFeed])

  // Stick to bottom once the spacer grows (scrollTop can't exceed the current max until the
  // DOM updates). Suppressed while searching / saved-only so results don't jump to the end.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const prev = lastMaxRef.current
    // Written on EVERY layout, not only while sticking. It means "the height as of the last
    // layout", and the rewind below measures one append against it — so any stretch of NOT
    // sticking (reading back, a search, saved-only) used to freeze it and leave the rewind
    // measured against an arbitrarily old height, sliding through already-read content.
    lastMaxRef.current = max
    if (!stickRef.current || q || savedOnly) return
    // WebKit PINS a scroller that sits at its maximum: append content and scrollTop follows
    // the new bottom by itself, in one jump, before we get a say. So to feed, first put the
    // paper back where it was — the reader's last line stays put — and animate up from
    // there. Without this the whole animation is a no-op in the one case it exists for.
    if (!firstPaintRef.current && prev > 0 && max > prev) {
      el.scrollTop = prev
      feedTo(el, max)
    } else {
      feedTo(el, max, { animate: false })
    }
    firstPaintRef.current = false
  }, [spacerH, q, savedOnly, feedTo])

  const onUserScroll = useCallback(() => {
    // Unconditional, and it releases stick outright. Cancelling alone was not enough: the
    // layout effect re-fires on the next render, sees stick still true, and starts a FRESH
    // feed to the bottom — so the reader gets pulled back one frame after pulling away.
    // Releasing here means the app stops following; onScroll re-engages stick by itself if
    // they end up back at the live edge.
    cancelFeed()
    stickRef.current = false
    setAtEdge(false)
  }, [cancelFeed])

  // A WHEEL THAT CANNOT SCROLL MUST NOT DETACH THE FEED. Releasing stick is safe only because
  // onScroll re-engages it when the reader lands back at the live edge — and that recovery
  // needs a scroll event to actually fire. At the scroll limit none does: a downward flick at
  // the bottom (or any wheel in a transcript shorter than the viewport) scrolls nothing, so
  // stick was released with nothing left to restore it and every later turn pushed the view
  // further behind. Flicking down to "get to the end" is exactly the gesture of someone who
  // wants to FOLLOW output, so at the limit it re-engages instead of detaching.
  const onWheelScroll = useCallback((e: React.WheelEvent) => {
    const el = scrollRef.current
    // No vertical intent (a horizontal/trackpad-sideways gesture) — leave stick alone.
    if (e.deltaY === 0) return
    if (el) {
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      // Rounding: scrollTop is fractional under zoom, so `>= max` alone can miss the edge.
      if (max <= 0 || (e.deltaY > 0 && el.scrollTop >= max - 1)) {
        cancelFeed()
        stickRef.current = true
        setAtEdge(true)
        return
      }
    }
    onUserScroll()
  }, [cancelFeed, onUserScroll])

  // A DRAG, NOT A CLICK. pointerdown fires on every click, and this scroller carries three
  // click affordances (open a link, toggle a thought, focus the panel) — so clicking anything
  // in the transcript silently stopped the app following the conversation and raised
  // jump-to-latest as if the reader had scrolled away. The thought toggle was the worst of
  // them: the click released stick, then its relayout ran with stick already false, so
  // opening a thought at the live edge also skipped the re-feed that absorbs its height.
  // Movement under a held button is the earliest signal that actually means "I am scrolling".
  const dragFromRef = useRef<{ x: number; y: number } | null>(null)
  const onPointerDownScroll = useCallback((e: React.PointerEvent) => {
    dragFromRef.current = { x: e.clientX, y: e.clientY }
  }, [])
  const onPointerMoveScroll = useCallback((e: React.PointerEvent) => {
    const from = dragFromRef.current
    if (!from) return
    if (e.buttons === 0) { dragFromRef.current = null; return }
    // 3px of slop: a click with a shaky hand is still a click.
    if (Math.abs(e.clientX - from.x) < 3 && Math.abs(e.clientY - from.y) < 3) return
    dragFromRef.current = null
    onUserScroll()
  }, [onUserScroll])
  const onPointerUpScroll = useCallback(() => { dragFromRef.current = null }, [])

  const clearHover = useCallback(() => { if (hoverKeyRef.current) { hoverKeyRef.current = null; setHover(null) } }, [])

  const onScroll = () => {
    const el = scrollRef.current
    // While OUR animation is in flight, leave stick alone. A smooth scroll fires a stream of
    // scroll events, and mid-flight the distance to the bottom still exceeds the 80px
    // threshold — so recomputing here would switch stick off partway through its own
    // animation and stall the feed. It is recomputed on settle instead.
    if (el && !animatingRef.current) {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      setAtEdge(stickRef.current)
    }
    clearHover() // a hover toolbar's y goes stale after scroll — re-hover to show it again
    paint()
  }

  // Hit-test the pointer (content coords) against link segments → the href under it, or null.
  const linkAtXY = (px: number, py: number): string | null => {
    for (const op of layoutRef.current.ops) {
      if (op.kind !== 'segs' || py < op.top || py > op.bottom) continue
      for (const s of op.segs) if (s.href && px >= s.x && px <= s.x + (s.w ?? 0)) return s.href
    }
    return null
  }

  // Pointer move: link cursor + track which turn we're over (for the hover action toolbar).
  const onMove = (e: { clientX: number; clientY: number }) => {
    const el = scrollRef.current; if (!el) return
    const rect = el.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top + el.scrollTop
    el.style.cursor = linkAtXY(px, py) ? 'pointer' : 'default'
    const b = layoutRef.current.bounds.find((tb) => py >= tb.top && py <= tb.bottom)
    const key = b ? b.key : null
    if (key !== hoverKeyRef.current) {
      hoverKeyRef.current = key
      setHover(b ? { key: b.key, kind: b.kind, y: b.top - el.scrollTop } : null)
    }
  }

  const copyKey = (key: string) => {
    const b = layoutRef.current.bounds.find((x) => x.key === key)
    if (b) { navigator.clipboard?.writeText(b.text).catch(() => {}); flashMsg('Copied') }
  }
  const toggleSaved = (key: string) =>
    setSaved((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); persistSet(SAVED_KEY, n); return n })
  const dismiss = (key: string) => {
    setDismissed((p) => { const n = new Set(p); n.add(key); persistSet(DISMISSED_KEY, n); return n })
    clearHover()
  }

  const hoverSaved = hover ? saved.has(hover.key) : false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      {/* Search + saved-only filter (mirrors the DOM ConversationPanel header). */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        height: 30, padding: '0 12px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-body)',
      }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the conversation…"
          style={{ flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: 11.5, background: 'transparent', color: 'var(--fg)', outline: 'none', border: 'none', padding: '2px 0' }}
        />
        {search && (
          <button onClick={() => setSearch('')} title="Clear search"
            style={{ fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', outline: 'none', border: 'none', background: 'transparent', color: 'var(--fg-muted)', padding: '0 4px' }}>✕</button>
        )}
        <button
          onClick={() => setSavedOnly((v) => !v)}
          title={savedOnly ? 'Show all answers' : 'Show saved only'}
          style={{
            flexShrink: 0, fontSize: 10, fontFamily: 'inherit', cursor: 'pointer', outline: 'none',
            padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)',
            color: savedOnly ? 'var(--accent)' : 'var(--fg-muted)', background: 'transparent',
          }}>★ {saved.size}</button>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }} onMouseLeave={clearHover}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onClick={(e) => {
            const el = scrollRef.current; if (!el) return
            const rect = el.getBoundingClientRect()
            const py = e.clientY - rect.top + el.scrollTop
            const href = linkAtXY(e.clientX - rect.left, py)
            if (href) { window.operator.openExternal?.(href); return }
            // A click anywhere on a collapsed thought opens it (and closes it again) — the
            // whole row is the affordance, since a 9px chevron on a canvas is not a target.
            const b = layoutRef.current.bounds.find((tb) => py >= tb.top && py <= tb.bottom)
            if (b?.kind === 'thinking') {
              setExpandedThoughts((prev) => {
                const next = new Set(prev)
                if (next.has(b.key)) next.delete(b.key)
                else next.add(b.key)
                return next
              })
            }
          }}
          onMouseMove={onMove}
          onDoubleClick={(e) => {
            const el = scrollRef.current; if (!el) return
            const py = e.clientY - el.getBoundingClientRect().top + el.scrollTop
            const b = layoutRef.current.bounds.find((tb) => py >= tb.top && py <= tb.bottom)
            if (b) { navigator.clipboard?.writeText(b.text).catch(() => {}); flashMsg('Copied message') }
          }}
          // NEVER fight the pointer. A wheel or a drag cancels our scroll outright and leaves
          // stick wherever the user's own position puts it — the feed is a convenience, and
          // it loses every argument with a real input. But only for input that MEANS scroll:
          // see onWheelScroll (a wheel with nowhere to go) and onPointerMoveScroll (a click
          // is not a drag) — over-eager cancellation is its own bug, and was two of them.
          onWheel={onWheelScroll}
          onTouchStart={onUserScroll}
          onPointerDown={onPointerDownScroll}
          onPointerMove={onPointerMoveScroll}
          onPointerUp={onPointerUpScroll}
          onPointerCancel={onPointerUpScroll}
          className="scroll-hidden"
          style={{ position: 'absolute', inset: 0, overflow: 'auto' }}
        >
          <div style={{ height: spacerH, width: '100%' }} />
        </div>
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: 'block', pointerEvents: 'none' }} />

        {visible.length === 0 && (
          <div style={{ position: 'absolute', top: 14, left: 18, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--fg-muted)', }}>
            {q ? `No matches for “${search.trim()}”.` : savedOnly ? 'No saved answers yet — star one to keep it here.' : 'The agent’s answers will appear here as it responds.'}
          </div>
        )}

        {/* Hover action toolbar over the turn under the pointer. Copy for any turn; star +
            dismiss for agent answers only. Positioned at the turn's top-right in viewport y. */}
        {hover && (
          <div
            onMouseEnter={() => { /* keep visible while interacting */ }}
            style={{
              position: 'absolute', top: Math.max(4, hover.y + 2), right: 14,
              display: 'flex', gap: 2, padding: 2, borderRadius: 7,
              background: 'var(--overlay-medium)', border: '1px solid var(--border)', backdropFilter: 'blur(2px)',
            }}
          >
            <button onClick={() => copyKey(hover.key)} title="Copy" style={hoverBtn}>⧉</button>
            {hover.kind === 'text' && (
              <button onClick={() => toggleSaved(hover.key)} title={hoverSaved ? 'Unsave' : 'Save'}
                style={{ ...hoverBtn, color: hoverSaved ? 'var(--accent)' : 'var(--fg-muted)' }}>{hoverSaved ? '★' : '☆'}</button>
            )}
            {hover.kind === 'text' && (
              <button onClick={() => dismiss(hover.key)} title="Dismiss" style={hoverBtn}>✕</button>
            )}
          </div>
        )}

        {/* Jump-to-latest — and the running indicator, which is the same control: what you
            are returning TO is the reason to return. Only shown once you've scrolled off the
            live edge; while busy it carries the activity + its clock. */}
        {!atEdge && (
          <button
            data-jump-latest
            onClick={() => {
              const el = scrollRef.current
              if (!el) return
              stickRef.current = true
              setAtEdge(true)
              // Same mechanism as the feed, so returning to the live edge reads as the same
              // motion — and the same guard, so a jump from far up the document snaps.
              feedTo(el, Math.max(0, el.scrollHeight - el.clientHeight))
            }}
            title="Jump to the latest message"
            style={{
              position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
              display: 'inline-flex', alignItems: 'center', gap: 7, maxWidth: '80%',
              padding: '5px 11px', borderRadius: 999, cursor: 'pointer', outline: 'none',
              border: '1px solid var(--border)', background: 'var(--overlay-medium)',
              backdropFilter: 'blur(3px)', fontFamily: 'var(--font-body)', fontSize: 11,
              color: 'var(--fg)', boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
            }}
          >
            {signal && <StatusWave status={signal.kind === 'ended' ? 'ended' : signal.kind} seed={session?.id ?? 'chat'} size={12} accent={laneAccent} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {signal ? signal.label : 'Latest'}
            </span>
            {signal?.animate && elapsedMs >= 1000 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>{fmtDur(elapsedMs)}</span>
            )}
            <span style={{ color: 'var(--fg-muted)' }}>↓</span>
          </button>
        )}

        {flash && (
          <div style={{
            position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
            fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--fg)',
            background: 'var(--overlay-medium)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '3px 10px', pointerEvents: 'none',
          }}>
            {flash}
          </div>
        )}
      </div>
      {/* Status line — at the foot of the reading surface, where the eye already is while
          waiting. Absent entirely when a live session is idle: no row, no space, because
          "nothing is happening" is the one state that needs no words. Motion comes from the
          app's ONE motion idiom (StatusWave), so running/compacting shimmer and waiting rests
          static — never a second animation vocabulary. */}
      {signal && (
        <div
          data-chat-status={signal.kind}
          style={{
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
            // Same measure and centre line as the transcript column above it.
            width: '100%', maxWidth: MEASURE_FORM, margin: '0 auto', boxSizing: 'border-box',
            padding: '5px 4px 0', fontFamily: 'var(--font-body)', fontSize: 11,
            color: 'var(--fg-muted)',
          }}
        >
          <StatusWave status={signal.kind === 'ended' ? 'ended' : signal.kind} seed={session?.id ?? 'chat'} size={13} accent={laneAccent} />
          {/* --fg, not --fg-muted: this IS the line's content ("Editing", "Your turn"), and
              muted 11px measured 4.16:1 on Mr Pink light / 4.30:1 on 1984 light — under the
              body floor. The muted ink belongs to the clock beside it. */}
          <span data-chat-status-label style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {signal.label}
          </span>
          {signal.animate && elapsedMs >= 1000 && (
            <span data-chat-status-elapsed style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
              {fmtDur(elapsedMs)}
            </span>
          )}
          {/* §2: the status line is now purely informational — what it's doing and for how
              long. Its STOP moved into the composer's orb, because two stop controls on
              screen at once is one too many. */}
        </div>
      )}
      <ChatComposer session={session} laneAccent={laneAccent} onSend={() => { stickRef.current = true }} onModelChange={onModelChange} onEffortChange={onEffortChange} />
    </div>
  )
}

const hoverBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22,
  padding: 0, fontSize: 12, cursor: 'pointer', outline: 'none', border: 'none',
  background: 'transparent', color: 'var(--fg-muted)', borderRadius: 5,
}
