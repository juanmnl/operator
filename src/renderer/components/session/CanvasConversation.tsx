import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, NarrationEntry } from '../../../shared/types'
import { parseBlocks, type Block, type Span } from '../../lib/canvas-md'
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
  border: string; codeBg: string; fontBody: string; fontMono: string
}
function readTheme(el: HTMLElement): Theme {
  const s = getComputedStyle(el)
  const v = (n: string, f: string) => s.getPropertyValue(n).trim() || f
  return {
    fg: v('--fg', '#eef1f3'),
    fgMuted: v('--fg-muted', '#8a8f98'),
    accent: v('--accent', '#7ee787'),
    border: v('--border', '#2a2a35'),
    codeBg: 'rgba(127,127,127,0.13)',
    fontBody: v('--font-body', 'Archivo, system-ui, sans-serif'),
    fontMono: v('--font-mono', 'JetBrains Mono, ui-monospace, monospace'),
  }
}

// ---- layout model --------------------------------------------------------------------
const MARGIN = 18, TURN_GAP = 22, BLOCK_GAP = 7, HEADER_H = 22
const PROSE = 13.5, PROSE_LH = 21, CODE = 12, CODE_LH = 18

type Seg = { text: string; x: number; font: string; color: string; code?: boolean; href?: string; w?: number }
type Op =
  | { kind: 'header'; x: number; y: number; role: 'user' | 'agent'; label: string; time: string; top: number; bottom: number }
  | { kind: 'codebg'; x: number; y: number; w: number; h: number; top: number; bottom: number }
  | { kind: 'rule'; x: number; y: number; w: number; top: number; bottom: number }
  | { kind: 'vbar'; x: number; y: number; h: number; top: number; bottom: number }
  | { kind: 'segs'; y: number; h: number; segs: Seg[]; top: number; bottom: number }
type TurnBound = { top: number; bottom: number; text: string }
interface Layout { ops: Op[]; height: number; bounds: TurnBound[] }

function fontFor(sp: Span, size: number, t: Theme): string {
  if (sp.code) return `${size - 1}px ${t.fontMono}`
  const style = sp.italic ? 'italic ' : ''
  const weight = sp.bold ? '600 ' : ''
  return `${style}${weight}${size}px ${t.fontBody}`
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
      cur.push({ text: word, x, font, color, code: sp.code, href: sp.href, w })
      x += w
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

// Emit an agent answer's blocks as positioned ops at column [x, x+width], returning the
// next Y. Prose is full-width (no bubble) — role is conveyed by the header marker above.
function emitBlocks(ctx: CanvasRenderingContext2D, ops: Op[], blocks: Block[], x: number, startY: number, width: number, t: Theme): number {
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
      const codeLines = flowCode(ctx, blk.text, width - 20, CODE, t)
      const boxH = codeLines.length * CODE_LH + 14
      ops.push({ kind: 'codebg', x, y, w: width, h: boxH, top: y, bottom: y + boxH })
      let cy = y + 7
      for (const cl of codeLines) {
        ops.push({ kind: 'segs', y: cy, h: CODE_LH, segs: [{ text: cl, x: x + 10, font: `${CODE}px ${t.fontMono}`, color: t.fg }], top: cy, bottom: cy + CODE_LH }); cy += CODE_LH
      }
      y += boxH
    } else if (blk.type === 'heading') {
      const size = blk.level <= 1 ? 18 : blk.level === 2 ? 16 : blk.level === 3 ? 14.5 : 13.5
      const lh = Math.round(size * 1.5)
      const { lines } = flowSpans(ctx, blk.spans.map((s) => ({ ...s, bold: true })), width, size, t.fg, t)
      pushLines(lines, lh, 0)
    } else if (blk.type === 'list') {
      const prefix = blk.ordered ? `${blk.index}.` : '•'
      const indent = 16 * blk.depth
      ctx.font = `${PROSE}px ${t.fontBody}`
      const pw = ctx.measureText(prefix + '  ').width
      const { lines } = flowSpans(ctx, blk.spans, width - indent - pw, PROSE, t.fg, t)
      pushLines(lines, PROSE_LH, indent + pw, { text: prefix, x: x + indent, font: `${PROSE}px ${t.fontBody}`, color: t.fgMuted })
    } else if (blk.type === 'quote') {
      const { lines } = flowSpans(ctx, blk.spans, width - 14, PROSE, t.fgMuted, t)
      ops.push({ kind: 'vbar', x, y, h: lines.length * PROSE_LH, top: y, bottom: y + lines.length * PROSE_LH })
      pushLines(lines, PROSE_LH, 14)
    } else {
      const { lines } = flowSpans(ctx, blk.spans, width, PROSE, t.fg, t)
      pushLines(lines, PROSE_LH, 0)
    }
  })
  return y
}

function layout(ctx: CanvasRenderingContext2D, turns: NarrationEntry[], cssW: number, t: Theme): Layout {
  const ops: Op[] = []
  const bounds: TurnBound[] = []
  const contentL = MARGIN, contentW = Math.max(120, cssW - MARGIN * 2)
  let y = 16

  for (const m of turns) {
    const role: 'user' | 'agent' = m.kind === 'user' ? 'user' : 'agent'
    const turnTop = y
    const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    ops.push({ kind: 'header', x: contentL, y, role, label: role === 'user' ? 'You' : 'Agent', time, top: y, bottom: y + HEADER_H })
    y += HEADER_H

    if (role === 'user') {
      for (const rawline of m.text.split('\n')) {
        if (rawline.trim() === '') { y += Math.round(PROSE_LH * 0.5); continue }
        const { lines } = flowSpans(ctx, [{ text: rawline }], contentW, PROSE, t.fg, t)
        for (const segs of lines) {
          ops.push({ kind: 'segs', y, h: PROSE_LH, segs: segs.map((s) => ({ ...s, x: contentL + s.x })), top: y, bottom: y + PROSE_LH }); y += PROSE_LH
        }
      }
    } else {
      y = emitBlocks(ctx, ops, cachedBlocks(m.text), contentL, y, contentW, t)
    }

    bounds.push({ top: turnTop, bottom: y, text: m.text })
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

export function CanvasConversation({ session }: { session?: AgentSession }) {
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
      if (m.kind !== 'user' && m.kind !== 'text') continue
      const k = `${m.timestamp}|${m.text.length}|${m.text.slice(0, 40)}`
      if (!byKey.has(k)) { byKey.set(k, m); order.push(k) }
    }
    return order.map((k) => byKey.get(k)!)
  }, [history, session?.messages])

  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layoutRef = useRef<Layout>({ ops: [], height: 0, bounds: [] })
  const themeRef = useRef<Theme | null>(null)
  const [spacerH, setSpacerH] = useState(0)
  const stickRef = useRef(true)
  const [flash, setFlash] = useState<string | null>(null)

  const paint = () => {
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
        const c = op.role === 'user' ? t.accent : t.fgMuted
        ctx.beginPath(); ctx.arc(op.x + 3, y + 7, 3, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill()
        const hadLS = 'letterSpacing' in ctx
        if (hadLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0.1em'
        ctx.font = `600 10px ${t.fontMono}`; ctx.fillStyle = c
        ctx.fillText(op.label.toUpperCase(), op.x + 12, y + 2)
        const lw = ctx.measureText(op.label.toUpperCase()).width
        if (hadLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px'
        ctx.font = `10px ${t.fontBody}`; ctx.fillStyle = t.fgMuted
        ctx.globalAlpha = 0.7; ctx.fillText(op.time, op.x + 12 + lw + 10, y + 2); ctx.globalAlpha = 1
      } else if (op.kind === 'codebg') {
        roundRect(ctx, op.x, y, op.w, op.h, 7); ctx.fillStyle = t.codeBg; ctx.fill()
      } else if (op.kind === 'rule') {
        const ry = Math.round(y) + 0.5
        ctx.strokeStyle = t.border; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(op.x, ry); ctx.lineTo(op.x + op.w, ry); ctx.stroke()
      } else if (op.kind === 'vbar') {
        ctx.fillStyle = t.border; ctx.fillRect(op.x, y, 2, op.h)
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
        }
      }
    }
  }

  useEffect(() => {
    const scroller = scrollRef.current, canvas = canvasRef.current
    if (!scroller || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const relayout = () => {
      themeRef.current = readTheme(scroller)
      const cssW = scroller.clientWidth
      if (cssW < 40) return
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0)
      const lay = layout(ctx, turns, cssW, themeRef.current)
      layoutRef.current = lay
      setSpacerH(lay.height)
      paint()
    }
    relayout()
    const ro = new ResizeObserver(() => relayout())
    ro.observe(scroller)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns])

  // Stick to bottom once the spacer has grown to the new height (scrollTop can't exceed the
  // current max until the DOM updates), then repaint at the settled offset.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) { el.scrollTop = el.scrollHeight; paint() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spacerH])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    paint()
  }

  // Hit-test the pointer against link segments (content coords = client + scrollTop).
  const linkAt = (clientX: number, clientY: number): string | null => {
    const el = scrollRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const px = clientX - rect.left, py = clientY - rect.top + el.scrollTop
    for (const op of layoutRef.current.ops) {
      if (op.kind !== 'segs' || py < op.top || py > op.bottom) continue
      for (const s of op.segs) if (s.href && px >= s.x && px <= s.x + (s.w ?? 0)) return s.href
    }
    return null
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: 'var(--bg-terminal)' }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onClick={(e) => { const href = linkAt(e.clientX, e.clientY); if (href) window.operator.openExternal?.(href) }}
          onMouseMove={(e) => { const el = scrollRef.current; if (el) el.style.cursor = linkAt(e.clientX, e.clientY) ? 'pointer' : 'default' }}
          onDoubleClick={(e) => {
            const el = scrollRef.current; if (!el) return
            const py = e.clientY - el.getBoundingClientRect().top + el.scrollTop
            const b = layoutRef.current.bounds.find((tb) => py >= tb.top && py <= tb.bottom)
            if (b) { navigator.clipboard?.writeText(b.text).catch(() => {}); setFlash('Copied message'); setTimeout(() => setFlash(null), 1100) }
          }}
          className="scroll-hidden"
          style={{ position: 'absolute', inset: 0, overflow: 'auto' }}
        >
          <div style={{ height: spacerH, width: '100%' }} />
        </div>
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: 'block', pointerEvents: 'none' }} />
        {turns.length === 0 && (
          <div style={{ position: 'absolute', top: 14, left: 18, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--fg-muted)', opacity: 0.7 }}>
            The agent’s answers will appear here as it responds.
          </div>
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
      <ChatComposer session={session} onSend={() => { stickRef.current = true }} />
    </div>
  )
}
